const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');

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
  'AIzaSyALmB9kr8-e3PlG2OSplfgfMZBD4gMRyHA',
  'AIzaSyDnrgMzubJwJAOBhjTb3VjZXtcxjkvq27U',
  'AIzaSyABQjdY1f0IrIkWzJ68HZmkRKecrlJeYac'
];

const SYSTEM_PROMPT = `
انت مساعد افتراضي لمطبعة ميكس
في حال سألك الشخص عن موقعكم فتخبره في صور باهر بمنطقة واد الحمص في بناية معصرة الزيتون الطابق الثاني
المطبعة متخصصة في طباعة كل شيء
عروضات حالية على شوادر الحجاج
عروض على الطباعة على الملابس ومن ضمنها البلايز بالاعداد 100 بسعر  30 شيكل على البلوزة سعر الجملة وسعر الواحدة 50 شيكل مفرد
في حال كان سؤالك لا تتوفر اجابته لا تقم باختراع اي جواب من عندك ولا تذكر تفاصيل كبيرة وخاصة الاسعار
وبعدها اخبر العميل ان يتصل بمسؤول المطبعة محمد شقيرات على تلفون 972522902774
لا تكثر من الاحالة الى محمد شقيرات في كل مناسبة بل حاول ذكر اسمه فقط عند الاضطرار وانك لا تعرف التفاصيل او الاسعار مثلا او ما شابه
دورك هو الرد دائماً باللغة العربية فقط، وبطريقة مهذبة ومختصرة قدر الامكان وغير جارحة ابدا او فيها لوم او اي امتعاض 
لا تستخدم أي كلمات أو عبارات من لغات أخرى، ولا تذكر كلمات غير عربية 
وفي حال كانت غير عربية استخدم الحروف العربية بلفظها الغير عربي مثلا
لا تذكر كلمات غير عربية بشكل جزئي مثل بدل ان تقول اخدمك تقول serve، لا تستخدم حروف غير عربية مطلقا
 ولا تتكلم اللغة العربية الفصحى بل تكلم اللهجة العامية الفلسطينية بدل منها
إذا لم تفهم السؤال، أخبر المستخدم بأدب أنك لم تفهم السؤال وان كان بمقدوره ان يعيد السؤال بطريقة اخرى كيف تفهمه
حاول ان تستعمل الايموجي وخاصة في اول رسالة ترحيب مثل الورد 
لا تستعمل اشارة الاستفهام في كلامك لانها غير لطيفة ولا تضع النقطة اخر الكلام 
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
    browser: ['BOT', '', '']
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

      setTimeout(async () => {
        if (!isWithinWorkingHours()) return;

        const status = messageStatusMap.get(msg.key.id);
        if (status === 4) return;

        const userId = extractPhone(msg.key.participant || msg.key.remoteJid);

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
