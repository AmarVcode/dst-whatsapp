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

// Session and config folder paths - optimized for persistent volumes (e.g. Render)
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'auth_session');
const CONFIG_PATH = path.join(SESSION_DIR, 'config.json');

// Ensure session directory exists so config.json can be loaded/saved safely
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

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
    try {
        if (fs.existsSync(SESSION_DIR)) {
            // Delete folder contents recursively except config.json
            const files = fs.readdirSync(SESSION_DIR);
            for (const file of files) {
                if (file !== 'config.json') {
                    fs.rmSync(path.join(SESSION_DIR, file), { recursive: true, force: true });
                }
            }
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
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    
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
            let replyText = '';
            let showFooter = true;

            if (cleanText === 'hi' || cleanText === 'hello' || cleanText === 'hey' || cleanText === 'menu' || cleanText === 'help' || cleanText === 'start') {
                replyText = `Hello! Thanks for reaching out to *DST LogiPack* 📦\n\nWe provide industrial packaging, pallet solutions, fumigation, freight forwarding, and 3PL logistics under one roof.\n\nHow can we assist you today?\n1️⃣ *Pallet Solutions* (EPAL, Pinewood)\n2️⃣ *Wooden Boxes & Crates*\n3️⃣ *Fumigation & ISPM-15*\n4️⃣ *Freight Forwarding & Customs*\n5️⃣ *Warehousing & 3PL Storage*\n6️⃣ *Packaging Materials & Supplies*\n7️⃣ *Contact Information*\n8️⃣ *Pallet, Box & Container Calculator*`;
                showFooter = false;
            } else if (cleanText === '1' || cleanText.includes('pallet') || cleanText.includes('epal') || cleanText.includes('pine') || cleanText.includes('wood')) {
                replyText = `*DST LogiPack - Pallet Solutions* 🪵\n\nWe are a leading EPAL pallet manufacturer and pinewood pallet supplier in India, offering:\n• Export-quality & heavy-duty wooden pallets\n• Custom-size & eco-friendly pallets\n• EPAL/Euro pallets with ISPM-15 stamping\n\n📐 *Need help with dimensions?* Try our Pallet Design Tool: https://dstlogipack.com/calc\n\nReply with your dimensions (L x W) and quantity to get a quote!`;
            } else if (cleanText === '2' || cleanText.includes('box') || cleanText.includes('crate') || cleanText.includes('pack')) {
                replyText = `*DST LogiPack - Wooden Boxes & Crates* 📦\n\nWe specialize in custom industrial packaging:\n• Heavy-duty export wooden boxes\n• Engineering wooden crates\n• Vacuum-packed wooden boxes for moisture protection\n\n📐 *Need a quick design breakdown?* Use our Box/Crate Calculator: https://dstlogipack.com/calc\n\nLet us know your machine/cargo dimensions to get a custom packing quote!`;
            } else if (cleanText === '3' || cleanText.includes('fumi') || cleanText.includes('ispm') || cleanText.includes('heat') || cleanText.includes('compliance')) {
                replyText = `*DST LogiPack - Fumigation & Compliance* 💨\n\nWe ensure your export cargo meets global standards with:\n• ISPM-15 heat treatment services\n• Methyl bromide container fumigation\n• Full compliance certificates for customs clearance\n\nDo you need a certificate for a specific port? Let us know.`;
            } else if (cleanText === '4' || cleanText.includes('freight') || cleanText.includes('logist') || cleanText.includes('ship') || cleanText.includes('forward') || cleanText.includes('custom') || cleanText.includes('cha')) {
                replyText = `*DST LogiPack - Freight & Logistics* 🚢✈️\n\nWe offer seamless domestic & international shipping:\n• Air & Sea Freight Forwarding (Import/Export)\n• Licensed Customs Clearance (CHA)\n• LCL consolidation & FCL container booking\n• Door-to-door delivery & NVOCC operations\n\n🚢 *Container Reference Tool:* Check container dimensions and capacities on our portal: https://dstlogipack.com/calc\n\nWhat is your cargo weight and destination?`;
            } else if (cleanText === '5' || cleanText.includes('ware') || cleanText.includes('3pl') || cleanText.includes('stor')) {
                replyText = `*DST LogiPack - Warehousing & 3PL* 🏢\n\nWe provide Pan-India warehousing and third-party logistics (3PL) solutions:\n• Multi-user & dedicated warehouse spaces\n• Professional inventory management & distribution\n• Secure storage with complete safety protocols\n\nLet us know your storage requirements (space or duration) for a quote!`;
            } else if (cleanText === '6' || cleanText.includes('material') || cleanText.includes('belt') || cleanText.includes('bag') || cleanText.includes('desiccat') || cleanText.includes('wrap') || cleanText.includes('lash') || cleanText.includes('secur') || cleanText.includes('chock')) {
                replyText = `*DST LogiPack - Packaging Materials & Cargo Securing* 📦\n\nWe supply high-quality industrial packaging materials and securing services:\n• Ratchet tension belts & strapping patti\n• LDPE packaging & shrink film wrapping\n• Dunnage air bags & container desiccants for moisture control\n• Container lashing, chocking, and ODC cargo securing for machinery\n\nDo you need a bulk supply or cargo securing services? Let us know!`;
            } else if (cleanText === '7' || cleanText.includes('contact') || cleanText.includes('phone') || cleanText.includes('email') || cleanText.includes('address') || cleanText.includes('number') || cleanText.includes('call')) {
                replyText = `*Contact DST LogiPack* 📞\n\n• *Phone/WhatsApp:* +91 96998 67990\n• *Email:* info@dstlogipack.com (or amarvcode@gmail.com)\n• *Website:* https://dstlogipack.com/\n\nFeel free to ask for a quotation or service inquiry!`;
            } else if (cleanText === '8' || cleanText.includes('calculator') || cleanText.includes('calc') || cleanText.includes('tool') || cleanText.includes('dimension')) {
                replyText = `*DST LogiPack - Pallet, Box & Container Tool* 📐📊\n\nUse our interactive online calculator to design pallets, calculate wooden box specifications, and check container dimensions:\n🔗 https://dstlogipack.com/calc`;
            } else if (cleanText.includes('price') || cleanText.includes('quote') || cleanText.includes('cost') || cleanText.includes('rate') || cleanText.includes('enquiry') || cleanText.includes('quotation')) {
                replyText = `*DST LogiPack - Get a Quote* ✍️📊\n\nWe would love to provide you with a customized quotation! Please reply with:\n\n1️⃣ *Your Name & Company Name*\n2️⃣ *Required Service* (e.g., EPAL Pallets, Warehousing, Freight)\n3️⃣ *Dimensions / Weight / Volume*\n4️⃣ *Quantity / Frequency*\n\nOnce you reply, our sales representative will reach out to you within 30 minutes!`;
            } else if (cleanText.includes('track') || cleanText.includes('status') || cleanText.includes('where') || cleanText.includes('cargo') || cleanText.includes('booking') || cleanText.includes('container')) {
                replyText = `*DST LogiPack - Track Shipment* 📍🚢\n\nTo track your consignment, please reply with your:\n• *Booking Number* (e.g. DST-XXXX)\n• *Container Number*\n\nAlternatively, you can track it directly on our customer calculator portal: https://dstlogipack.com/calc`;
            } else if (cleanText.includes('time') || cleanText.includes('hour') || cleanText.includes('timing') || cleanText.includes('open') || cleanText.includes('working')) {
                replyText = `*DST LogiPack - Working Hours* ⏰\n\nOur office and manufacturing facilities operate during the following hours:\n• *Monday to Saturday:* 9:00 AM – 6:30 PM\n• *Sunday:* Closed (Emergency cargo support available via call)`;
            } else if (cleanText.includes('appointment') || cleanText.includes('schedule') || cleanText.includes('book') || cleanText.includes('meeting') || cleanText.includes('visit') || cleanText.includes('consultation')) {
                replyText = `*DST LogiPack - Schedule a Meeting* 📅👔\n\nWe would be happy to schedule a consultation with our logistics specialists! Please reply with:\n\n1️⃣ *Preferred Date & Time*\n2️⃣ *Meeting Type* (Voice Call, Video Call, or Site/Office Visit)\n3️⃣ *Key Topic of Discussion*\n\nOur team will confirm your slot and send a calendar invite shortly.`;
            } else {
                // Fallback / Sorry message when no keywords match
                replyText = `Sorry, I didn't quite catch that. 🤖\n\nI am the DST LogiPack digital assistant. I can help you with EPAL Pallets, Wooden Crates, Fumigation Compliance, Freight Bookings, Warehousing, or Custom Calculations.\n\n💡 *Type "menu" to see all options, "quote" to get an estimate, or "contact" to reach our team.*`;
                showFooter = false;
            }

            if (replyText) {
                if (showFooter) {
                    replyText += `\n\n💡 _Type *menu* to see all options, *quote* for a price estimate, or *calc* to open the calculator._`;
                }
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
                    await sock.sendMessage(jid, { text: replyText });
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
        logToDashboard(`[DEBUG] Received toggle_bot with value: ${isActive} (type: ${typeof isActive})`, 'system');
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
