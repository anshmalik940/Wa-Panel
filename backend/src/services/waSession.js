const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { User, Media, WhatsAppAccount } = require('../models');
const { ProviderError } = require('../providers/errors');
const { filePath } = require('../utils/media');

/**
 * "Link a phone by scanning a QR code" sessions (the WhatsApp Web protocol, via the optional Baileys library).
 *
 * IMPORTANT: this is NOT the official WhatsApp Business API. WhatsApp can restrict or ban numbers that send bulk
 * or unsolicited messages this way. Messages are paced with random delays and contacts who reply STOP are opted out,
 * but use a dedicated number you can afford to lose, and prefer the official Cloud API for large volumes.
 */

const sessions = new Map(); // ownerId -> state
let baileys = null;

const noopLogger = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return noopLogger; } };

async function loadBaileys() {
  if (baileys) return baileys;
  try {
    baileys = await import('@whiskeysockets/baileys');
  } catch {
    throw new ProviderError('The QR (linked phone) feature is not installed on this server. Run "npm install @whiskeysockets/baileys" in the backend folder and restart.', { code: 'QR_NOT_INSTALLED' });
  }
  return baileys;
}

const sessionDir = (ownerId) => path.join(config.DATA_DIR, 'wa-sessions', String(ownerId));
const key = (ownerId) => String(ownerId);

function publicState(st) {
  if (!st) return { status: 'idle', qr: null, phone: '', name: '', lastError: '' };
  return { status: st.status, qr: st.qr || null, phone: st.phone || '', name: st.name || '', lastError: st.lastError || '' };
}

const getState = (ownerId) => publicState(sessions.get(key(ownerId)));
const hasSavedSession = (ownerId) => fs.existsSync(path.join(sessionDir(ownerId), 'creds.json'));

async function setAccount(ownerId, set) {
  if (String(ownerId) === 'platform') return;
  await WhatsAppAccount.updateOne({ ownerId }, { $set: set });
}

/** Maps WhatsApp ack numbers to our statuses: 2 = server ack (sent), 3 = delivered, 4 = read. */
const ACK = { 2: 'sent', 3: 'delivered', 4: 'read' };

async function start(ownerId, { fresh = false } = {}) {
  const id = key(ownerId);
  const existing = sessions.get(id);
  if (existing && ['starting', 'qr', 'connected'].includes(existing.status) && !fresh) return publicState(existing);
  if (existing && existing.sock) await stop(ownerId, { keepFiles: true });

  const b = await loadBaileys();
  const dir = sessionDir(ownerId);
  if (fresh) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { state: authState, saveCreds } = await b.useMultiFileAuthState(dir);

  let version;
  try {
    ({ version } = await b.fetchLatestBaileysVersion());
  } catch {
    version = undefined; // library default
  }

  const st = { status: 'starting', qr: null, phone: '', name: '', lastError: '', sock: null, stopped: false, nextSendAt: 0, retries: 0 };
  sessions.set(id, st);

  const makeSocket = b.makeWASocket || b.default;
  const sock = makeSocket({
    ...(version ? { version } : {}),
    auth: authState,
    logger: noopLogger,
    printQRInTerminal: false,
    browser: ['WA Campaign Panel', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  st.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    if (st.stopped) return;
    if (u.qr) {
      st.status = 'qr';
      st.qr = u.qr;
    }
    if (u.connection === 'open') {
      st.status = 'connected';
      st.qr = null;
      st.retries = 0;
      st.lastError = '';
      const jid = (sock.user && sock.user.id) || '';
      st.phone = jid ? `+${jid.split('@')[0].split(':')[0]}` : '';
      st.name = (sock.user && (sock.user.name || sock.user.verifiedName)) || '';
      await setAccount(ownerId, { status: 'connected', lastCheckedAt: new Date(), lastError: '', displayPhone: st.phone, verifiedName: st.name || 'Linked phone' }).catch((e) => console.error('[wa] account update failed', e));
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      const loggedOut = code === b.DisconnectReason.loggedOut;
      st.qr = null;
      if (loggedOut) {
        st.status = 'logged_out';
        st.lastError = 'The phone logged this device out. Scan a new QR code to link again.';
        fs.rmSync(dir, { recursive: true, force: true });
        await setAccount(ownerId, { status: 'not_configured', lastError: st.lastError }).catch(() => {});
        return;
      }
      st.status = 'disconnected';
      st.lastError = `Connection closed${code ? ` (code ${code})` : ''}. Reconnecting…`;
      await setAccount(ownerId, { status: 'error', lastError: st.lastError }).catch(() => {});
      if (st.retries < 8) {
        st.retries += 1;
        setTimeout(() => {
          if (!st.stopped) start(ownerId).catch((e) => console.error('[wa] reconnect failed', e.message));
        }, Math.min(30000, 2000 * st.retries)).unref();
      }
    }
  });

  // delivery / read receipts for messages we sent
  sock.ev.on('messages.update', async (updates) => {
    try {
      const { applyStatus } = require('./webhookService');
      for (const u of updates || []) {
        const status = ACK[u.update && u.update.status];
        if (u.key && u.key.fromMe && status && status !== 'sent') await applyStatus({ ownerId }, { id: u.key.id, status });
      }
    } catch (e) {
      console.error('[wa] status update failed', e);
    }
  });

  // a contact replying STOP is opted out automatically
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const { optOutByPhone, STOP_RE } = require('./webhookService');
      for (const m of messages || []) {
        if (m.key && m.key.fromMe) continue;
        const text = (m.message && (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || '';
        const from = String((m.key && m.key.remoteJid) || '').split('@')[0];
        if (text && STOP_RE.test(text) && /^\d+$/.test(from)) await optOutByPhone(ownerId, from);
      }
    } catch (e) {
      console.error('[wa] inbound handling failed', e);
    }
  });

  return publicState(st);
}

