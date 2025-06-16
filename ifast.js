const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
require('dotenv').config();

let sockets = new Map();

async function initializeSocket(phoneNumber) {
  const authFolder = path.join(__dirname, 'auth_info_baileys', phoneNumber);

  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  // Restore auth from .env if present and folder is empty
  if (
    process.env.AUTH_ZIP_BASE64 &&
    fs.readdirSync(authFolder).length === 0
  ) {
    const zipFile = path.join(authFolder, 'auth.zip');
    fs.writeFileSync(zipFile, Buffer.from(process.env.AUTH_ZIP_BASE64, 'base64'));
    await fs.createReadStream(zipFile)
      .pipe(unzipper.Extract({ path: authFolder }))
      .promise();
    fs.unlinkSync(zipFile);
    console.log('Restored WhatsApp credentials from .env');
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
      console.log(`QR Code for ${phoneNumber}:`, qr);
      sockets.set(phoneNumber, { qrCodeBase64 });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed for ${phoneNumber} due to:`, lastDisconnect?.error, 'Reason:', reason);

      if (reason === DisconnectReason.loggedOut) {
        console.log(`Logged out for ${phoneNumber}. Deleting session files...`);
        fs.rm(authFolder, { recursive: true, force: true }, (err) => {
          if (err) {
            console.error(`Error deleting auth folder for ${phoneNumber}:`, err);
          } else {
            console.log(`Auth folder for ${phoneNumber} deleted successfully.`);
          }
        });
        sockets.delete(phoneNumber);
      } else {
        console.log(`Reconnecting for ${phoneNumber}...`);
        setTimeout(() => initializeSocket(phoneNumber), 5000);
      }
    } else if (connection === 'open') {
      console.log(`WhatsApp connection opened for ${phoneNumber}!`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sockets.set(phoneNumber, { sock });
}

function getSocket(phoneNumber) {
  return sockets.get(phoneNumber);
}

module.exports = { initializeSocket, getSocket };
