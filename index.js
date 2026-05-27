require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const qrcodeImage = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const Fuse = require('fuse.js');

// --- Process Error Handling ---
// Catch unhandled Puppeteer/Protocol errors to prevent server crash
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (reason && reason.message && reason.message.includes('Target closed')) {
        console.log('Detected Puppeteer TargetCloseError. Cleaning up...');
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (err && err.message && err.message.includes('Target closed')) {
        console.log('Prevented crash from TargetCloseError.');
    } else {
        // For other errors, it's safer to log and let the process continue or exit gracefully
    }
});

// Warn about Node version
const nodeVersion = process.versions.node;
if (parseInt(nodeVersion.split('.')[0]) > 22) {
    console.warn(`\n⚠️  WARNING: You are using Node.js v${nodeVersion}.`);
    console.warn('The whatsapp-web.js library is most stable on Node v20 or v22 (LTS).');
    console.warn('Newer versions like v24 can cause "Target closed" or protocol errors.\n');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// --- Load Knowledge Base ---
const knowledgeFile = path.join(__dirname, 'knowledge.json');
let knowledge = JSON.parse(fs.readFileSync(knowledgeFile, 'utf8'));

// Setup Fuse.js for searching services
const fuseOptions = {
    keys: ['name', 'keywords', 'description'],
    threshold: 0.4
};
const fuse = new Fuse(knowledge.services, fuseOptions);

// --- Middlewares ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'whatsapp-bot-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// --- Auth Logic ---
const usersFile = path.join(__dirname, 'users.json');
const getUsers = () => JSON.parse(fs.readFileSync(usersFile, 'utf8'));

const isAuthenticated = (req, res, next) => {
    if (req.session.user) return next();
    res.redirect('/');
};

// --- Routes ---
app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === password);

    if (user) {
        req.session.user = username;
        res.sendStatus(200);
    } else {
        res.status(401).send('Invalid credentials');
    }
});

app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- WhatsApp Client Logic ---
let client;
let botStatus = 'disconnected';
let autoReplyEnabled = true;