async function stop(ownerId, { keepFiles = true } = {}) {
  const id = key(ownerId);
  const st = sessions.get(id);
  if (st) {
    st.stopped = true;
    try {
      if (st.sock) st.sock.end(undefined);
    } catch { /* socket already closed */ }
    sessions.delete(id);
  }
  if (!keepFiles) fs.rmSync(sessionDir(ownerId), { recursive: true, force: true });
}

/** Unlinks the phone from WhatsApp (best effort) and deletes the saved session. */
async function logout(ownerId) {
  const st = sessions.get(key(ownerId));
  if (st && st.sock) {
    try {
      await st.sock.logout();
    } catch { /* already logged out / offline */ }
  }
  await stop(ownerId, { keepFiles: false });
  await setAccount(ownerId, { status: 'not_configured', lastError: '', displayPhone: '', verifiedName: '' }).catch(() => {});
}

function toJid(phone) {
  return `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
}

/** Sends one message through the linked phone. Throws ProviderError (retryable or not). */
async function sendMessage(ownerId, { phone, text, media }) {
  const st = sessions.get(key(ownerId));
  if (!st || st.status !== 'connected' || !st.sock) {
    throw new ProviderError('The linked phone is not connected. Open WhatsApp settings and scan the QR code again.', { retryable: true, code: 'QR_NOT_CONNECTED' });
  }
  const jid = toJid(phone);
  try {
    const check = await st.sock.onWhatsApp(jid);
    if (Array.isArray(check) && check[0] && check[0].exists === false) {
      throw new ProviderError('This number is not on WhatsApp', { retryable: false, code: 'NOT_ON_WHATSAPP' });
    }
    let content = text ? { text } : {};
    if (media && media.id) {
      const m = await Media.findById(media.id);
      if (!m) throw new ProviderError('The attached file no longer exists', { retryable: false, code: 'MEDIA_MISSING' });
      const file = { url: filePath(m) };
      const caption = String(text || '').trim() ? { caption: text } : {};
      if (m.kind === 'image') content = { image: file, ...caption };
      else if (m.kind === 'video') content = { video: file, ...caption, mimetype: m.mime };
      else if (m.kind === 'document') content = { document: file, mimetype: m.mime, fileName: m.originalName || 'document', ...caption };
    }
    const res = await st.sock.sendMessage(jid, content);
    if (!res || !res.key || !res.key.id) throw new ProviderError('WhatsApp did not return a message id', { retryable: false, code: 'NO_MESSAGE_ID' });
    return { providerMessageId: res.key.id };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`Linked phone send failed: ${err.message}`, { retryable: true, code: 'QR_SEND' });
  }
}

/** Random pause between messages so traffic does not look like a burst. */
function canSend(ownerId) {
  const st = sessions.get(key(ownerId));
  return !st || Date.now() >= st.nextSendAt;
}

function scheduleNext(ownerId, minMs, maxMs) {
  const st = sessions.get(key(ownerId));
  if (st) st.nextSendAt = Date.now() + minMs + Math.random() * Math.max(0, maxMs - minMs);
}

/** After a server restart: bring back every phone that was linked before. */
async function resumeAll() {
  let n = 0;
  if (hasSavedSession('platform')) {
    start('platform').catch((e) => console.error('[wa] could not resume platform session', e.message));
    n += 1;
  }
  const users = await User.find({ role: { $in: ['customer', 'reseller'] } }).select('_id');
  for (const user of users) {
    if (hasSavedSession(user._id)) {
      start(user._id).catch((e) => console.error('[wa] could not resume session for', String(user._id), e.message));
      n += 1;
    }
  }
  return n;
}

async function stopAll() {
  for (const id of [...sessions.keys()]) await stop(id, { keepFiles: true });
}

module.exports = { start, stop, logout, getState, hasSavedSession, sendMessage, canSend, scheduleNext, resumeAll, stopAll };
