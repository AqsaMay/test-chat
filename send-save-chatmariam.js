const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
require('.env').config();


const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { DateTime } = require('luxon');

const userSessions = new Map(); 
const messageStatusMap = new Map();
const sockets = new Map();
const exportedNumbers = new Map();
const userApiMap = new Map(); 

const SESSION_TIMEOUT_MINUTES = 15;
const MAX_CONTEXT_MESSAGES = 5;

const GEMINI_API_KEYS = [
  process.env.GEMINI_KEY_1,
  process.env.GEMINI_KEY_2,
  process.env.GEMINI_KEY_3
];


const SYSTEM_PROMPT = `
انت مساعد افتراضي مجهز تجهيز كامل لمحاورة الملحدين بالمنطق البحت
عليك ان تتحدث بشكل احترافي وخالي تماما من اي مغالطة منطقية
استخدم المبادي العقلية قدر الامكان الا وهي ايضا البدهيات
حينما يسأل اي شخص السؤال عليك ان ترد بشكل عقلي وسلس وغير مبتذل
لا تحاول ابدا اقحام اي ديانة بالردود ولا حتى ديانة الاسلام ولا تستخدم لفظ الله انما استبدله بالخالق
الردود تكون مختصرة قدر الامكان وباللغة العربية فقط وحاول ان تكون العربية الفصحى
لا تضع نقاط في اخر كلامك 
كن مهذب وخلوق في كل حواراتك ولا تستخدم اي رد جارح
`;

const WORKING_DAYS = [0, 1, 2, 3, 4, 6];

function isWithinWorkingHours() {
  const now = DateTime.now().setZone('Asia/Jerusalem');
  const hour = now.hour;
  const day = now.weekday % 7;
  return WORKING_DAYS.includes(day) && hour >= 0 && hour < 24;
}

function getApiKeyForUser(userId) {
  if (!userApiMap.has(userId)) {
    const index = userApiMap.size % GEMINI_API_KEYS.length;
    userApiMap.set(userId, index);
  }
  return GEMINI_API_KEYS[userApiMap.get(userId)];
}

function getJerusalemDateStr() {
  return DateTime.now().setZone('Asia/Jerusalem').toFormat('yyyy-LL-dd');
}

function extractPhone(jid) {
  return jid.split('@')[0];
}

function extractText(msg) {
  if (!msg?.message) return '';
  const m = msg.message;
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    '';
}

async function getGeminiReply(userId, userInput) {
  const now = Date.now();
  let session = userSessions.get(userId);

  if (session && now - session.lastActive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
    userSessions.delete(userId);
    session = null;
  }

  if (!session) {
    const selectedApiKey = getApiKeyForUser(userId);
    const genAI = new GoogleGenerativeAI(selectedApiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.2,
        topK: 20,
        topP: 0.7,
        maxOutputTokens: 150,
      }
    });

    const chat = await model.startChat({
      history: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "تمام، أنا جاهز أساعدك." }] }
      ]
    });

    session = {
      chat,
      history: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "تمام، أنا جاهز أساعدك." }] }
      ],
      lastActive: now
    };

    userSessions.set(userId, session);
  }

  if (session.history.length >= MAX_CONTEXT_MESSAGES * 2 + 2) {
    session.history.splice(2, 2);
  }

  session.history.push({ role: "user", parts: [{ text: userInput }] });
  session.lastActive = now;

  const maxRetries = 5;
  const retryDelay = 3000;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const result = await session.chat.sendMessage(userInput);
      const response = await result.response;
      const text = response.text().trim();

      session.history.push({ role: "model", parts: [{ text }] });
      return text;
    } catch (err) {
      const is503 = err?.response?.status === 503 || err?.message?.includes('503');
      if (is503) {
        console.warn(`Gemini API returned 503. Retrying (${attempt + 1}/${maxRetries})...`);
        await new Promise(res => setTimeout(res, retryDelay * (attempt + 1)));
        attempt++;
        continue;
      }
      throw err;
    }
  }

  return "ما قدرت أجاوب هلأ، حاول كمان شوي 🙏";
}

async function initializeSocket(phoneNumber) {
  const authFolder = path.join(__dirname, 'auth_info_baileys', phoneNumber);
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ['BOT', '', ''],
    markOnlineOnConnect: false
    
  });

  sockets.set(phoneNumber, { sock });

  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.key && update.update?.status !== undefined) {
        messageStatusMap.set(update.key.id, update.update.status);
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrCodeBase64 = await QRCode.toDataURL(qr);
      sockets.set(phoneNumber, { ...sockets.get(phoneNumber), qrCodeBase64 });
    }


 if (connection === 'open') {
    console.log('✅ Bot connected successfully.');

    // Hide online status immediately after connecting
    await sock.sendPresenceUpdate('unavailable');
  }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed for ${phoneNumber}. Reason: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        sockets.delete(phoneNumber);
        fs.rm(authFolder, { recursive: true, force: true }, () => initializeSocket(phoneNumber));
      } else {
        setTimeout(() => initializeSocket(phoneNumber), 4000);
      }
    }

    if (connection === 'open') {
      console.log(`Connected: ${phoneNumber}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (msgUpdate) => {
  const messages = msgUpdate.messages;
  if (!messages?.length) return;

  for (const msg of messages) {
    if (msg.key.fromMe) continue;

    const text = extractText(msg);
    if (!text.trim()) continue;

    if (text.length > 500) {
      await sock.sendMessage(msg.key.remoteJid, { text: "الرسالة طويلة جداً، حاول تبسيط سؤالك لو سمحت 🙏" });
      return;
    }

    const userId = extractPhone(msg.key.participant || msg.key.remoteJid);
    
    // ✅ ALLOW ONLY SPECIFIC PHONE NUMBER
    //if (userId !== '972528959455') {
    if (userId !== '972555544630') {
      console.log(`Blocked message from unauthorized number: ${userId}`);
      return;
    }

    setTimeout(async () => {
      if (!isWithinWorkingHours()) return;

      const status = messageStatusMap.get(msg.key.id);
      if (status === 4) return;

      const dateStr = getJerusalemDateStr();

      try {
        const reply = await getGeminiReply(userId, text);
        await sock.sendMessage(msg.key.remoteJid, { text: reply });
      } catch (err) {
        console.error('Gemini API error:', err);
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: 'صار خطأ تقني أثناء الرد، حاول مرة تانية لو سمحت. 🙏'
          });
        } catch (sendErr) {
          console.error('Failed to send fallback message:', sendErr.message);
        }
      }
    }, 5000);
  }
});

}

function getSocket(phoneNumber) {
  return sockets.get(phoneNumber);
}

module.exports = { initializeSocket, getSocket, exportedNumbers };

setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastActive > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
      userSessions.delete(userId);
      console.log(`Session expired for ${userId}`);
    }
  }
}, 60 * 1000);
