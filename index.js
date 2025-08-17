const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}

// Serve static files
app.use(express.static(publicDir));

// Web interface
app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startWhatsAppBot();
});

// WhatsApp Bot
async function startWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state,
        logger: { level: 'silent' }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('QR Code generated - scan with WhatsApp');
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Reconnecting...');
                startWhatsAppBot();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Request pairing code if not registered
    if (!state.creds.registered) {
        const phoneNumber = "923237533251"; // Your bot's number
        const pairingCode = await sock.requestPairingCode(phoneNumber);
        console.log(`Pairing code: ${pairingCode}`);
        
        // Generate WhatsApp link
        const whatsappLink = `https://wa.me/${phoneNumber}?text=Pair%20Code:%20${pairingCode}`;
        console.log(`Link to pair: ${whatsappLink}`);
    }

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        
        const from = msg.key.remoteJid;
        const messageText = msg.message.conversation || 
                         (msg.message.extendedTextMessage?.text || '');

        // Command handler
        if (messageText.startsWith('.')) {
            const command = messageText.toLowerCase().trim();
            
            if (command === '.ping') {
                const start = Date.now();
                await sock.sendMessage(from, { text: 'Pong!' });
                const latency = Date.now() - start;
                await sock.sendMessage(from, { 
                    text: `🏓 Bot Speed: ${latency}ms`
                });
            }
            else if (command === '.owner') {
                await sock.sendMessage(from, {
                    text: `👑 Owner Contact:\nhttps://wa.me/923237533251`,
                    detectLinks: true
                });
            }
        }
    });
}

process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});