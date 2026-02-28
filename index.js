const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// Detect environment
const isProduction = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
// Chrome executable path
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const linuxChrome = '/usr/bin/google-chrome-stable';

const CSV_OUT = path.join(__dirname, 'import_results.csv');

let waClient = null;
let isReady = false;
let qrImageDataUrl = null;

function normalizeIndianNumber(raw) {
    let digits = raw.replace(/[^0-9]/g, '');
    if (!digits) return null;
    if (digits.length === 10 && /^[6-9]/.test(digits)) digits = '91' + digits;
    if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1);
    if (digits.length < 10) return null;
    return digits;
}

function initCsv() {
    fs.writeFileSync(CSV_OUT, 'Phone,Status,Timestamp_IST\n', 'utf8');
}

function appendCsvRow(phone, status) {
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
    fs.appendFileSync(CSV_OUT, `${phone},${status},"${now}"\n`, 'utf8');
}

function createClient() {
    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: path.join(__dirname, '.wwebjs_auth')
        }),
        puppeteer: {
            executablePath: isProduction ? linuxChrome : (fs.existsSync(macChrome) ? macChrome : undefined),
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
            ]
        }
    });

    client.on('qr', async (qr) => {
        try {
            qrImageDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
        } catch (err) {
            console.error('QR generation failed:', err);
            return;
        }
        io.emit('qr_image', qrImageDataUrl);
        console.log('\n── Scan this QR code with WhatsApp ──');
        qrcodeTerminal.generate(qr, { small: true });
        console.log('Or open http://localhost:3000\n');
    });

    client.on('ready', () => {
        isReady = true;
        qrImageDataUrl = null;
        io.emit('ready');
        console.log('WhatsApp client ready.');
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp disconnected:', reason);
        isReady = false;
        qrImageDataUrl = null;
        io.emit('disconnected');
    });

    client.on('auth_failure', (msg) => {
        console.error('Auth failure:', msg);
        isReady = false;
        io.emit('disconnected');
    });

    return client;
}

async function initWA() {
    if (waClient) {
        try { await waClient.destroy(); } catch (e) { /* ignore */ }
        waClient = null;
    }
    isReady = false;
    qrImageDataUrl = null;

    waClient = createClient();
    try {
        await waClient.initialize();
    } catch (err) {
        console.error('Init failed:', err.message);
        // If the session is corrupted, nuke it and retry
        if (err.message.includes('already running') || err.message.includes('detached')) {
            console.log('Cleaning up stale session and retrying...');
            const authDir = path.join(__dirname, '.wwebjs_auth');
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true });
            }
            waClient = createClient();
            await waClient.initialize();
        }
    }
}

initWA();

// ── Socket.io ───────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('Browser connected.');

    if (isReady) socket.emit('ready');
    else if (qrImageDataUrl) socket.emit('qr_image', qrImageDataUrl);

    socket.on('get_groups', async () => {
        if (!isReady || !waClient) { socket.emit('groups_error', 'Client not ready.'); return; }
        try {
            console.log('Fetching chats...');
            const chats = await waClient.getChats();
            const groups = chats.filter(c => c.isGroup).map(g => ({ id: g.id._serialized, name: g.name }));
            console.log(`Found ${groups.length} groups.`);
            socket.emit('groups', groups);
        } catch (e) {
            console.error('Group fetch error:', e.message);
            // If detached frame, try to reinitialize
            if (e.message.includes('detached') || e.message.includes('Target closed')) {
                socket.emit('groups_error', 'Session expired. Reconnecting...');
                io.emit('reconnecting');
                await initWA();
            } else {
                socket.emit('groups_error', e.message);
            }
        }
    });

    socket.on('disconnect_wa', async () => {
        console.log('User requested disconnect.');
        isReady = false;
        qrImageDataUrl = null;
        io.emit('disconnected');

        try {
            if (waClient) {
                await waClient.logout();
                await waClient.destroy();
            }
        } catch (e) {
            console.error('Logout error (expected):', e.message);
        }

        // Nuke saved session so we get a fresh QR
        const authDir = path.join(__dirname, '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }

        waClient = null;

        // Small delay then reinitialize to get a new QR code
        setTimeout(async () => {
            console.log('Reinitializing for fresh QR...');
            await initWA();
        }, 2000);
    });

    socket.on('start_import', async (data) => {
        const { groupId, rawNumbers } = data;
        if (!isReady || !waClient) { socket.emit('import_error', 'Client not ready.'); return; }

        const numbers = rawNumbers
            .split(/[\n,;]+/)
            .map(n => n.trim())
            .filter(n => n)
            .map(n => normalizeIndianNumber(n))
            .filter(Boolean);

        const unique = [...new Set(numbers)];
        if (unique.length === 0) { socket.emit('import_error', 'No valid numbers found after cleaning.'); return; }

        let chat;
        try {
            chat = await waClient.getChatById(groupId);
            if (!chat.isGroup) { socket.emit('import_error', 'Not a group.'); return; }
        } catch (e) {
            socket.emit('import_error', 'Could not find group: ' + e.message);
            return;
        }

        initCsv();
        const total = unique.length;
        let success = 0, failed = 0;
        const DELAY_MIN = 5000, DELAY_MAX = 15000;

        socket.emit('import_started', { total, groupName: chat.name, numbers: unique });
        const startTime = Date.now();

        for (let i = 0; i < unique.length; i++) {
            const phone = unique[i];
            const pId = `${phone}@c.us`;
            let status = 'pending';

            try {
                await chat.addParticipants([pId]);
                success++;
                status = 'added';
                socket.emit('log', { type: 'success', message: `Added ${phone}` });
            } catch (err) {
                failed++;
                status = 'failed';
                socket.emit('log', { type: 'error', message: `Failed ${phone}: ${err.message || err}` });
            }

            appendCsvRow(phone, status);

            const elapsed = Date.now() - startTime;
            const avgPerItem = elapsed / (i + 1);
            const remaining = unique.length - (i + 1);
            const etaMs = remaining * avgPerItem;
            const completionTime = new Date(Date.now() + etaMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });

            socket.emit('progress', {
                current: i + 1, total, success, failed,
                phone, status, etaMs, completionTime, elapsed
            });

            if (i < unique.length - 1) {
                const delay = Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN + 1)) + DELAY_MIN;
                socket.emit('log', { type: 'wait', message: `Waiting ${(delay / 1000).toFixed(1)}s...` });
                await new Promise(r => setTimeout(r, delay));
            }
        }

        socket.emit('import_finished', { success, failed, total });
        socket.emit('log', { type: 'done', message: `Done! ${success} added, ${failed} failed. CSV saved.` });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\nServer → http://localhost:${PORT}\n`);
});
