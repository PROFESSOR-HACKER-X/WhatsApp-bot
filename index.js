const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const BOT_NUMBER = "923237533251"; // Replace with your bot's number

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

// Store active pairing codes
const activePairingCodes = new Map();

// Web interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoint to generate pairing code
app.post('/generate-code', async (req, res) => {
    try {
        const phoneNumber = req.body.phone;
        if (!phoneNumber || !phoneNumber.match(/^\+?\d{10,15}$/)) {
            return res.status(400).json({ error: "Invalid phone number format. Please include country code." });
        }

        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: { level: 'warn' }
        });

        // Generate pairing code
        const pairingCode = await sock.requestPairingCode(phoneNumber.replace('+', ''));
        
        // Store the code with expiration (5 minutes)
        activePairingCodes.set(pairingCode, {
            phone: phoneNumber,
            expiresAt: Date.now() + 300000,
            socket: sock
        });

        // Setup cleanup
        setTimeout(() => {
            if (activePairingCodes.has(pairingCode)) {
                activePairingCodes.delete(pairingCode);
            }
        }, 300000);

        res.json({ 
            code: pairingCode,
            whatsappLink: `https://wa.me/${phoneNumber.replace('+', '')}?text=Pair%20Code:%20${pairingCode}`
        });

    } catch (error) {
        console.error('Error generating pairing code:', error);
        if (error instanceof Boom && error.output.statusCode === 401) {
            return res.status(401).json({ error: "Bot is not authenticated. Please scan QR code first." });
        }
        res.status(500).json({ error: "Failed to generate pairing code. Please try again." });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// WhatsApp Bot Connection
async function connectWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: { level: 'warn' }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('QR Code generated, scan with your phone');
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log('Reconnecting...');
                    setTimeout(connectWhatsApp, 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp connected successfully!');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message) return;
            
            const from = msg.key.remoteJid;
            if (!from.endsWith('@s.whatsapp.net')) return;
            
            const messageText = msg.message.conversation || 
                             (msg.message.extendedTextMessage?.text || '');

            // Check for pairing code
            if (messageText.startsWith('Pair Code: ') && messageText.length > 11) {
                const code = messageText.substring(11).trim();
                if (activePairingCodes.has(code)) {
                    await sock.sendMessage(from, { text: '✅ Pairing successful! You can now use the bot.' });
                    activePairingCodes.delete(code);
                } else {
                    await sock.sendMessage(from, { text: '❌ Invalid pairing code or code expired. Please generate a new one.' });
                }
                return;
            }

            // Command handler
            if (messageText.startsWith('.')) {
                const command = messageText.toLowerCase().trim();
                
                if (command === '.ping') {
                    const start = Date.now();
                    const pongMsg = await sock.sendMessage(from, { text: 'Pong!' });
                    const latency = Date.now() - start;
                    await sock.sendMessage(from, { 
                        text: `🏓 Bot Speed: ${latency}ms`
                    });
                }
                else if (command === '.owner') {
                    await sock.sendMessage(from, {
                        text: `👑 Owner Contact:\nhttps://wa.me/${BOT_NUMBER}`,
                        detectLinks: true
                    });
                }
                else if (command === '.help') {
                    await sock.sendMessage(from, {
                        text: `🤖 *Bot Commands*:\n\n.ping - Check bot response time\n.owner - Get owner contact\n.help - Show this help menu`,
                        detectLinks: true
                    });
                }
            }
        });

    } catch (error) {
        console.error('WhatsApp connection error:', error);
        setTimeout(connectWhatsApp, 10000); // Retry after 10 seconds
    }
}

// Start WhatsApp connection
connectWhatsApp();

// Error handling
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});