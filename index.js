const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

// Anti-ban delay helper function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Setup Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Serve static assets from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Global state variables
let sock = null;
let currentStatus = 'disconnected';
let currentQr = null;

// Config file path for persistent settings
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
    isBotActive: true,
    stats: {
        received: 0,
        replied: 0
    }
};

// Load config from disk if it exists
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
            config = JSON.parse(data);
        } else {
            saveConfig();
        }
    } catch (err) {
        console.error('Failed to load configuration:', err);
    }
}

// Save config to disk
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (err) {
        console.error('Failed to save configuration:', err);
    }
}

// Unified logging function to stream logs to terminal and web console
function logToDashboard(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    
    // Prefix for terminal output
    let terminalPrefix = '[SYS]';
    if (type === 'incoming') terminalPrefix = '[📥 IN]';
    else if (type === 'outgoing') terminalPrefix = '[📤 OUT]';
    else if (type === 'error') terminalPrefix = '[❌ ERR]';
    else if (type === 'system') terminalPrefix = '[⚙️ SYS]';
    
    console.log(`[${time}] ${terminalPrefix} ${message}`);
    
    // Broadcast log entry to UI clients
    io.emit('log_update', { message, type });
}

// Reset WhatsApp session
async function resetSession() {
    logToDashboard('Initiating session reset and logout...', 'system');
    
    // 1. Remove listeners and close socket
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(new Error('Manual logout and reset triggered.'));
        } catch (err) {
            console.error('Error closing socket connection:', err);
        }
        sock = null;
    }
    
    currentStatus = 'disconnected';
    currentQr = null;
    io.emit('status_update', { status: currentStatus, qr: null });
    
    // 2. Remove session credentials folder
    const authFolder = path.join(__dirname, 'auth_session');
    try {
        if (fs.existsSync(authFolder)) {
            // Delete folder contents recursively
            fs.rmSync(authFolder, { recursive: true, force: true });
            logToDashboard('Authentication session deleted successfully.', 'system');
        }
    } catch (err) {
        logToDashboard(`Failed to delete credentials folder: ${err.message}`, 'error');
    }
    
    // 3. Restart the bot connection sequence
    setTimeout(() => {
        connectToWhatsApp();
    }, 1500);
}

// Connect to WhatsApp using Baileys
async function connectToWhatsApp() {
    logToDashboard('Initializing WhatsApp connection...', 'system');
    
    // Fetch latest WhatsApp web version to prevent connection failure
    let version = [2, 3000, 1015901307]; // Fallback version
    try {
        const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
        version = latestVersion;
        logToDashboard(`Fetched WhatsApp Web version v${version.join('.')}, isLatest: ${isLatest}`, 'system');
    } catch (err) {
        logToDashboard(`Failed to fetch latest WhatsApp version, using fallback: ${err.message}`, 'system');
    }

    // 1. Session Persistence
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    // 2. Initialize Baileys socket
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Windows', 'Chrome', '110.0.0.0']
    });
    
    currentStatus = 'connecting';
    io.emit('status_update', { status: currentStatus, qr: null });

    // Connection Lifecycle Monitoring
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentStatus = 'scanning_qr';
            try {
                // Convert raw QR string to Base64 image data URL
                const qrDataUrl = await QRCode.toDataURL(qr);
                currentQr = qrDataUrl;
                
                // Update UI clients
                io.emit('status_update', { status: currentStatus, qr: currentQr });
                logToDashboard('New QR Code generated. Please scan it with WhatsApp.', 'info');
                
                // Render in terminal as fallback
                qrcodeTerminal.generate(qr, { small: true });
            } catch (err) {
                logToDashboard(`Failed to render QR Code: ${err.message}`, 'error');
            }
        }
        
        if (connection === 'close') {
            currentQr = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            logToDashboard(`Connection closed: ${lastDisconnect?.error?.message || 'unknown'}. Reconnecting: ${shouldReconnect}`, 'error');
            currentStatus = 'disconnected';
            io.emit('status_update', { status: currentStatus, qr: null });
            
            if (shouldReconnect) {
                setTimeout(() => {
                    // Prevent duplicate execution if reset was called in between
                    if (currentStatus === 'disconnected') {
                        connectToWhatsApp();
                    }
                }, 3000);
            } else {
                logToDashboard('Logged out from WhatsApp session. Scan QR code to start again.', 'error');
            }
        } else if (connection === 'open') {
            currentQr = null;
            currentStatus = 'connected';
            io.emit('status_update', { status: currentStatus, qr: null });
            logToDashboard('WhatsApp Bot successfully connected and ready to process messages!', 'success');
        }
    });

    // Session save callback
    sock.ev.on('creds.update', saveCreds);

    // Message handling logic
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            // Ignore messages sent by the bot itself
            if (msg.key.fromMe) continue;

            // Extract message content
            const text = (msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          '').trim();

            if (!text) continue;

            // Increment and save messages received stat
            config.stats.received++;
            saveConfig();
            io.emit('bot_state', { isBotActive: config.isBotActive, stats: config.stats });

            const jid = msg.key.remoteJid;
            const senderName = msg.pushName || 'User';
            logToDashboard(`Received: "${text}" from ${senderName} (${jid})`, 'incoming');

            // If chatbot replying is toggled off, skip sending answers
            if (!config.isBotActive) {
                logToDashboard('Chatbot replying is currently disabled in dashboard. Message ignored.', 'system');
                continue;
            }

            const cleanText = text.toLowerCase();
            if (cleanText === 'hi' || cleanText === 'hello') {
                // Anti-Ban Safety: Wait 1 to 3 seconds before replying
                const delayMs = Math.floor(Math.random() * 2000) + 1000;
                logToDashboard(`Scheduling auto-reply to ${senderName} in ${delayMs}ms...`, 'system');
                
                await delay(delayMs);

                // Double check if bot is still active after delay
                if (!config.isBotActive) {
                    logToDashboard('Bot was disabled during delay. Message reply aborted.', 'system');
                    continue;
                }

                try {
                    await sock.sendMessage(jid, { text: 'Hello! How can I help you today?' });
                    config.stats.replied++;
                    saveConfig();
                    io.emit('bot_state', { isBotActive: config.isBotActive, stats: config.stats });
                    logToDashboard(`Replied to ${senderName} (${jid})`, 'outgoing');
                } catch (err) {
                    logToDashboard(`Failed to reply to ${senderName}: ${err.message}`, 'error');
                }
            }
        }
    });
}

// Socket.io connection listener
io.on('connection', (socket) => {
    // Send state to newly connected client
    socket.emit('status_update', { status: currentStatus, qr: currentQr });
    socket.emit('bot_state', { isBotActive: config.isBotActive, stats: config.stats });
    logToDashboard('Dashboard browser client connected.', 'system');

    // Handle toggle switch events
    socket.on('toggle_bot', (isActive) => {
        config.isBotActive = isActive;
        saveConfig();
        io.emit('bot_state', { isBotActive: config.isBotActive, stats: config.stats });
        logToDashboard(`Auto-reply chatbot status changed to: ${isActive ? 'ACTIVE' : 'INACTIVE'}`, 'system');
    });

    // Handle session resets
    socket.on('reset_session', () => {
        resetSession();
    });
});

// Load configuration and start Express server & WhatsApp socket
loadConfig();
server.listen(PORT, () => {
    logToDashboard(`Dashboard web interface running at http://localhost:${PORT}`, 'success');
    connectToWhatsApp().catch((err) => {
        logToDashboard(`Fatal error initializing WhatsApp bot: ${err.message}`, 'error');
    });
});
