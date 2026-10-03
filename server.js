import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import localtunnel from 'localtunnel';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3300;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const JID_MAP_FILE = path.join(__dirname, 'jid_map.json');

// Persistent JID mapping (supports WhatsApp privacy LIDs and phone numbers)
let jidMap = {};
try {
    if (fs.existsSync(JID_MAP_FILE)) {
        jidMap = JSON.parse(fs.readFileSync(JID_MAP_FILE, 'utf8'));
    }
} catch (e) {
    jidMap = {};
}

function saveJidMap() {
    try {
        fs.writeFileSync(JID_MAP_FILE, JSON.stringify(jidMap, null, 2), 'utf8');
    } catch (e) {}
}

// Configuration
let wpWebhookUrl = process.env.WP_WEBHOOK_URL || 'https://metromaa.com/wp-json/socialsync/v1/webhook';
let wpVerifyToken = process.env.WP_VERIFY_TOKEN || 'my_secret_token_123';
let tunnelUrl = process.env.PUBLIC_URL || null;
let tunnelInstance = null;
let wpRegistered = false;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let sock = null;
let currentQR = null;
let connectionStatus = 'connecting'; // 'connecting' | 'qr_ready' | 'connected' | 'disconnected'
let connectedPhone = null;
let connectedName = null;
let syncTimeout = null;

const logger = pino({ level: 'silent' });

// -------------------------------------------------------------
// Cloud Session Persistence (Syncs WhatsApp credentials to/from WordPress)
// -------------------------------------------------------------
async function syncAuthToWordPress() {
    try {
        if (!fs.existsSync(AUTH_DIR)) return;
        const files = fs.readdirSync(AUTH_DIR);
        if (!files.includes('creds.json')) return;

        const authBundle = {};
        for (const file of files) {
            if (file.endsWith('.json')) {
                authBundle[file] = fs.readFileSync(path.join(AUTH_DIR, file), 'utf8');
            }
        }

        // Include jidMap in the sync bundle
        authBundle['__jid_map__'] = JSON.stringify(jidMap);

        const syncEndpoint = wpWebhookUrl.replace(/\/webhook\/?$/, '/bridge-auth-save');
        console.log(`📡 [Auth Persistence] Backing up WhatsApp session to WordPress: ${syncEndpoint}`);

        const res = await fetch(syncEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: wpVerifyToken,
                auth_bundle: authBundle
            })
        });

        const resData = await res.json();
        if (resData && resData.success) {
            console.log(`💾 [Auth Persistence] WhatsApp session securely saved to WordPress backup!`);
        }
    } catch (err) {
        console.warn(`⚠️ [Auth Backup Notice]: Could not sync auth to WordPress (${err.message})`);
    }
}

function debounceSyncAuthToWordPress() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(syncAuthToWordPress, 4000);
}

async function restoreAuthFromWordPress() {
    try {
        if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
            console.log('ℹ️ Local creds.json already exists in container.');
            return;
        }

        console.log('🔄 Checking WordPress for saved WhatsApp session backup...');
        const loadEndpoint = wpWebhookUrl.replace(/\/webhook\/?$/, '/bridge-auth-load');
        const res = await fetch(loadEndpoint, {
            headers: { 'X-Verify-Token': wpVerifyToken }
        });
        const data = await res.json();
        if (data && data.success && data.auth_bundle) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            let restoredFiles = 0;
            for (const [filename, content] of Object.entries(data.auth_bundle)) {
                if (filename === '__jid_map__') {
                    try {
                        jidMap = Object.assign(jidMap, JSON.parse(content));
                        saveJidMap();
                    } catch (e) {}
                    continue;
                }
                fs.writeFileSync(path.join(AUTH_DIR, filename), content, 'utf8');
                restoredFiles++;
            }
            console.log(`✅ [Session Restored] Restored ${restoredFiles} auth files from WordPress backup!`);
        } else {
            console.log('ℹ️ No existing WhatsApp session backup found on WordPress.');
        }
    } catch (err) {
        console.warn('⚠️ Could not restore session from WordPress:', err.message);
    }
}

