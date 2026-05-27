const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// Anti-ban delay helper function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startBot() {
    // 1. Session Persistence: Save credentials in 'auth_session' folder
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    // 2. Performance: Initialize Baileys socket with silent logger to avoid RAM bloat
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false // Handled manually below using qrcode-terminal
    });

    // Connection lifecycle monitoring
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP TO SIGN IN ---');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed due to: ${lastDisconnect?.error || 'unknown error'}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('\nWhatsApp Bot successfully connected and ready to process messages!');
        }
    });

    // Session save callback
    sock.ev.on('creds.update', saveCreds);

    // 3. Message handling logic
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // Ignore messages sent by the bot itself
            if (msg.key.fromMe) continue;

            // Extract message body text
            const text = (msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          '').trim().toLowerCase();

            if (text === 'hi' || text === 'hello') {
                const jid = msg.key.remoteJid;
                
                // 4. Anti-Ban Safety: Wait 1 to 3 seconds before replying to appear human
                const delayMs = Math.floor(Math.random() * 2000) + 1000;
                console.log(`Received message: "${text}" from ${jid}. Replying in ${delayMs}ms...`);
                
                await delay(delayMs);

                try {
                    await sock.sendMessage(jid, { text: 'Hello! How can I help you today?' });
                    console.log(`Response sent successfully to ${jid}`);
                } catch (err) {
                    console.error('Failed to send message:', err);
                }
            }
        }
    });
}

// Start the bot
startBot().catch((err) => {
    console.error('Fatal error starting the bot:', err);
});
