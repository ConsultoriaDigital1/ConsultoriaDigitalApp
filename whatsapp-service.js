const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const whatsappEvents = new EventEmitter();

// Estado del servicio: DISCONNECTED, CONNECTING, QR, AUTHENTICATED, READY
let status = 'DISCONNECTED';
let qrCodeData = null;
let sock = null;
let starting = false;
let reconnectTimer = null;

// Baileys no expone un "fetchMessages" a demanda como whatsapp-web.js: el historial
// llega por eventos. Guardamos en memoria los mensajes vistos durante la sesión
// (por chat) para poder responder getChatHistory(). Se pierde al reiniciar el proceso.
const messageStore = new Map(); // jid -> [{ id, from, to, body, timestamp, fromMe }]
const MAX_MESSAGES_PER_CHAT = 100;

// Logger silencioso: Baileys es muy verboso por defecto y ensuciaría los logs de PM2.
const logger = pino({ level: 'silent' });

const AUTH_DIR = path.join(os.homedir(), '.baileys_auth', 'consultoria-digital');

const MAPPING_FILE = path.join(__dirname, '.local', 'lid-mappings.json');
const lidToPnMap = new Map();

function isLidJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@lid');
}

function isPhoneJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

function normalizeLidJid(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (isLidJid(raw)) return raw.split(':')[0];
  return null;
}

function normalizePhoneJid(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || isLidJid(raw)) return null;
  if (isPhoneJid(raw)) return jidNormalizedUser(raw);

  const cleaned = cleanPhoneForWhatsapp(raw);
  if (!cleaned || !/^\d{8,15}$/.test(cleaned)) return null;
  return `${cleaned}@s.whatsapp.net`;
}

function rememberLidMapping(lidValue, pnValue, source) {
  const lid = normalizeLidJid(lidValue);
  const pn = normalizePhoneJid(pnValue);

  if (!lid || !pn) return null;

  if (lidToPnMap.get(lid) !== pn) {
    lidToPnMap.set(lid, pn);
    saveMappings();
    console.log(`[WhatsApp Service] Mapped LID ${lid} to PN JID ${pn} from ${source}`);
    whatsappEvents.emit('lid_mapped', { lid, pn });
  }

  return pn;
}

function getMappedPhoneJid(lid) {
  const normalized = normalizeLidJid(lid);
  if (!normalized) return null;
  return lidToPnMap.get(normalized) || null;
}

function loadMappings() {
  try {
    if (fs.existsSync(MAPPING_FILE)) {
      const data = fs.readFileSync(MAPPING_FILE, 'utf8');
      const parsed = JSON.parse(data);
      for (const [k, v] of Object.entries(parsed)) {
        lidToPnMap.set(k, v);
      }
      console.log(`[WhatsApp Service] Loaded ${lidToPnMap.size} LID mappings from file.`);
    } else {
      const dir = path.dirname(MAPPING_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  } catch (err) {
    console.error('[WhatsApp Service] Error loading LID mappings:', err);
  }
}

function saveMappings() {
  try {
    const obj = Object.fromEntries(lidToPnMap.entries());
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.error('[WhatsApp Service] Error saving LID mappings:', err);
  }
}

loadMappings();

function addContactMapping(contact, source) {
  let lid = null;
  let pn = null;

  if (contact.id && contact.lid) {
    if (isLidJid(contact.id) && isPhoneJid(contact.lid)) {
      lid = contact.id;
      pn = contact.lid;
    } else if (isPhoneJid(contact.id) && isLidJid(contact.lid)) {
      lid = contact.lid;
      pn = contact.id;
    }
  }

  if (contact.id && isLidJid(contact.id) && contact.phoneNumber) {
    lid = contact.id;
    pn = contact.phoneNumber;
  }

  rememberLidMapping(lid, pn, source);
}

function extractPhoneNumberFromJid(jid) {
  if (!jid) return null;
  if (jid.endsWith('@lid')) return null; // Ignora JIDs de tipo LID (identidades enlazadas)
  const match = jid.match(/^(\d+)(?=@)/); // Captura los dígitos antes del @
  return match ? match[1] : null;
}

function cleanPhoneForWhatsapp(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('54')) {
    if (cleaned.length === 12 && !cleaned.startsWith('549')) {
      cleaned = '549' + cleaned.slice(2);
    }
    return cleaned;
  }
  if (cleaned.startsWith('9') && cleaned.length === 11) {
    return '54' + cleaned;
  }
  if (cleaned.startsWith('0')) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.length === 10) {
    return '549' + cleaned;
  }
  if (cleaned.length === 12 && cleaned.includes('15')) {
    cleaned = cleaned.replace('15', '');
    if (cleaned.length === 10) {
      return '549' + cleaned;
    }
  }
  return cleaned;
}