// -------------------------------------------------------------
// Tunnel Integration (Allows remote WordPress to reach local bridge)
// -------------------------------------------------------------
async function initTunnel() {
    if (process.env.RENDER || process.env.PUBLIC_URL || process.env.NO_TUNNEL) {
        tunnelUrl = process.env.PUBLIC_URL || 'https://whatsapp-bridge-dfc0.onrender.com';
        console.log(`🌐 [Cloud Mode] Using Public Render URL: ${tunnelUrl} (localtunnel disabled)`);
        await registerWithWordPress(tunnelUrl);
        return;
    }

    try {
        console.log('🔄 [Tunnel] Connecting local bridge to public secure tunnel...');
        tunnelInstance = await localtunnel({ port: PORT });
        tunnelUrl = tunnelInstance.url;

        console.log(`=======================================================`);
        console.log(`🌐 Public Tunnel URL: ${tunnelUrl}`);
        console.log(`🖥️ Local Web Panel:  http://localhost:${PORT}`);
        console.log(`=======================================================`);

        tunnelInstance.on('close', () => {
            console.log('⚠️ [Tunnel] Tunnel closed. Reconnecting in 10s...');
            tunnelUrl = null;
            setTimeout(initTunnel, 10000);
        });

        tunnelInstance.on('error', (err) => {
            console.error('⚠️ [Tunnel Error]:', err.message);
        });

        // Automatically sync bridge URL with WordPress site
        await registerWithWordPress(tunnelUrl);

    } catch (err) {
        console.error('⚠️ [Tunnel Failed to Start]:', err.message);
        console.log('ℹ️ Running in local-only mode on http://localhost:' + PORT);
    }
}

// Register public tunnel URL with WordPress
async function registerWithWordPress(urlToRegister) {
    if (!urlToRegister || !wpWebhookUrl) return;
    try {
        const regEndpoint = wpWebhookUrl.replace(/\/webhook\/?$/, '/bridge-register');
        console.log(`📡 [WordPress Sync] Registering tunnel URL with: ${regEndpoint}`);

        const response = await fetch(regEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                bridge_url: urlToRegister,
                token: wpVerifyToken
            })
        });

        const data = await response.json();
        if (data && data.success) {
            wpRegistered = true;
            console.log(`🎉 [Auto-Synced with WordPress] Successfully connected to WordPress!`);
        } else {
            console.log(`ℹ️ [WordPress Sync Note]:`, data);
        }
    } catch (err) {
        console.log(`ℹ️ [WordPress Sync Notice] Could not reach WordPress yet (${err.message}). Will retry automatically.`);
    }
}

// -------------------------------------------------------------
// Message Deduplication & Inbound Cache
// -------------------------------------------------------------
const seenMessageIds = new Set();
function isDuplicateMessage(msgId) {
    if (!msgId) return false;
    if (seenMessageIds.has(msgId)) return true;
    seenMessageIds.add(msgId);
    if (seenMessageIds.size > 2000) {
        const firstKey = seenMessageIds.values().next().value;
        seenMessageIds.delete(firstKey);
    }
    return false;
}

// -------------------------------------------------------------
// High-Concurrency Outbox Queue (Anti-Flood, Stagger & Socket Guard)
// Prevents Baileys WebSocket crashes when 10+ users message simultaneously
// -------------------------------------------------------------
class OutboxQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.maxRetries = 3;
    }

    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({
                ...task,
                resolve,
                reject,
                retries: 0,
                enqueuedAt: Date.now()
            });
            this.process();
        });
    }

    async process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();

            // Wait if socket is temporarily reconnecting
            if (!sock || connectionStatus !== 'connected') {
                if (item.retries < this.maxRetries) {
                    item.retries++;
                    console.log(`⏳ [Outbox Queue] Socket reconnecting... Retrying message in 2s (attempt ${item.retries}/${this.maxRetries})`);
                    this.queue.unshift(item);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                } else {
                    item.reject(new Error('WhatsApp socket is not connected.'));
                    continue;
                }
            }

            try {
                // 1. Send realistic typing presence update (mimics human typing & stabilizes Baileys socket)
                try {
                    await sock.sendPresenceUpdate('composing', item.jid);
                } catch (e) {}

                // 2. Natural human-like dispatch pacing (300ms - 450ms)
                await new Promise(r => setTimeout(r, 350));

                let result;
                if (item.imageUrl) {
                    result = await sock.sendMessage(item.jid, {
                        image: { url: item.imageUrl },
                        caption: item.caption || item.text || ''
                    });
                } else {
                    result = await sock.sendMessage(item.jid, {
                        text: item.text
                    });
                }

                try {
                    await sock.sendPresenceUpdate('paused', item.jid);
                } catch (e) {}

                console.log(`📤 [WhatsApp Sent] To: ${item.jid} | ID: ${result?.key?.id}`);
                addLog('OUTBOX_SENT', `To: ${item.jid} | ID: ${result?.key?.id}`);
                item.resolve(result);

                // 3. Stagger delay between sequential socket frame dispatches
                await new Promise(r => setTimeout(r, 200));

            } catch (err) {
                console.error(`⚠️ [Outbox Error] Send failed (${err.message}). Retries left: ${this.maxRetries - item.retries}`);
                if (item.retries < this.maxRetries) {
                    item.retries++;
                    this.queue.unshift(item);
                    await new Promise(r => setTimeout(r, 1200));
                } else {
                    item.reject(err);
                }
            }
        }

        this.processing = false;
    }
}

