const express = require('express');
const { initializeSocket, getSocket } = require('./ifast');

const app = express();
const PORT = process.env.PORT || 8080;

const phoneNumbers = ['972523932747'];
let socketPromises = phoneNumbers.map(num => initializeSocket(num));

Promise.all(socketPromises).then(() => {
  console.log("All sockets initialized");
});

app.get('/qr/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;
  const socketData = getSocket(phoneNumber);

  if (!socketData || !socketData.qrCodeBase64) {
    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; }
            .container { text-align: center; padding: 20px; border-radius: 10px; background-color: white; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); width: 80%; max-width: 400px; }
            .status { font-size: 24px; margin-top: 20px; color: #333; }
            .status.connected { color: green; }
            .tick { font-size: 50px; color: green; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>متصل بـ WhatsApp</h1>
            <div class="tick">&#10004;</div>
            <p class="status connected">تم الاتصال بالجهاز: ${phoneNumber}</p>
            <p>يمكنك الآن إرسال الرسائل!</p>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; }
          .container { text-align: center; padding: 20px; border-radius: 10px; background-color: white; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); width: 80%; max-width: 400px; }
          img { border: 2px solid #333; border-radius: 10px; }
          .status { font-size: 24px; margin-top: 20px; color: #333; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>امسح رمز QR للاتصال ${phoneNumber}</h1>
          <img src="${socketData.qrCodeBase64}" alt="رمز QR" width="300" height="300" />
          <p class="status">يرجى مسح رمز QR للاتصال بـ WhatsApp.</p>
        </div>
        <script>
          setTimeout(function() { window.location.reload(); }, 5000);
        </script>
      </body>
    </html>
  `);
});

app.get('/send-message', async (req, res) => {
  const { number, message, senderNumber } = req.query;

  if (!number || !message || !senderNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'يجب توفير معلمات الرقم والرسالة ورقم المرسل.',
    });
  }

  const socketData = getSocket(senderNumber);

  if (!socketData || !socketData.sock || !socketData.sock.sendMessage) {
    return res.status(500).json({
      status: 'error',
      message: `منفذ WhatsApp لـ ${senderNumber} غير جاهز. يرجى مسح رمز QR أولاً.`,
    });
  }

  try {
    const jid = `${number}@s.whatsapp.net`;
    await socketData.sock.sendMessage(jid, { text: message });

    res.json({
      status: 'success',
      message: `تم إرسال الرسالة إلى ${number} من ${senderNumber}`,
    });
  } catch (error) {
    console.error('خطأ في إرسال الرسالة:', error);
    res.status(500).json({
      status: 'error',
      message: 'فشل إرسال الرسالة.',
    });
  }
});

app.listen(PORT, () => {
  console.log(`الخادم يعمل على http://localhost:${PORT}`);
});