function setStatus(newStatus) {
  status = newStatus;
  whatsappEvents.emit('status', { status, qrCode: qrCodeData });
}

function scheduleReconnect(delay = 3000) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    init().catch((err) => console.error('[WhatsApp Service] Reconnect failed:', err));
  }, delay);
}

async function clearAuthDir() {
  try {
    await fs.promises.rm(AUTH_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error('[WhatsApp Service] Error clearing auth dir:', err);
  }
}

function toUnixSeconds(ts) {
  if (!ts) return Math.floor(Date.now() / 1000);
  if (typeof ts === 'number') return ts;
  if (typeof ts.toNumber === 'function') return ts.toNumber(); // Long
  return Number(ts);
}

function extractText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

function myJid() {
  return sock?.user?.id ? jidNormalizedUser(sock.user.id) : '';
}

function getMessagePhoneJid(m) {
  const rawJid = m.key?.remoteJid;
  if (!isLidJid(rawJid)) return rawJid;

  const candidatePn = [
    m.key?.senderPn,
    m.key?.participant,
    m.participant,
    getMappedPhoneJid(rawJid),
  ].find((candidate) => normalizePhoneJid(candidate));

  if (candidatePn) {
    return rememberLidMapping(rawJid, candidatePn, 'message metadata') || rawJid;
  }

  const pnFromSignal = sock?.signalRepository?.lidMapping?.getPNForLID?.(rawJid);
  return rememberLidMapping(rawJid, pnFromSignal, 'signalRepository') || rawJid;
}

function formatMessage(m) {
  const jid = getMessagePhoneJid(m);
  const fromMe = !!m.key.fromMe;
  const me = myJid();
  return {
    id: m.key.id,
    from: fromMe ? me : jid,
    to: fromMe ? jid : me,
    body: extractText(m.message),
    timestamp: toUnixSeconds(m.messageTimestamp),
    fromMe,
    pushName: m.pushName || '',
  };
}

function storeMessage(jid, msg) {
  let arr = messageStore.get(jid);
  if (!arr) {
    arr = [];
    messageStore.set(jid, arr);
  }
  if (arr.some((x) => x.id === msg.id)) return;
  arr.push(msg);
  arr.sort((a, b) => a.timestamp - b.timestamp);
  if (arr.length > MAX_MESSAGES_PER_CHAT) {
    arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT);
  }
}

function isIndividualChat(jid) {
  return !!jid && (isPhoneJid(jid) || isLidJid(jid));
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      qrCodeData = await qrcode.toDataURL(qr);
      console.log('[WhatsApp Service] QR code received.');
      setStatus('QR');
    } catch (err) {
      console.error('[WhatsApp Service] Error generating QR code data URL:', err);
    }
  }

  if (connection === 'open') {
    console.log('[WhatsApp Service] Client is ready.');
    qrCodeData = null;
    setStatus('READY');
  } else if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    qrCodeData = null;

    if (statusCode === DisconnectReason.loggedOut) {
      // Sesión cerrada/invalidada: limpiamos credenciales para volver a pedir QR.
      console.log('[WhatsApp Service] Logged out, clearing session...');
      await clearAuthDir();
      messageStore.clear();
      setStatus('DISCONNECTED');
      scheduleReconnect(1500);
    } else {
      console.log('[WhatsApp Service] Connection closed, reconnecting...', statusCode);
      setStatus('CONNECTING');
      scheduleReconnect(3000);
    }
  }
}

