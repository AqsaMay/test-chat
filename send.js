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
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SHEET_ID = '1AtprGLuyIgbobCD-F8VqWNk_tBGrlFyrT9Mvakie86c';
const SERVICE_ACCOUNT_JSON = require('./phpmail-397616-c9480524c6e2.json');

const sockets = new Map();
const exportedNumbers = new Map();

const GEMINI_API_KEY = 'AIzaSyA1XEZvBMeGmCSEyGiRw2STH13aWi7Cek0';

const SYSTEM_PROMPT = `
انت مساعد افتراضي لمطبعة ميكس في صور باهر بمنطقة واد الحمص في بناية معصرة الزيتون الطابق الثاني.
المطبعة متخصصة في طباعة كل شيء.
عروضات حالية على شوادر الحجاج.
عروض على الطباعة على الملابس ومن ضمنها البلايز بالاعداد 100 بسعر 30 شيكل على البلوزة سعر الجملة وسعر الواحدة 50 شيكل مفرد.
في حال كان سؤالك لا تتوفر اجابته لا تقم باختراع اي جواب من عندك ولا تذكر تفاصيل كبيرة.
وبعدها اخبر العميل ان يتصل في محمد شقيرات.
دورك هو الرد دائماً باللغة العربية فقط، وبطريقة مهذبة ومختصرة.
لا تستخدم أي كلمات أو عبارات من لغات أخرى، ولا تذكر كلمات غير عربية مثل "burada" أو غيرها.
لا تذكر كلمات غير عربية بشكل جزئي مثل بدل ان تقول اخدمك تقول أserve، لا تستخدم حروف غير عربية مطلقا.
ولا تتكلم اللغة العربية الفصحى بل تكلم اللهجة العامية بدل منها.
إذا لم تفهم السؤال، أخبر المستخدم بأدب أنك لا تستطيع الإجابة.
`;

const WORKING_DAYS = [0, 1, 2, 3, 4, 6];

function isWithinWorkingHours() {
  const now = DateTime.now().setZone('Asia/Jerusalem');
  const hour = now.hour;
  const day = now.weekday % 7;
  return WORKING_DAYS.includes(day) && hour >= 10 && hour < 23;
}

const messageStatusMap = new Map();

function getJerusalemDateStr() {
  return DateTime.now().setZone('Asia/Jerusalem').toFormat('yyyy-LL-dd');
}

function extractPhone(jid) {
  return jid.split('@')[0];
}


async function recordExists(telephone, dateStr) {
  try {
    const creds = require('./phpmail-397616-c9480524c6e2.json');
    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    await sheet.loadHeaderRow();
    console.log('Sheet headers:', sheet.headerValues);

    const rows = await sheet.getRows();

    for (const row of rows) {
      // Prefer named fields if defined, fallback to rawData
      const rowTelephone =
        (row.telephone || row._rawData[sheet.headerValues.indexOf('telephone')] || '').trim();
      const rowDate =
        (row.date || row._rawData[sheet.headerValues.indexOf('date')] || '').trim();

      console.log('Checking row:', { rowTelephone, rowDate });

      if (rowTelephone === telephone.trim() && rowDate === dateStr.trim()) {
        console.log(`Match found: ${telephone} on ${dateStr}`);
        return true;
      }
    }

    console.log(`No match found for ${telephone} on ${dateStr}`);
    return false;
  } catch (err) {
    console.error('Failed to check for existing record:', err.message);
    return false; // Allow insert if error occurs
  }
}




async function appendToSheet({ id, telephone, send, receive, time, date }) {
  try {
    const creds = SERVICE_ACCOUNT_JSON;
    const serviceAccountAuth = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    await sheet.addRow({ id, telephone, send, receive, time, date });
    console.log('Row added to Google Sheet:', { id, telephone, send, receive, time, date });
  } catch (err) {
    console.error('Failed to append to Google Sheet:', err.message);
  }
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
      if (update.key && update.update && update.update.status !== undefined) {
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
        fs.rm(authFolder, { recursive: true, force: true }, (err) => {
          if (!err) {
            initializeSocket(phoneNumber);
          }
        });
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
      if (status === 4) return; // Don't reply if seen

      const userId = extractPhone(msg.key.participant || msg.key.remoteJid);
      const dateStr = getJerusalemDateStr();

      console.log('Checking for record:', { telephone: userId, date: dateStr });
      const exists = await recordExists(userId, dateStr);

      try {
        const reply = await getGeminiReply(text);
        await sock.sendMessage(msg.key.remoteJid, { text: reply });

        if (!exists) {
          // فقط أضف السجل لو مش موجود
          const rowId = Date.now();
          const time = DateTime.now().setZone('Asia/Jerusalem').toFormat('yyyy-LL-dd HH:mm:ss');
          await appendToSheet({
            id: rowId,
            telephone: userId,
            send: text,
            receive: reply,
            time,
            date: dateStr
          });
          console.log(`Added new record for ${userId} on ${dateStr}`);
        } else {
          console.log(`Record already exists for ${userId} on ${dateStr}, reply sent but no new record.`);
        }
      } catch (err) {
        console.error('Gemini API error:', err);
        await sock.sendMessage(msg.key.remoteJid, { text: 'حدث خطأ أثناء معالجة رسالتك 🤖' });
      }
    }, 5000);
  }
});

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

async function getGeminiReply(userInput) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: `${SYSTEM_PROMPT}\n\n${userInput}` }
        ]
      }
    ]
  });

  const response = result.response;
  return response.text().trim();
}

function getSocket(phoneNumber) {
  return sockets.get(phoneNumber);
}

module.exports = { initializeSocket, getSocket, exportedNumbers };
