// WhatsApp Bot Dashboard Client Logic

const socket = io();

// UI Elements
const statusBadge = document.getElementById('status-badge');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

const qrContainer = document.getElementById('qr-container');
const qrPlaceholder = document.getElementById('qr-placeholder');
const qrImage = document.getElementById('qr-image');
const connectedContainer = document.getElementById('connected-container');

const botToggle = document.getElementById('bot-toggle');
const statReceived = document.getElementById('stat-received');
const statReplied = document.getElementById('stat-replied');
const consoleLogs = document.getElementById('console-logs');

const btnReset = document.getElementById('btn-reset');
const resetModal = document.getElementById('reset-modal');
const modalCancel = document.getElementById('modal-cancel');
const modalConfirm = document.getElementById('modal-confirm');

// Keep track of toggle state to prevent infinite change loops
let isSettingToggleState = false;

// Helpers
function logToConsole(message, type = 'system') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    consoleLogs.appendChild(entry);
    
    // Auto-scroll to bottom
    consoleLogs.scrollTop = consoleLogs.scrollHeight;
}

function updateStatusBadge(status) {
    // Reset classes
    statusDot.className = 'status-dot';
    
    switch (status) {
        case 'connected':
            statusDot.classList.add('pulsing-green');
            statusText.textContent = 'Connected';
            break;
        case 'scanning_qr':
            statusDot.classList.add('pulsing-yellow');
            statusText.textContent = 'Awaiting Authentication';
            break;
        case 'connecting':
            statusDot.classList.add('pulsing-yellow');
            statusText.textContent = 'Connecting...';
            break;
        case 'disconnected':
        default:
            statusDot.classList.add('pulsing-red');
            statusText.textContent = 'Disconnected';
            break;
    }
}

// Socket Events
socket.on('connect', () => {
    logToConsole('Connected to dashboard server.', 'info');
});

socket.on('disconnect', () => {
    logToConsole('Disconnected from dashboard server.', 'error');
    updateStatusBadge('disconnected');
});

socket.on('status_update', (data) => {
    const { status, qr } = data;
    updateStatusBadge(status);

    if (status === 'connected') {
        qrContainer.classList.add('hidden');
        connectedContainer.classList.remove('hidden');
    } else {
        connectedContainer.classList.add('hidden');
        qrContainer.classList.remove('hidden');
        
        if (status === 'scanning_qr' && qr) {
            qrPlaceholder.classList.add('hidden');
            qrImage.src = qr;
            qrImage.classList.remove('hidden');
        } else {
            qrImage.classList.add('hidden');
            qrPlaceholder.classList.remove('hidden');
        }
    }
});

socket.on('bot_state', (data) => {
    const { isBotActive, stats } = data;
    
    // Set checkbox state without triggering change event
    isSettingToggleState = true;
    botToggle.checked = isBotActive;
    isSettingToggleState = false;

    // Update statistics
    statReceived.textContent = stats.received;
    statReplied.textContent = stats.replied;
});

socket.on('log_update', (data) => {
    const { message, type } = data;
    logToConsole(message, type);
});

// UI Event Listeners
botToggle.addEventListener('change', function() {
    if (isSettingToggleState) return;
    
    const isActive = this.checked;
    socket.emit('toggle_bot', isActive);
    logToConsole(`Auto-reply chatbot turned ${isActive ? 'ON' : 'OFF'}`, 'info');
});

// Reset Session Modal Dialog
btnReset.addEventListener('click', () => {
    resetModal.classList.remove('hidden');
});

modalCancel.addEventListener('click', () => {
    resetModal.classList.add('hidden');
});

// Hide modal if clicked outside content
resetModal.addEventListener('click', (e) => {
    if (e.target === resetModal) {
        resetModal.classList.add('hidden');
    }
});

modalConfirm.addEventListener('click', () => {
    resetModal.classList.add('hidden');
    logToConsole('Requesting WhatsApp session reset...', 'info');
    socket.emit('reset_session');
});
