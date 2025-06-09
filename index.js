const express = require('express');
//const { initializeSocket, getSocket } = require('./send'); // Your existing socket handler
//const { initializeSocket, getSocket, exportedNumbers } = require('./send');
//const { initializeSocket, getSocket, exportedNumbers } = require('./send-save-chat');
//const { initializeSocket, getSocket, exportedNumbers } = require('./send-save-chatmulti');
const { initializeSocket, getSocket, exportedNumbers } = require('./send-save-chatmariam');
//const { initializeSocket, getSocket, exportedNumbers } = require('./sendbot');

const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 8080;
//const PORT = 80;

// Initialize sockets for these numbers
const phoneNumbers = ['972523932747','972555544630','972528940059'];
let socketPromises = phoneNumbers.map(num => initializeSocket(num));

Promise.all(socketPromises).then(() => {
  console.log("All sockets initialized");
});

// Health check endpoint with PROPER connection status
app.get('/send', (req, res) => {
  const serverStatus = {
    status: 'active',
    port: PORT,
    connectedNumbers: phoneNumbers.map(num => {
      const socketData = getSocket(num);
      return {
        number: num,
        status: socketData?.sock?.user ? 'connected' : 'pending'
      };
    }),
    timestamp: new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' })
  };

  res.status(200).json(serverStatus);
});

// QR endpoint with number validation
app.get('/qr/:phoneNumber', (req, res) => {
  const { phoneNumber } = req.params;

  if (!phoneNumbers.includes(phoneNumber)) {
    return res.status(404).send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; 
                   background-color: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; }
            .container { text-align: center; padding: 20px; border-radius: 10px; 
                        background-color: white; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); 
                        width: 80%; max-width: 400px; }
            .error { color: red; font-size: 24px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>خطأ</h1>
            <p class="error">رقم الهاتف ${phoneNumber} غير مسجل في النظام</p>
            <p>الرجاء التحقق من الرقم المدخل</p>
          </div>
        </body>
      </html>
    `);
  }

  const socketData = getSocket(phoneNumber);

  if (!socketData || !socketData.qrCodeBase64) {
    return res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; 
                   background-color: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; }
            .container { text-align: center; padding: 20px; border-radius: 10px; 
                        background-color: white; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); 
                        width: 80%; max-width: 400px; }
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
          body { display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; 
                 background-color: #f0f0f0; font-family: Arial, sans-serif; direction: rtl; }
          .container { text-align: center; padding: 20px; border-radius: 10px; 
                      background-color: white; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); 
                      width: 80%; max-width: 400px; }
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
          setTimeout(function() { window.location.reload(); }, 10000);
        </script>
      </body>
    </html>
  `);
});

// Message sending endpoint
app.get('/send-message', async (req, res) => {
  const { number, message, senderNumber } = req.query;

  if (!number || !message || !senderNumber) {
    return res.status(400).json({
      status: 'error',
      message: 'يجب توفير معلمات الرقم والرسالة ورقم المرسل.',
    });
  }

  const socketData = getSocket(senderNumber);

  if (!socketData?.sock?.user) {
    return res.status(500).json({
      status: 'error',
      message: `منفذ WhatsApp لـ ${senderNumber} غير متصل. يرجى مسح رمز QR أولاً.`,
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

//================================
// Group creation endpoint
// POST /group/:subject - create WhatsApp group
// GET /group/:subject - create group using fixed sender and participants
app.get('/group/:subject', async (req, res) => {
  const { subject } = req.params;

  // Fixed sender number (must be in the phoneNumbers list and authenticated)
  const senderNumber = '972555544630';

  // Fixed list of participants
 const participants = [
    '972505526600',
    //'972522902774',
    '972523932747'
  ];
  

  if (!subject) {
    return res.status(400).json({
      status: 'error',
      message: 'اسم المجموعة مفقود في الرابط.',
    });
  }

  const socketData = getSocket(senderNumber);
  if (!socketData?.sock?.user) {
    return res.status(500).json({
      status: 'error',
      message: `رقم المرسل غير متصل: ${senderNumber}`,
    });
  }

  try {
    const participantJIDs = participants.map(p => `${p}@s.whatsapp.net`);
    const group = await socketData.sock.groupCreate(subject, participantJIDs);

    res.json({
      status: 'success',
      groupId: group.gid,
      subject,
      participants: participants.length,
      message: `✅ تم إنشاء المجموعة "${subject}" بنجاح.`,
    });
  } catch (err) {
    console.error('خطأ في إنشاء المجموعة:', err);
    res.status(500).json({
      status: 'error',
      message: 'حدث خطأ أثناء إنشاء المجموعة.',
    });
  }
});

// then in url http://localhost:8080/group/DELETE_IT66
//======================================



// Export chat numbers as a text file
app.get('/export-chats/:senderNumber', (req, res) => {
  const { senderNumber } = req.params;
  const socketData = getSocket(senderNumber);

  if (!socketData?.sock?.user) {
    return res.status(500).json({
      status: 'error',
      message: `الرقم ${senderNumber} غير متصل.`,
    });
  }

  const numbersSet = exportedNumbers.get(senderNumber);

  if (!numbersSet || numbersSet.size === 0) {
    return res.status(200).json({
      status: 'success',
      count: 0,
      numbers: [],
    });
  }

  const numbers = [...numbersSet];

  res.status(200).json({
    status: 'success',
    count: numbers.length,
    numbers,
  });
});


//++++++++++++++++++++++++++++++++++++++++++++

app.get('/export-text/:senderNumber', (req, res) => {
  const { senderNumber } = req.params;
  const numbersSet = exportedNumbers.get(senderNumber);

  if (!numbersSet || numbersSet.size === 0) {
    return res.status(404).json({
      status: 'error',
      message: 'لم يتم العثور على أرقام لهذا الرقم.',
    });
  }

  const numbers = Array.from(numbersSet);
  const filename = `contacts_${senderNumber}.csv`;
  const csvContent = `Number\n` + numbers.join('\n'); // CSV header + numbers

  fs.writeFileSync(filename, csvContent, 'utf-8');

  res.download(filename, (err) => {
    if (err) {
      console.error('Download error:', err);
      res.status(500).send('فشل تحميل الملف.');
    } else {
      fs.unlinkSync(filename); // Delete after sending
    }
  });
});

//==========================


app.listen(PORT, () => {
  console.log(`الخادم يعمل على http://localhost:${PORT}`);
});