const outboxQueue = new OutboxQueue();

const debugLogs = [];
function addLog(type, msg, data = null) {
    try {
        let safeData = null;
        if (data !== null && data !== undefined) {
            if (typeof data === 'object') {
                try {
                    safeData = JSON.parse(JSON.stringify(data, (k, v) => typeof v === 'bigint' ? v.toString() : v));
                } catch (e) {
                    safeData = String(data);
                }
            } else {
                safeData = data;
            }
        }
        const entry = { time: new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka' }), type, msg, data: safeData };
        debugLogs.unshift(entry);
        if (debugLogs.length > 50) debugLogs.pop();
    } catch (e) {}
    console.log(`[${type}] ${msg}`);
}

// -------------------------------------------------------------
// WhatsApp Socket Initialization (Baileys)
// -------------------------------------------------------------
let reconnectTimeout = null;
let isReconnecting = false;

async function initWhatsApp(isRestart = false) {
    if (isReconnecting) return;
    isReconnecting = true;

    try {
        if (sock) {
            try { sock.ev.removeAllListeners(); } catch (e) {}
            try { sock.ws?.close(); } catch (e) {}
            sock = null;
        }

        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        let version = [2, 3000, 1015901307];
        try {
            const verInfo = await fetchLatestBaileysVersion();
            version = verInfo.version;
        } catch (e) {}

        sock = makeWASocket({
            version,
            logger,
            printQRInTerminal: false,
            auth: state,
            browser: ['Nexora AI Automation', 'Chrome', '124.0.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5,
        });

        isReconnecting = false;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            debounceSyncAuthToWordPress();
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    currentQR = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
                    connectionStatus = 'qr_ready';
                    console.log('⚡ [Nexora WhatsApp Bridge] New QR Code Ready! Scan from http://localhost:' + PORT);
                } catch (err) {
                    console.error('Error generating QR data URL:', err);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`🔌 [Nexora WhatsApp Bridge] Connection closed. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                connectionStatus = 'disconnected';
                currentQR = null;
                connectedPhone = null;

                if (shouldReconnect) {
                    if (reconnectTimeout) clearTimeout(reconnectTimeout);
                    // Code 515: Stream restart required, reconnect fast
                    const delay = statusCode === 515 ? 1000 : 3000;
                    reconnectTimeout = setTimeout(() => {
                        isReconnecting = false;
                        initWhatsApp(true);
                    }, delay);
                } else {
                    console.log('❌ Logged out from WhatsApp. Clear session and restart to get a new QR code.');
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                    } catch (e) {}
                    setTimeout(() => {
                        isReconnecting = false;
                        initWhatsApp(true);
                    }, 2000);
                }
            } else if (connection === 'open') {
                connectionStatus = 'connected';
                currentQR = null;
                isReconnecting = false;
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                    reconnectTimeout = null;
                }
                
                const user = sock.user;
                if (user) {
                    connectedPhone = user.id ? user.id.split(':')[0].split('@')[0] : 'Unknown';
                    connectedName = user.name || 'Nexora User';
                }
                console.log(`✅ [Nexora WhatsApp Bridge] WhatsApp Connected Successfully! +${connectedPhone} (${connectedName})`);

                // Sync newly authenticated state to WordPress backup immediately
                debounceSyncAuthToWordPress();

                // Re-sync with WordPress on successful connection
                if (tunnelUrl) {
                    registerWithWordPress(tunnelUrl);
                }
            }
        });

        // Listen for incoming messages from customers
        sock.ev.on('messages.upsert', async (m) => {
            try {
                if (m.type !== 'notify') return;

                for (const msg of m.messages) {
                    if (msg.key.fromMe) {
                        continue;
                    }

                    const msgId = msg.key.id;
                    if (isDuplicateMessage(msgId)) {
                        addLog('MSG_DEDUP', `Skipped duplicate message: ${msgId}`);
                        continue;
                    }

                    const remoteJid = msg.key.remoteJid || '';
                    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) {
                        continue;
                    }

                    const senderPhone = remoteJid.split('@')[0];
                    const pushName = msg.pushName || `Customer ${senderPhone.slice(-4)}`;

                    // Track JID mapping for WhatsApp Privacy LIDs (@lid) vs standard numbers (@s.whatsapp.net)
                    jidMap[senderPhone] = remoteJid;
                    jidMap[remoteJid] = remoteJid;
                    saveJidMap();
                    
                    const msgContent = msg.message?.ephemeralMessage?.message || 
                                       msg.message?.viewOnceMessage?.message || 
                                       msg.message?.viewOnceMessageV2?.message || 
                                       msg.message?.documentWithCaptionMessage?.message || 
                                       msg.message;

                    let text = '';
                    if (msgContent?.conversation) {
                        text = msgContent.conversation;
                    } else if (msgContent?.extendedTextMessage?.text) {
                        text = msgContent.extendedTextMessage.text;
                    } else if (msgContent?.imageMessage?.caption) {
                        text = msgContent.imageMessage.caption;
                    }

                    if (!text) continue;

                    addLog('MSG_PARSED', `From: +${senderPhone} (${pushName}) [${remoteJid}]: "${text}"`);

                    forwardMessageToWordPress({
                        platform: 'whatsapp',
                        sender_id: senderPhone,
                        sender_name: pushName,
                        message: text,
                        message_id: msgId,
                        timestamp: Math.floor(Date.now() / 1000)
                    });
                }
            } catch (err) {
                addLog('UPSERT_ERR', err.message);
                console.error('Error in messages.upsert handler:', err);
            }
        });

    } catch (error) {
        console.error('Failed to initialize WhatsApp socket:', error);
        connectionStatus = 'disconnected';
        isReconnecting = false;
    }
}

// Forward to WordPress webhook
async function forwardMessageToWordPress(payload) {
    if (!wpWebhookUrl) return;

    try {
        const response = await fetch(wpWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Nexora-Verify-Token': wpVerifyToken
            },
            body: JSON.stringify({
                source: 'whatsapp_web_bridge',
                entry: [{
                    changes: [{
                        value: {
                            contacts: [{
                                wa_id: payload.sender_id,
                                profile: { name: payload.sender_name }
                            }],
                            messages: [{
                                from: payload.sender_id,
                                id: payload.message_id,
                                timestamp: String(payload.timestamp),
                                text: { body: payload.message },
                                type: 'text'
                            }]
                        }
                    }]
                }]
            })
        });

        const resBody = await response.text();
        addLog('WEBHOOK_FWD', `WP Response Status: ${response.status}`, { body: resBody });
        console.log(`🚀 [Forwarded to WordPress] Status: ${response.status}`);
    } catch (err) {
        addLog('WEBHOOK_ERR', err.message);
        console.error('⚠️ [Forward Failed] Could not deliver to WordPress webhook:', err.message);
    }
}

// Format phone or LID into accurate WhatsApp destination JID
function formatJid(target) {
    if (!target) return '';
    target = String(target).trim();

    // Already a fully qualified JID
    if (target.endsWith('@lid') || target.endsWith('@s.whatsapp.net')) {
        return target;
    }

    const cleanDigits = target.replace(/\D/g, '');

    // Check if we mapped this user's JID previously (e.g. from incoming message)
    if (jidMap[target]) return jidMap[target];
    if (jidMap[cleanDigits]) return jidMap[cleanDigits];

    // If cleanDigits is 14+ characters and doesn't begin with Bangladesh prefixes (880 or 01), it's a WhatsApp LID
    if (cleanDigits.length >= 14 && !cleanDigits.startsWith('880') && !cleanDigits.startsWith('01')) {
        return `${cleanDigits}@lid`;
    }

    // Standard phone number format
    let phone = cleanDigits;
    if (phone.startsWith('0')) {
        phone = '88' + phone;
    } else if (phone.length === 10 && phone.startsWith('1')) {
        phone = '880' + phone;
    }
    return `${phone}@s.whatsapp.net`;
}

// -------------------------------------------------------------
// Interactive Web UI Dashboard on GET /
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nexora WhatsApp Web Bridge Panel</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #090d16;
            --surface: #0f172a;
            --surface-hover: #1e293b;
            --border: #1e293b;
            --primary: #2563eb;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
            background: var(--bg);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .container {
            width: 100%;
            max-width: 900px;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 20px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            overflow: hidden;
        }
        .header {
            padding: 24px 32px;
            border-bottom: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(180deg, rgba(37,99,235,0.08) 0%, transparent 100%);
        }
        .logo-area { display: flex; align-items: center; gap: 14px; }
        .logo-icon {
            width: 44px;
            height: 44px;
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 24px;
            box-shadow: 0 8px 16px rgba(16, 185, 129, 0.25);
        }
        .title { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
        .subtitle { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            border-radius: 9999px;
            font-size: 12px;
            font-weight: 700;
            background: #1e293b;
            color: #94a3b8;
            border: 1px solid var(--border);
        }
        .status-pill.connected { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
        .status-pill.qr_ready { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border-color: rgba(245, 158, 11, 0.3); }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
        
        .main-content {
            display: grid;
            grid-template-columns: 320px 1fr;
            gap: 32px;
            padding: 32px;
        }
        @media (max-width: 768px) {
            .main-content { grid-template-columns: 1fr; }
        }
        .qr-card {
            background: #ffffff;
            border-radius: 16px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 320px;
            text-align: center;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
            position: relative;
        }
        .qr-card img {
            width: 250px;
            height: 250px;
            object-fit: contain;
            display: none;
        }
        .qr-placeholder {
            color: #64748b;
            font-size: 13px;
            font-weight: 600;
            padding: 20px;
        }
        .connected-box {
            display: none;
            padding: 20px 10px;
            text-align: center;
        }
        .connected-icon {
            width: 70px;
            height: 70px;
            background: #dcfce7;
            color: #15803d;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 34px;
            margin: 0 auto 16px auto;
        }
        .connected-box h3 { color: #166534; font-size: 18px; margin-bottom: 6px; }
        .connected-box p { color: #15803d; font-size: 14px; font-weight: 700; }

        .info-col { display: flex; flex-direction: column; gap: 20px; }
        .card-inner {
            background: #0b1120;
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 18px 20px;
        }
        .card-inner h4 {
            font-size: 14px;
            font-weight: 700;
            margin-bottom: 12px;
            color: #f1f5f9;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .instructions {
            font-size: 13px;
            color: #cbd5e1;
            line-height: 1.8;
            padding-left: 18px;
        }
        .instructions li strong { color: #ffffff; }

        .meta-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-top: 10px;
        }
        .meta-item {
            background: #0f172a;
            border: 1px solid var(--border);
            padding: 10px 12px;
            border-radius: 8px;
        }
        .meta-label { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
        .meta-val { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #38bdf8; word-break: break-all; }

        .footer {
            padding: 18px 32px;
            background: #0b1120;
            border-top: 1px solid var(--border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
        }
        .btn {
            font-family: inherit;
            font-size: 13px;
            font-weight: 600;
            padding: 9px 18px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            border: none;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: #1d4ed8; }
        .btn-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
        .btn-danger:hover { background: rgba(239, 68, 68, 0.25); }
        .btn-outline { background: transparent; color: #cbd5e1; border: 1px solid var(--border); }
        .btn-outline:hover { background: var(--surface-hover); }

        .input-row { display: flex; gap: 8px; margin-top: 8px; }
        .input-text {
            background: #0f172a;
            border: 1px solid var(--border);
            color: white;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 13px;
            flex: 1;
        }
        .spinner {
            width: 24px;
            height: 24px;
            border: 3px solid rgba(16, 185, 129, 0.2);
            border-top-color: #10b981;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 12px auto;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <div class="logo-area">
                <div class="logo-icon">💬</div>
                <div>
                    <div class="title">Nexora AI Automation - WhatsApp Bridge</div>
                    <div class="subtitle">Direct WhatsApp Web Integration Server</div>
                </div>
            </div>
            <div id="status-pill" class="status-pill">
                <span class="dot"></span>
                <span id="status-text">Checking Status...</span>
            </div>
        </div>

        <!-- Main Content -->
        <div class="main-content">
            <!-- Left QR Code Card -->
            <div class="qr-card">
                <div id="qr-loading">
                    <div class="spinner"></div>
                    <div class="qr-placeholder">QR কোড লোড হচ্ছে...</div>
                </div>
                <img id="qr-img" src="" alt="WhatsApp QR Code">
                
                <div id="connected-box" class="connected-box">
                    <div class="connected-icon">✓</div>
                    <h3>WhatsApp Connected!</h3>
                    <p id="connected-phone">+8801XXXXXXXX</p>
                    <span style="display:inline-block; margin-top:8px; font-size:11px; background:#dcfce7; color:#15803d; padding:2px 8px; border-radius:99px; font-weight:700;">AI Auto-Reply Ready</span>
                </div>
            </div>

            <!-- Right Instructions & Info -->
            <div class="info-col">
                <div class="card-inner">
                    <h4>📱 কানেক্ট করার নিয়ম:</h4>
                    <ol class="instructions">
                        <li>আপনার ফোনের <strong>WhatsApp</strong> অ্যাপ ওপেন করুন।</li>
                        <li>উপরে <strong>⋮ মেনু</strong> (Android) বা নিচে <strong>Settings</strong> (iPhone) চাপুন।</li>
                        <li><strong>Linked Devices</strong> &rarr; <strong>"Link a Device"</strong> সিলেক্ট করুন।</li>
                        <li>বামের <strong>QR Code</strong>-টি আপনার ফোনের ক্যামেরা দিয়ে স্ক্যান করুন।</li>
                    </ol>
                </div>

                <div class="card-inner">
                    <h4>🌐 সিস্টেম লিংক ও সিঙ্ক স্ট্যাটাস:</h4>
                    <div class="meta-grid">
                        <div class="meta-item">
                            <div class="meta-label">Target WordPress:</div>
                            <div class="meta-val" id="disp-wp-url">${wpWebhookUrl.replace(/\/wp-json.*$/, '')}</div>
                        </div>
                        <div class="meta-item">
                            <div class="meta-label">Public Tunnel:</div>
                            <div class="meta-val" id="disp-tunnel">Connecting...</div>
                        </div>
                    </div>

                    <div style="margin-top: 14px; display: flex; gap: 8px;">
                        <button class="btn btn-outline" onclick="copyTunnelUrl()">📋 Copy Tunnel URL</button>
                        <button class="btn btn-primary" onclick="syncWithWordPress()">🔄 Sync with WordPress</button>
                    </div>
                </div>

                <!-- Live Test Sender -->
                <div class="card-inner">
                    <h4>🧪 টেস্ট মেসেজ পাঠান:</h4>
                    <div class="input-row">
                        <input type="text" id="test-phone" placeholder="ফোন নম্বর (যেমন: 017XXXXXXXX)" class="input-text" style="max-width: 170px;">
                        <input type="text" id="test-msg" value="Hello from Nexora AI WhatsApp!" class="input-text">
                        <button class="btn btn-primary" onclick="sendTestMessage()" id="btn-test">Send 🚀</button>
                    </div>
                    <div id="test-feedback" style="font-size: 12px; margin-top: 6px;"></div>
                </div>
            </div>
        </div>

        <!-- Footer -->
        <div class="footer">
            <span style="font-size: 12px; color: var(--text-muted);">
                Nexora AI Engine v2.4.0 • Port: ${PORT}
            </span>
            <div style="display: flex; gap: 10px;">
                <button class="btn btn-outline" onclick="location.reload()">🔄 Refresh</button>
                <button class="btn btn-danger" id="btn-logout" onclick="logoutWhatsApp()">✕ Disconnect Session</button>
            </div>
        </div>
    </div>

    <script>
        let currentTunnelUrl = '';

        async function fetchStatus() {
            try {
                const res = await fetch('/api/status', {
                    headers: { 'Bypass-Tunnel-Reminder': 'true' }
                });
                const data = await res.json();
                renderStatus(data);
            } catch (e) {
                console.error('Fetch status error:', e);
            }
        }

        function renderStatus(data) {
            const pill = document.getElementById('status-pill');
            const statusText = document.getElementById('status-text');
            const qrImg = document.getElementById('qr-img');
            const qrLoading = document.getElementById('qr-loading');
            const connectedBox = document.getElementById('connected-box');
            const connectedPhone = document.getElementById('connected-phone');
            const dispTunnel = document.getElementById('disp-tunnel');

            currentTunnelUrl = data.tunnelUrl || '';
            dispTunnel.innerText = data.tunnelUrl ? data.tunnelUrl : 'Local Only (3300)';

            if (data.status === 'connected') {
                pill.className = 'status-pill connected';
                statusText.innerText = 'Connected: +' + data.phone;
                qrLoading.style.display = 'none';
                qrImg.style.display = 'none';
                connectedBox.style.display = 'block';
                connectedPhone.innerText = '+' + data.phone + (data.name ? ' (' + data.name + ')' : '');
            } else if (data.status === 'qr_ready' && data.qr) {
                pill.className = 'status-pill qr_ready';
                statusText.innerText = 'Scan QR Code Now';
                qrLoading.style.display = 'none';
                connectedBox.style.display = 'none';
                qrImg.src = data.qr;
                qrImg.style.display = 'block';
            } else {
                pill.className = 'status-pill';
                statusText.innerText = 'Connecting...';
                qrLoading.style.display = 'block';
                qrImg.style.display = 'none';
                connectedBox.style.display = 'none';
            }
        }

        async function copyTunnelUrl() {
            if (!currentTunnelUrl) {
                alert('Tunnel is still establishing or not active.');
                return;
            }
            await navigator.clipboard.writeText(currentTunnelUrl);
            alert('Tunnel URL copied to clipboard: ' + currentTunnelUrl);
        }

        async function syncWithWordPress() {
            try {
                const res = await fetch('/api/sync-wp', { method: 'POST' });
                const data = await res.json();
                alert(data.message || 'Synced successfully with WordPress!');
            } catch (e) {
                alert('Sync error: ' + e.message);
            }
        }

        async function logoutWhatsApp() {
            if (!confirm('আপনি কি এই WhatsApp ডিসকানেক্ট করতে চান?')) return;
            try {
                await fetch('/api/logout', { method: 'POST' });
                alert('Session reset. New QR code generating...');
                fetchStatus();
            } catch (e) {
                alert('Logout error: ' + e.message);
            }
        }

        async function sendTestMessage() {
            const phone = document.getElementById('test-phone').value.trim();
            const text = document.getElementById('test-msg').value.trim();
            const fb = document.getElementById('test-feedback');
            const btn = document.getElementById('btn-test');

            if (!phone) {
                alert('অনুগ্রহ করে মোবাইল নম্বর লিখুন');
                return;
            }

            btn.disabled = true;
            btn.innerText = 'Sending...';
            fb.innerText = 'মেসেজ পাঠানো হচ্ছে...';
            fb.style.color = '#38bdf8';

            try {
                const res = await fetch('/api/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ to: phone, text: text })
                });
                const data = await res.json();
                btn.disabled = false;
                btn.innerText = 'Send 🚀';

                if (data.success) {
                    fb.innerText = '✓ টেস্ট মেসেজ সফলভাবে পাঠানো হয়েছে!';
                    fb.style.color = '#34d399';
                } else {
                    fb.innerText = '✕ ব্যর্থ: ' + data.message;
                    fb.style.color = '#f87171';
                }
            } catch (e) {
                btn.disabled = false;
                btn.innerText = 'Send 🚀';
                fb.innerText = '✕ কানেকশন ত্রুটি: ' + e.message;
                fb.style.color = '#f87171';
            }
        }

        // Initial check and 2.5s live polling
        fetchStatus();
        setInterval(fetchStatus, 2500);
    </script>
</body>
</html>`);
});

// -------------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------------

// 1. Status & QR Endpoint
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: connectionStatus,
        qr: currentQR,
        phone: connectedPhone,
        name: connectedName,
        tunnelUrl: tunnelUrl,
        webhookUrl: wpWebhookUrl,
        wpRegistered: wpRegistered
    });
});