function handleMessagesUpsert({ messages, type }) {
  console.log('========================');
  console.log('UPSERT TYPE:', type);
  console.log('MENSAJES:', messages.length);

  for (const m of messages) {
    console.log('[WhatsApp Service] Mensaje Completo Recibido:', JSON.stringify(m, null, 2));

    if (!m.message) continue;

    const rawJid = m.key?.remoteJid;
    if (!isIndividualChat(rawJid)) continue;

    const formatted = formatMessage(m);
    const resolvedJid = formatted.fromMe ? formatted.to : formatted.from;

    if (rawJid !== resolvedJid) {
      console.log(`[WhatsApp Service] Resolved JID from LID ${rawJid} to PN ${resolvedJid}`);
    }
    
    // Store message in the in-memory store
    storeMessage(resolvedJid, formatted);

    // Emit event so that server.js and the SSE stream receive it in real-time
    whatsappEvents.emit('message', formatted);

    console.log('[WhatsApp Service] Guardado y emitido:', formatted);
  }
}

async function init() {
  if (starting) return;
  starting = true;
  try {
    console.log('[WhatsApp Service] Initializing client...');
    setStatus('CONNECTING');

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined; // Baileys usará su versión por defecto si no hay red.
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', handleConnectionUpdate);
    sock.ev.on('messages.upsert', handleMessagesUpsert);

    sock.ev.on('chats.phoneNumberShare', (update) => {
      if (update && update.lid && update.jid) {
        addContactMapping({ id: update.lid, lid: update.jid }, 'chats.phoneNumberShare');
      }
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        addContactMapping(contact, 'contacts.upsert');
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      for (const update of updates) {
        addContactMapping(update, 'contacts.update');
      }
    });

    sock.ev.on('messaging-history.set', ({ contacts }) => {
      if (contacts) {
        for (const contact of contacts) {
          addContactMapping(contact, 'messaging-history.set');
        }
      }
    });
  } catch (err) {
    console.error('[WhatsApp Service] Failed to initialize client:', err);
    setStatus('DISCONNECTED');
    scheduleReconnect(5000);
  } finally {
    starting = false;
  }
}

function getStatus() {
  return status;
}

function getQrCode() {
  return qrCodeData;
}

async function resolveWhatsappJid(phone) {
  // If it's already a full JID, return it directly
  if (isPhoneJid(phone) || isLidJid(phone)) {
    return phone;
  }

  // If it's a numeric phone/LID that we have mapped in our local store, return the mapped PN JID
  if (lidToPnMap.has(phone + '@lid')) {
    return lidToPnMap.get(phone + '@lid');
  }

  // If the input phone is mapped to a LID in reverse
  for (const [l, p] of lidToPnMap.entries()) {
    if (p.split('@')[0] === phone) {
      return p;
    }
  }

  const cleaned = cleanPhoneForWhatsapp(phone);
  if (!cleaned) {
    throw new Error('Número de teléfono inválido.');
  }

  try {
    const results = await sock.onWhatsApp(cleaned);
    console.log(`[WhatsApp Service] onWhatsApp results for ${cleaned}:`, JSON.stringify(results, null, 2));
    const match = results && results[0];
    
    if (!match || !match.exists) {
      if (isLidJid(phone)) {
        return phone;
      }
      throw new Error(`El número ${phone} no está registrado en WhatsApp.`);
    }

    const pn = match.jid;
    const lid = match.lid || sock?.signalRepository?.lidMapping?.getLIDForPN?.(pn);
    if (lid) {
      rememberLidMapping(lid, pn, 'onWhatsApp');
    } else {
      console.log(`[WhatsApp Service] Could not find LID for JID ${pn}`);
    }
    return match.jid; // jid normalizado, ej: 549XXXXXXXXXX@s.whatsapp.net
  } catch (err) {
    if (isLidJid(phone)) {
      return phone;
    }
    throw err;
  }
}