const createClient = () => {
    if (client) return;

    botStatus = 'loading';
    io.emit('status', botStatus);

    client = new Client({
        authStrategy: new LocalAuth(),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js',
        },
        puppeteer: {
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-setuid-sandbox',
                '--no-first-run',
                '--disable-dev-shm-usage',
                '--single-process', // Use single process to save memory
                '--js-flags="--max-old-space-size=300"' // Limit JS heap memory
            ],
            bypassCSP: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR RECEIVED');
        qrcodeTerminal.generate(qr, { small: true });
        
        try {
            const qrImage = await qrcodeImage.toDataURL(qr);
            io.emit('qr', qrImage);
            console.log('QR sent to UI');
        } catch (err) {
            console.error('Error generating QR Image:', err);
        }
        
        botStatus = 'disconnected';
        io.emit('status', botStatus);
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
        io.emit('authenticated');
    });

    // --- Ultra-Lightweight Optimization: Block heavy resources ---
    client.on('ready', async () => {
        console.log('CLIENT READY');
        botStatus = 'connected';
        io.emit('status', botStatus);
        io.emit('ready');

        // Access the internal puppeteer page to block resources
        const page = client.pupPage;
        if (page) {
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            console.log('Resource blocking enabled: Images, CSS, Fonts, and Media are now disabled to save RAM.');
        }
    });

    client.on('disconnected', async (reason) => {
        console.log('Client was logged out', reason);
        botStatus = 'disconnected';
        io.emit('status', botStatus);
        try {
            await client.destroy();
        } catch (e) {
            console.error('Error destroying client after disconnect:', e.message);
        }
        client = null;
    });

    client.on('message', async (msg) => {
        if (!autoReplyEnabled) return;

        console.log(`Incoming message from ${msg.from}: ${msg.body}`);

        const text = (msg.body || '').toLowerCase().trim();
        
        // --- 1. Handle Numeric Menu Selection ---
        const serviceBySelection = knowledge.services.find(s => s.id === text);
        
        if (serviceBySelection) {
            console.log(`Matching service found for ID ${text}: ${serviceBySelection.name}`);
            return msg.reply(`*${serviceBySelection.name}*\n\n${serviceBySelection.description}\n\nReply with another number or "menu" to see all options.`);
        }

        // --- 2. Greetings & Text-Based Menu Display ---
        const greetings = ['hi', 'hello', 'hey', 'menu', 'products', 'services'];
        if (greetings.includes(text)) {
            console.log('Greeting detected, sending text menu...');
            let menuMessage = `Welcome to *${knowledge.company_info.name}*!\n\nHow can we help you today? Please reply with a number to get more details:\n\n`;
            
            knowledge.services.forEach(s => {
                menuMessage += `*${s.id}*. ${s.name}\n`;
            });
            
            menuMessage += `\n*9*. Contact Info\n*10*. About Us\n\n_Type a number to select._`;
            return msg.reply(menuMessage);
        }

        // --- 3. Contact Info (Selection 9) ---
        if (text === '9' || text.includes('contact') || text.includes('phone') || text.includes('email')) {
            return msg.reply(`📞 *Contact Us*\n\nPhone: ${knowledge.contact.phone}\nEmail: ${knowledge.contact.email}\nAddress: ${knowledge.contact.address}`);
        }

        // --- 4. About Us (Selection 10) ---
        if (text === '10' || text.includes('about') || text.includes('company')) {
            return msg.reply(`🏢 *About Us*\n\n${knowledge.company_info.about}`);
        }

        // --- 5. Fuzzy Search (Fuse.js) for keywords ---
        const results = fuse.search(text);
        if (results.length > 0) {
            const bestMatch = results[0].item;
            return msg.reply(`*${bestMatch.name}*\n\n${bestMatch.description}`);
        }

        // --- 6. Pricing ---
        if (text.includes('price') || text.includes('cost') || text.includes('quote')) {
            return msg.reply(`For pricing and custom quotes, please contact us at ${knowledge.contact.phone} or email us at ${knowledge.contact.email}. You can also reply with "menu" to see our services.`);
        }

        // --- 7. Fallback ---
        // Only reply if the message is short (to avoid replying to long random messages)
        if (text.length < 20) {
            msg.reply(`I'm not sure about that. Reply with "menu" to see our service list!`);
        }
    });

    client.initialize().catch(err => {
        console.error('Initialization error:', err);
        botStatus = 'disconnected';
        io.emit('status', botStatus);
    });
};

// --- Socket.io Events ---
io.on('connection', (socket) => {
    console.log('New client connected');
    socket.emit('status', botStatus);
    socket.emit('autoReply-status', autoReplyEnabled);

    socket.on('request-connect', () => {
        createClient();
    });

    socket.on('toggle-autoreply', (enabled) => {
        autoReplyEnabled = enabled;
        console.log(`Auto-reply toggled to: ${autoReplyEnabled}`);
        io.emit('autoReply-status', autoReplyEnabled);
    });

    socket.on('request-disconnect', async () => {
        if (client) {
            try {
                await client.destroy();
            } catch (e) {
                console.error('Error destroying client:', e);
            }
            client = null;
            botStatus = 'disconnected';
            io.emit('status', botStatus);
        }
    });

    socket.on('request-reset', async () => {
        if (client) {
            try {
                await client.logout();
                await client.destroy();
            } catch (e) {
                console.error('Error during logout/reset:', e);
            }
            client = null;
        }
        
        // Delete the auth folder for a fresh start
        const authPath = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authPath)) {
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log('Session folder deleted');
            } catch (err) {
                console.error('Failed to delete session folder:', err);
            }
        }
        
        botStatus = 'disconnected';
        io.emit('status', botStatus);
        io.emit('qr', ''); // Clear QR on UI
    });
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
