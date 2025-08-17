const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const express = require('express');
const qrcode = require('qrcode-terminal');
const { v4: uuidv4 } = require('uuid');
const P = require('pino');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CHANNEL_NAME = "RED DRAGON";
const CHANNEL_JID = "120363043584356281@g.us";
const OWNER_NUMBER = "923237533251";
const OWNER_URL = `https://wa.me/${OWNER_NUMBER}`;

// Store active pairing codes
const activeCodes = new Map();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Generate pairing code
function generatePairCode() {
    const randomChars = uuidv4().substr(0, 4).toUpperCase();
    const code = `PARI-${randomChars}`;
    const expiresAt = Date.now() + 5 * 60 * 1000;
    
    activeCodes.set(code, {
        expiresAt,
        qr: null,
        socket: null,
        phone: null
    });
    
    setTimeout(() => {
        if (activeCodes.has(code)) activeCodes.delete(code);
    }, 5 * 60 * 1000);
    
    return code;
}

// Web interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/generate-code', (req, res) => {
    const phoneNumber = req.body.phone;
    if (!phoneNumber || !phoneNumber.match(/^\d{10,15}$/)) {
        return res.status(400).json({ error: "Invalid phone number" });
    }

    const code = generatePairCode();
    res.json({ code, phoneNumber });
});

// Start server
app.listen(PORT, () => {
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
        logger: P({ level: 'silent' })
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr, lastDisconnect } = update;
        
        if (qr) {
            activeCodes.forEach((value, code) => {
                if (!value.qr) {
                    value.qr = qr;
                    value.socket = sock;
                    qrcode.generate(qr, { small: true });
                }
            });
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startWhatsAppBot();
        } else if (connection === 'open') {
            console.log('WhatsApp connected!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        
        const from = msg.key.remoteJid;
        const messageText = msg.message.conversation || 
                          (msg.message.extendedTextMessage?.text || '');

        // Pairing code verification
        if (messageText.includes('PARI-') && messageText.length === 9) {
            const code = messageText.trim();
            if (activeCodes.has(code)) {
                activeCodes.get(code).phone = from;
                await sock.sendMessage(from, { 
                    text: `✅ Pairing successful! You're now connected to the bot.`
                });
            }
        }

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
                    text: `👑 Owner Contact:\n${OWNER_URL}`,
                    detectLinks: true
                });
            }
            else if (command === '.menu' || command === '.help') {
                const menu = `
╭───────[ *BOT COMMANDS* ]───────╮
│                                 │
│  .ping   ➤ Check bot speed      │
│  .owner  ➤ Show owner contact   │
│  .menu   ➤ Show this menu       │
│  .alive  ➤ Check bot status     │
│  .vv     ➤ Reveal ViewOnce media│
│                                 │
╰─────────────────────────────────╯
                `;
                await sock.sendMessage(from, { text: menu.trim() });
            }
            else if (command === '.alive') {
                const uptime = process.uptime();
                const h = Math.floor(uptime / 3600);
                const m = Math.floor((uptime % 3600) / 60);
                const s = Math.floor(uptime % 60);
                const runtime = `${h}h ${m}m ${s}s`;
                
                await sock.sendMessage(from, {
                    text: `✅ Bot is alive!\n⏰ Uptime: ${runtime}\n📅 ${new Date().toLocaleString()}`
                });
            }
            else if (command === '.vv') {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                let mediaMessage;

                if (quoted?.viewOnceMessage?.message) {
                    mediaMessage = { message: quoted.viewOnceMessage.message };
                }

                if (mediaMessage) {
                    try {
                        const buffer = await downloadMediaMessage(mediaMessage, "buffer", {}, { logger: P({ level: "silent" }) });
                        const isVideo = !!mediaMessage.message.videoMessage;

                        await sock.sendMessage(from, {
                            [isVideo ? "video" : "image"]: buffer,
                            caption: "*ViewOnce revealed by bot*"
                        });
                    } catch (err) {
                        console.error(err);
                        await sock.sendMessage(from, {
                            text: "❌ Failed to fetch media"
                        });
                    }
                } else {
                    await sock.sendMessage(from, {
                        text: "❗ Reply to a ViewOnce message"
                    });
                }
            }
        }

        // Message forwarding
        if (!messageText.startsWith('.') && !messageText.includes('PARI-') && from !== CHANNEL_JID) {
            try {
                await sock.sendMessage(CHANNEL_JID, {
                    text: `> Forwarded\n${CHANNEL_NAME}\n\n${messageText}`,
                    contextInfo: {
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: from,
                            serverMessageId: msg.key.id
                        }
                    }
                });
            } catch (error) {
                console.error('Forward error:', error);
            }
        }
    });
}