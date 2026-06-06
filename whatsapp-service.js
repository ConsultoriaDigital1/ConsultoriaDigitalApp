const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const EventEmitter = require('events');
const os = require('os');
const path = require('path');

const whatsappEvents = new EventEmitter();
let client = null;
let status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR, AUTHENTICATED, READY
let qrCodeData = null;

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

async function init() {
  console.log('[WhatsApp Service] Initializing client...');
  status = 'CONNECTING';
  whatsappEvents.emit('status', { status, qrCode: null });

  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'consultoria-digital',
      dataPath: path.join(os.homedir(), '.wwebjs_auth')
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('[WhatsApp Service] QR code received.');
    status = 'QR';
    try {
      qrCodeData = await qrcode.toDataURL(qr);
      whatsappEvents.emit('status', { status, qrCode: qrCodeData });
    } catch (err) {
      console.error('[WhatsApp Service] Error generating QR code data URL:', err);
    }
  });

  client.on('authenticated', () => {
    console.log('[WhatsApp Service] Authenticated successfully.');
    status = 'AUTHENTICATED';
    qrCodeData = null;
    whatsappEvents.emit('status', { status, qrCode: null });
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsApp Service] Authentication failure:', msg);
    status = 'DISCONNECTED';
    qrCodeData = null;
    whatsappEvents.emit('status', { status, qrCode: null });
  });

  client.on('ready', () => {
    console.log('[WhatsApp Service] Client is ready.');
    status = 'READY';
    qrCodeData = null;
    whatsappEvents.emit('status', { status, qrCode: null });
  });

  client.on('disconnected', (reason) => {
    console.log('[WhatsApp Service] Client was disconnected:', reason);
    status = 'DISCONNECTED';
    qrCodeData = null;
    whatsappEvents.emit('status', { status, qrCode: null });
    
    // Attempt reinitialization
    setTimeout(() => {
      init().catch(err => console.error('[WhatsApp Service] Re-initialization failed:', err));
    }, 5000);
  });

  client.on('message_create', (msg) => {
    // We emit all messages (both sent by us and received by us)
    whatsappEvents.emit('message', {
      id: msg.id.id,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe
    });
  });

  try {
    await client.initialize();
  } catch (err) {
    console.error('[WhatsApp Service] Failed to initialize client:', err);
    status = 'DISCONNECTED';
    whatsappEvents.emit('status', { status, qrCode: null });
  }
}

function getStatus() {
  return status;
}

function getQrCode() {
  return qrCodeData;
}

async function getChatHistory(phone) {
  if (status !== 'READY' || !client) {
    throw new Error('El servicio de WhatsApp no está conectado o listo.');
  }

  const cleanedPhone = cleanPhoneForWhatsapp(phone);
  if (!cleanedPhone) {
    throw new Error('Número de teléfono inválido.');
  }

  const chatId = `${cleanedPhone}@c.us`;
  
  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      throw new Error(`El número ${phone} no está registrado en WhatsApp.`);
    }

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 50 });
    
    return messages.map(msg => ({
      id: msg.id.id,
      from: msg.from,
      to: msg.to,
      body: msg.body,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe
    }));
  } catch (err) {
    // If the error is simply because there's no chat history yet, return an empty array
    if (err.message.includes('Chat not found') || err.message.includes('invalid chatId')) {
      return [];
    }
    throw err;
  }
}

async function sendMessage(phone, messageText) {
  if (status !== 'READY' || !client) {
    throw new Error('El servicio de WhatsApp no está conectado o listo.');
  }

  const cleanedPhone = cleanPhoneForWhatsapp(phone);
  if (!cleanedPhone) {
    throw new Error('Número de teléfono inválido.');
  }

  const chatId = `${cleanedPhone}@c.us`;

  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      throw new Error(`El número ${phone} no está registrado en WhatsApp.`);
    }

    const sentMsg = await client.sendMessage(chatId, messageText);
    return {
      id: sentMsg.id.id,
      from: sentMsg.from,
      to: sentMsg.to,
      body: sentMsg.body,
      timestamp: sentMsg.timestamp,
      fromMe: sentMsg.fromMe
    };
  } catch (err) {
    console.error('[WhatsApp Service] Error sending message:', err);
    throw err;
  }
}

async function logout() {
  if (!client || status === 'DISCONNECTED') return;
  console.log('[WhatsApp Service] Logging out client...');
  try {
    await client.logout();
  } catch (err) {
    console.error('[WhatsApp Service] Error during logout, forcing destroy...', err);
    try {
      await client.destroy();
    } catch (e) {
      console.error('[WhatsApp Service] Error destroying client:', e);
    }
    status = 'DISCONNECTED';
    qrCodeData = null;
    whatsappEvents.emit('status', { status, qrCode: null });
    setTimeout(() => {
      init().catch(err => console.error('[WhatsApp Service] Re-init failed:', err));
    }, 1000);
  }
}

module.exports = {
  init,
  getStatus,
  getQrCode,
  getChatHistory,
  sendMessage,
  logout,
  events: whatsappEvents
};
