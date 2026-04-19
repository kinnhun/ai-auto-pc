/**
 * test-telegram.js — Kiểm tra kết nối Telegram
 */
const axios = require('axios');
const config = require('./config.json');

const TOKEN = config.telegramToken;
const CHAT_ID = config.telegramChatId;
const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function run() {
  console.log('\n🔍 TEST TELEGRAM KẾT NỐI\n' + '─'.repeat(40));
  console.log(`Token: ${TOKEN ? TOKEN.substring(0,15) + '...' : '❌ THIẾU'}`);
  console.log(`Chat ID: ${CHAT_ID || '❌ THIẾU'}\n`);

  if (!TOKEN || !CHAT_ID) {
    console.log('❌ Thiếu token hoặc chatId trong config.json!');
    process.exit(1);
  }

  // 1. Kiểm tra bot có hợp lệ không
  try {
    const r = await axios.get(`${BASE}/getMe`, { timeout: 10000 });
    const bot = r.data.result;
    console.log(`✅ Bot hợp lệ: @${bot.username} (${bot.first_name})`);
  } catch(e) {
    console.log(`❌ Token không hợp lệ: ${e.response?.data?.description || e.message}`);
    process.exit(1);
  }

  // 2. Thử gửi tin nhắn
  try {
    const r = await axios.post(`${BASE}/sendMessage`, {
      chat_id: CHAT_ID,
      text: '✅ <b>TEST THÀNH CÔNG!</b>\n\nBot Telegram đã kết nối!\nBạn có thể nhắn lệnh cho tôi:\n• <code>tạo bài</code>\n• <code>trending</code>\n• <code>status</code>',
      parse_mode: 'HTML'
    }, { timeout: 10000 });

    console.log(`✅ Gửi tin nhắn thành công! (message_id: ${r.data.result.message_id})`);
    console.log('\n🎉 Telegram kết nối THÀNH CÔNG!');
  } catch(e) {
    const desc = e.response?.data?.description || e.message;
    console.log(`❌ Gửi tin thất bại: ${desc}`);

    if (desc.includes('chat not found')) {
      console.log('\n📌 NGUYÊN NHÂN: Bạn chưa bấm START trên bot!');
      console.log('👇 LÀM NGAY:');
      console.log(`   1. Mở Telegram`);
      console.log(`   2. Tìm bot: https://t.me/hktech2914_bot`);
      console.log(`   3. Bấm nút "START"`);
      console.log(`   4. Chạy lại: node test-telegram.js`);
    }
  }
}

run().catch(e => { console.error(e.message); process.exit(1); });
