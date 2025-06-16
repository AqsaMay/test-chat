const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
require('dotenv').config();

let sockets = new Map();

async function initializeSocket(phoneNumber) {
  const authFolder = path.join(__dirname, 'auth_info_baileys', phoneNumber);

  // Ensure auth folder exists
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  // Restore auth from .env if folder is empty
  if (
    process.env.AUTH_ZIP_BASE64 &&
    fs.readdirSync(authFolder).length === 0
  ) {
    try {
      const cleanBase64 = process.env.AUTH_ZIP_BASE64.replace(/[\r\n"]/g, '');
      const zipBuffer = Buffer.from(cleanBase64, 'base64');

      const zip = new AdmZip(zipBuffer);
      zip.extractAllTo(authFolder, true);

      console.log(`✅ Restored WhatsApp credentials for ${phoneNumber} from .env`);
    } catch (error) {
      console.error(`❌ Failed to restore auth for ${phoneNumber}:`, error);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ['AQSA', '', ''],
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrCodeBase64 = await QRCode.toDataURL(qr);
      console.log(`📱 QR Code for ${phoneNumber}:`, qr);
      sockets.set(phoneNumber, { qrCodeBase64 });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Connection closed for ${phoneNumber}:`, lastDisconnect?.error, 'Reason:', reason);

      if (reason === DisconnectReason.loggedOut) {
        console.log(`🔐 Logged out for ${phoneNumber}. Deleting session...`);
        fs.rm(authFolder, { recursive: true, force: true }, (err) => {
          if (err) {
            console.error(`❌ Error deleting auth folder for ${phoneNumber}:`, err);
          } else {
            console.log(`✅ Auth folder for ${phoneNumber} deleted.`);
          }
        });
        sockets.delete(phoneNumber);
      } else {
        console.log(`🔄 Reconnecting for ${phoneNumber}...`);
        setTimeout(() => initializeSocket(phoneNumber), 5000);
      }
    } else if (connection === 'open') {
      console.log(`✅ WhatsApp connection opened for ${phoneNumber}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sockets.set(phoneNumber, { sock });
}

function getSocket(phoneNumber) {
  return sockets.get(phoneNumber);
}

module.exports = { initializeSocket, getSocket };
