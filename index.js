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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// --- Middlewares ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'whatsapp-bot-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
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
                '--disable-extensions'
            ],
            bypassCSP: true,
        }
    });

    client.on('qr', async (qr) => {
        console.log('QR RECEIVED');
        qrcodeTerminal.generate(qr, { small: true });
        
        // Convert QR to Image for UI
        const qrImage = await qrcodeImage.toDataURL(qr);
        io.emit('qr', qrImage);
        botStatus = 'disconnected';
        io.emit('status', botStatus);
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
        io.emit('authenticated');
    });

    client.on('ready', () => {
        console.log('CLIENT READY');
        botStatus = 'connected';
        io.emit('status', botStatus);
        io.emit('ready');
    });

    client.on('disconnected', (reason) => {
        console.log('Client was logged out', reason);
        botStatus = 'disconnected';
        io.emit('status', botStatus);
        client.destroy();
        client = null;
    });

    client.on('message', async (msg) => {
        const messageBody = msg.body.toLowerCase().trim();
        const greetings = ['hello', 'hi', 'hey'];
        
        if (greetings.includes(messageBody)) {
            await msg.reply('Hey there! This is an automated reply. How can I help you today?');
        } else if (messageBody.includes('price') || messageBody.includes('cost')) {
            await msg.reply('Thanks for asking! Our basic services are free.');
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

    socket.on('request-connect', () => {
        createClient();
    });

    socket.on('request-disconnect', async () => {
        if (client) {
            await client.logout();
            await client.destroy();
            client = null;
            botStatus = 'disconnected';
            io.emit('status', botStatus);
        }
    });
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