// 2. Send Message Endpoint (Called by WordPress / Nexora Inbox / Auto-Responder)
app.post('/api/send', async (req, res) => {
    try {
        if (!sock || connectionStatus !== 'connected') {
            return res.status(400).json({
                success: false,
                message: 'WhatsApp is not connected. Please scan the QR code first.'
            });
        }

        const { to, text, imageUrl, caption } = req.body;
        if (!to || (!text && !imageUrl)) {
            return res.status(400).json({
                success: false,
                message: 'Recipient number ("to") and message "text" or "imageUrl" are required.'
            });
        }

        const jid = formatJid(to);

        // Enqueue through high-concurrency throttled OutboxQueue
        const result = await outboxQueue.enqueue({
            jid,
            text,
            imageUrl,
            caption
        });

        return res.json({
            success: true,
            messageId: result?.key?.id,
            to: jid
        });
    } catch (err) {
        console.error('Error in /api/send:', err);
        return res.status(500).json({
            success: false,
            message: err.message || 'Failed to send WhatsApp message.'
        });
    }
});

// 3. Logout / Reset Session Endpoint
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            try { await sock.logout(); } catch (e) {}
            try { sock.end(); } catch (e) {}
        }
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (e) {}

        connectionStatus = 'connecting';
        currentQR = null;
        connectedPhone = null;

        // Clear auth backup from WordPress on explicit logout
        try {
            const clearEndpoint = wpWebhookUrl.replace(/\/webhook\/?$/, '/bridge-auth-clear');
            await fetch(clearEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: wpVerifyToken })
            });
        } catch (e) {}

        setTimeout(() => initWhatsApp(true), 1500);

        return res.json({
            success: true,
            message: 'Session cleared. Fresh QR code is generating...'
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 4. Manual Sync Trigger to WordPress
app.post('/api/sync-wp', async (req, res) => {
    if (tunnelUrl) {
        await registerWithWordPress(tunnelUrl);
        return res.json({ success: true, message: 'Tunnel URL synced with WordPress: ' + tunnelUrl });
    } else {
        return res.json({ success: false, message: 'Tunnel URL is not ready yet.' });
    }
});

// 5. Update WordPress Webhook Configuration
app.post('/api/config', (req, res) => {
    const { webhookUrl, verifyToken } = req.body;
    if (webhookUrl) wpWebhookUrl = webhookUrl;
    if (verifyToken) wpVerifyToken = verifyToken;

    return res.json({
        success: true,
        webhookUrl: wpWebhookUrl,
        verifyToken: wpVerifyToken
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Nexora WhatsApp Bridge', 
        port: PORT,
        tunnelUrl: tunnelUrl,
        status_wa: connectionStatus 
    });
});

// Real-time debug logs endpoint
app.get('/api/debug-logs', (req, res) => {
    try {
        res.json(debugLogs || []);
    } catch (e) {
        res.json([]);
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`=======================================================`);
    console.log(`🚀 Nexora WhatsApp Web Bridge listening on port ${PORT}`);
    console.log(`👉 Webhook target: ${wpWebhookUrl}`);
    console.log(`👉 Dashboard: http://localhost:${PORT}`);
    console.log(`=======================================================`);

    // Restore persistent WhatsApp credentials from WordPress backup if local container restarted
    await restoreAuthFromWordPress();

    initWhatsApp();

    if (!process.env.NO_TUNNEL) {
        initTunnel();
    }
});