async function getChatHistory(phone) {
  if (status !== 'READY' || !sock) {
    throw new Error('El servicio de WhatsApp no está conectado o listo.');
  }

  const jid = await resolveWhatsappJid(phone); // E.g. 5493794558038@s.whatsapp.net
  let lidJid = sock?.signalRepository?.lidMapping?.getLIDForPN?.(jid);
  if (!lidJid) {
    // Fallback to local map search in reverse
    for (const [l, p] of lidToPnMap.entries()) {
      if (p === jid) {
        lidJid = l;
        break;
      }
    }
  }

  console.log('[WhatsApp Service] getChatHistory for:', jid, 'LID:', lidJid);
  console.log('[WhatsApp Service] Available store keys:', [...messageStore.keys()]);

  const arrPn = messageStore.get(jid) || [];
  const arrLid = lidJid ? (messageStore.get(lidJid) || []) : [];

  const merged = [];
  const seenIds = new Set();

  for (const msg of [...arrPn, ...arrLid]) {
    if (!seenIds.has(msg.id)) {
      seenIds.add(msg.id);
      merged.push(msg);
    }
  }

  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged.slice(-50);
}

async function resolvePhoneLid(phone) {
  if (status !== 'READY' || !sock) return null;
  try {
    const jid = await resolveWhatsappJid(phone);
    return jid;
  } catch (err) {
    return null;
  }
}

async function getProfilePictureBase64(jid) {
  if (status !== 'READY' || !sock) return '';
  try {
    const url = await sock.profilePictureUrl(jid, 'image');
    if (!url) return '';
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    console.error('[WhatsApp Service] Error getting profile picture:', err.message);
    return '';
  }
}

async function sendMessage(phone, messageText) {
  if (status !== 'READY' || !sock) {
    throw new Error('El servicio de WhatsApp no está conectado o listo.');
  }

  const jid = await resolveWhatsappJid(phone);

  try {
    const sent = await sock.sendMessage(jid, { text: messageText });
    const formatted = {
      id: sent.key.id,
      from: myJid(),
      to: jid,
      body: messageText,
      timestamp: toUnixSeconds(sent.messageTimestamp),
      fromMe: true,
    };
    storeMessage(jid, formatted);
    whatsappEvents.emit('message', formatted);
    return formatted;
  } catch (err) {
    console.error('[WhatsApp Service] Error sending message:', err);
    throw err;
  }
}

async function logout() {
  if (!sock) {
    await clearAuthDir();
    scheduleReconnect(500);
    return;
  }
  console.log('[WhatsApp Service] Logging out client...');
  try {
    // logout() cierra la sesión; el evento connection.update (loggedOut) se encarga
    // de limpiar credenciales y reiniciar para mostrar un QR nuevo.
    await sock.logout();
  } catch (err) {
    console.error('[WhatsApp Service] Error during logout, forcing reset...', err);
    try {
      sock.end(new Error('manual logout'));
    } catch (e) {
      console.error('[WhatsApp Service] Error ending socket:', e);
    }
    await clearAuthDir();
    messageStore.clear();
    qrCodeData = null;
    setStatus('DISCONNECTED');
    scheduleReconnect(500);
  }
}

module.exports = {
  init,
  getStatus,
  getQrCode,
  getChatHistory,
  sendMessage,
  logout,
  resolvePhoneLid,
  getProfilePictureBase64,
  cleanPhoneForWhatsapp,
  extractPhoneNumberFromJid,
  events: whatsappEvents,
};
