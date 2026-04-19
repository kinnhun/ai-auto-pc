/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  FB AUTO-BOT v6.0 — Powered by Antigravity AI              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  LUỒNG XỬ LÝ:                                              ║
 * ║  1. Thu thập trending (HN + DevTo + Reddit)                 ║
 * ║  2. Antigravity AI → tạo bài chuẩn SEO chuyên nghiệp       ║
 * ║  3. Generate poster HTML→PNG                                ║
 * ║  4. Gửi Telegram → User DUYỆT (inline keyboard)            ║
 * ║  5. Bấm ✅ → Puppeteer post lên Facebook Messenger          ║
 * ║  6. Lỗi → Antigravity phân tích → tự sửa code → restart    ║
 * ║  7. Mỗi 12h → Antigravity review & nâng cấp tự động        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const puppeteer = require('puppeteer');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const { execSync, spawn } = require('child_process');

// ═══════════════════════════════════════════════════════════
//  SECTION 1 — BOOTSTRAP & CONFIG
// ═══════════════════════════════════════════════════════════

const __dir     = __dirname;
const CFG_PATH  = path.join(__dir, 'config.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

let config = loadConfig();

const LOG_FILE     = path.join(__dir, config.logFile  || 'bot.log');
const POSTER_DIR   = path.join(__dir, 'posters');
const HISTORY_FILE = path.join(__dir, 'post_history.json');
const ERROR_LOG    = path.join(__dir, 'error_history.json');
const SESSION_DIR  = path.join(__dir, 'session_data');
const BOTJS        = path.join(__dir, 'bot.js');

const delay = ms => new Promise(r => setTimeout(r, ms));

for (const dir of [POSTER_DIR, SESSION_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let postHistory = [];
try { postHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}

let errorHistory = [];
try { errorHistory = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch(e) {}

function saveHistory() {
  if (postHistory.length > 300) postHistory = postHistory.slice(-300);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(postHistory, null, 2));
}

function saveErrorHistory(err, context) {
  errorHistory.push({ ts: new Date().toISOString(), error: err, context });
  if (errorHistory.length > 50) errorHistory = errorHistory.slice(-50);
  fs.writeFileSync(ERROR_LOG, JSON.stringify(errorHistory, null, 2));
}

// ═══════════════════════════════════════════════════════════
//  SECTION 2 — LOGGING
// ═══════════════════════════════════════════════════════════

function log(level, msg) {
  const ts   = new Date().toLocaleString('vi-VN');
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
  // Gửi ERROR lên Telegram (fire-and-forget)
  if (level === 'ERROR') {
    saveErrorHistory(msg, 'log');
    tg(`❌ <b>LỖI</b>\n<pre>${esc(String(msg).substring(0, 600))}</pre>`, true).catch(()=>{});
  }
}

// Escape HTML cho Telegram
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════════════════════════
//  SECTION 3 — TELEGRAM API
// ═══════════════════════════════════════════════════════════

const TG = () => `https://api.telegram.org/bot${config.telegramToken}`;
const OWNER = () => String(config.telegramChatId);

async function tgCall(method, data = {}, silent = false) {
  if (!config.telegramToken) return null;
  try {
    const r = await axios.post(`${TG()}/${method}`, data, { timeout: 15000 });
    return r.data;
  } catch(e) {
    const desc = e.response?.data?.description || e.message;
    if (!silent) log('WARN', `[TG:${method}] ${desc}`);
    return null;
  }
}

async function tg(text, silent = false) {
  return tgCall('sendMessage', { chat_id: OWNER(), text, parse_mode: 'HTML' }, silent);
}

async function tgPhoto(photoPath, caption = '') {
  if (!fs.existsSync(photoPath)) return null;
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', OWNER());
    form.append('photo', fs.createReadStream(photoPath));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    const r = await axios.post(`${TG()}/sendPhoto`, form, {
      headers: form.getHeaders(), timeout: 30000
    });
    return r.data;
  } catch(e) {
    log('WARN', `tgPhoto: ${e.message}`);
    return null;
  }
}

async function tgApproval(postContent, key) {
  const preview = postContent.substring(0, 2800);
  return tgCall('sendMessage', {
    chat_id: OWNER(),
    text: `✍️ <b>BÀI VIẾT MỚI — CHỜ DUYỆT</b>\n\n${esc(preview)}\n\n<i>Chọn hành động:</i>`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Đăng ngay', callback_data: `approve:${key}` },
        { text: '🔄 Viết lại', callback_data: `regen:${key}` },
        { text: '❌ Bỏ qua',   callback_data: `reject:${key}` }
      ]]
    }
  });
}

async function tgAnswerCb(id, text = '✅') {
  return tgCall('answerCallbackQuery', { callback_query_id: id, text }, true);
}

async function tgEditMsg(chatId, msgId, text) {
  return tgCall('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML' }, true);
}

// ═══════════════════════════════════════════════════════════
//  SECTION 4 — AI ENGINE (Antigravity-first)
// ═══════════════════════════════════════════════════════════

/**
 * Danh sách model theo ưu tiên.
 * Antigravity được đặt đầu tiên — luôn được thử trước.
 */
const AI_MODELS = [
  { name: 'Antigravity Pro',   model: 'ag/gemini-3.1-pro-high', priority: 1 },
  { name: 'Antigravity Flash', model: 'ag/gemini-3-flash',      priority: 2 },
  { name: 'Codex',             model: 'cx/gpt-5.3-codex',       priority: 3 },
  { name: 'Codex High',        model: 'cx/gpt-5.3-codex-high',  priority: 4 },
];

async function callAI(prompt, opts = {}) {
  const { temperature = 0.8, preferModel = null, maxTokens = 2000 } = opts;

  // Nếu yêu cầu model cụ thể (ví dụ: self-fix dùng Antigravity Pro)
  const models = preferModel
    ? [AI_MODELS.find(m => m.name === preferModel), ...AI_MODELS.filter(m => m.name !== preferModel)].filter(Boolean)
    : AI_MODELS;

  for (const ai of models) {
    try {
      const resp = await axios.post(config.aiEndpoint, {
        model: ai.model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });

      const content = resp.data.choices[0].message.content;
      log('INFO', `✅ [AI:${ai.name}] OK (${content.length} chars)`);
      return { provider: ai.name, content };
    } catch(e) {
      log('WARN', `⚠️ [AI:${ai.name}] ${e.response?.data?.error?.message || e.message}`);
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  SECTION 5 — ANTIGRAVITY SELF-FIX (Tự sửa code khi lỗi)
// ═══════════════════════════════════════════════════════════

let selfFixLock = false;
let selfFixCount = 0;
const MAX_SELF_FIX = 3;

async function antigravitySelfFix(errorMsg, context) {
  if (selfFixLock) { log('WARN', '[SelfFix] Đang chạy, bỏ qua...'); return; }
  if (selfFixCount >= MAX_SELF_FIX) {
    log('WARN', `[SelfFix] Đã fix ${MAX_SELF_FIX} lần, dừng để tránh loop.`);
    await tg(`🛑 <b>Self-Fix dừng</b> — đã sửa ${MAX_SELF_FIX} lần.\nCần can thiệp thủ công!`);
    return;
  }

  selfFixLock = true;
  selfFixCount++;
  await tg(`🔧 <b>Antigravity Self-Fix #${selfFixCount}</b>\n\nLỗi: <pre>${esc(String(errorMsg).substring(0, 300))}</pre>\nContext: <code>${esc(context)}</code>\n\n⏳ Đang phân tích...`);

  try {
    // Đọc toàn bộ source code
    const source = fs.readFileSync(BOTJS, 'utf8');
    const recentErrors = errorHistory.slice(-10).map((e, i) => `${i+1}. [${e.ts}] ${e.error}`).join('\n');

    const prompt = `Bạn là Antigravity AI — Senior Node.js Engineer chuyên sửa bug tự động.

== SOURCE CODE (bot.js) ==
\`\`\`javascript
${source}
\`\`\`

== LỖI HIỆN TẠI ==
Error: ${errorMsg}
Context: ${context}

== LỊCH SỬ LỖI GẦN ĐÂY ==
${recentErrors || 'Không có'}

== NHIỆM VỤ ==
1. Xác định CHÍNH XÁC nguyên nhân lỗi trong code  
2. Viết code FIX tối thiểu (không thay đổi logic không liên quan)
3. Output theo định dạng CHÍNH XÁC:

[ANALYSIS]
Nguyên nhân: ...
Vị trí lỗi: dòng ... function ...
[/ANALYSIS]

[CODE_FIX]
find: <chuỗi code cần tìm CHÍNH XÁC, bao gồm whitespace>
replace: <chuỗi code thay thế>
[/CODE_FIX]

[CMD_FIX]
<lệnh shell cần chạy nếu có, ví dụ: npm install xyz>
[/CMD_FIX]

Nếu không cần fix code: bỏ qua [CODE_FIX]
Nếu không cần chạy lệnh: bỏ qua [CMD_FIX]
Trả lời NGẮN GỌN, CHÍNH XÁC.`;

    // Dùng Antigravity Pro để self-fix
    const result = await callAI(prompt, { temperature: 0.1, preferModel: 'Antigravity Pro', maxTokens: 3000 });

    if (!result) {
      await tg('❌ Antigravity không phản hồi. Không thể tự sửa!');
      return;
    }

    await tg(`🤖 <b>Antigravity phân tích:</b>\n\n${esc(result.content.substring(0, 800))}`);

    let fixApplied = false;

    // Áp dụng CODE_FIX
    const codeMatch = result.content.match(/\[CODE_FIX\]([\s\S]*?)\[\/CODE_FIX\]/i);
    if (codeMatch) {
      const block = codeMatch[1];
      const findMatch    = block.match(/find:\s*([\s\S]+?)(?=replace:|$)/i);
      const replaceMatch = block.match(/replace:\s*([\s\S]+?)$/i);

      if (findMatch && replaceMatch) {
        const findStr    = findMatch[1].trim();
        const replaceStr = replaceMatch[1].trim();
        let src = fs.readFileSync(BOTJS, 'utf8');

        if (src.includes(findStr)) {
          src = src.replace(findStr, replaceStr);
          fs.writeFileSync(BOTJS, src, 'utf8');
          log('INFO', `✅ [SelfFix] Code đã sửa!`);
          await tg(`✅ <b>Code đã được sửa tự động!</b>\n\n<code>Find:</code> <pre>${esc(findStr.substring(0,200))}</pre>\n<code>Replace:</code> <pre>${esc(replaceStr.substring(0,200))}</pre>`);
          fixApplied = true;
        } else {
          log('WARN', '[SelfFix] Không tìm thấy chuỗi cần sửa trong source!');
          await tg('⚠️ Không tìm thấy đoạn code cần sửa. Fix thủ công!');
        }
      }
    }

    // Áp dụng CMD_FIX
    const cmdMatch = result.content.match(/\[CMD_FIX\]([\s\S]*?)\[\/CMD_FIX\]/i);
    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      if (cmd) {
        log('INFO', `🔧 [SelfFix] Chạy: ${cmd}`);
        try {
          const out = execSync(cmd, { cwd: __dir, stdio: 'pipe', timeout: 60000 }).toString();
          await tg(`✅ <b>CMD đã chạy:</b> <code>${esc(cmd)}</code>\n<pre>${esc(out.substring(0,300))}</pre>`);
          fixApplied = true;
        } catch(e2) {
          log('WARN', `CMD fix lỗi: ${e2.message}`);
          await tg(`⚠️ CMD fix thất bại: <code>${esc(e2.message)}</code>`);
        }
      }
    }

    // Auto-restart nếu đã fix
    if (fixApplied && config.autoRestart) {
      await tg('🔄 <b>Đang khởi động lại bot sau khi sửa...</b>');
      await delay(2000);
      autoRestart();
    }

  } catch(err) {
    log('ERROR', `SelfFix crash: ${err.message}`);
  } finally {
    selfFixLock = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 6 — AUTO-UPGRADE (Antigravity tự nâng cấp bot)
// ═══════════════════════════════════════════════════════════

async function antigravityAutoUpgrade() {
  log('INFO', '🚀 [AutoUpgrade] Bắt đầu review code...');
  await tg('🚀 <b>Antigravity Auto-Upgrade</b>\n\n⏳ Đang phân tích code để tìm cải tiến...');

  try {
    const source = fs.readFileSync(BOTJS, 'utf8');
    const recentErrors = errorHistory.slice(-20).map((e,i) => `${i+1}. ${e.error}`).join('\n');

    const prompt = config.upgradePrompt
      .replace('{source_code}', source.substring(0, 8000)) // giới hạn token
      .replace('{error_history}', recentErrors || 'Không có lỗi');

    const result = await callAI(prompt, { temperature: 0.3, preferModel: 'Antigravity Pro', maxTokens: 4000 });

    if (!result) {
      await tg('❌ Antigravity không phản hồi trong quá trình upgrade!');
      return;
    }

    if (result.content.includes('NO_UPGRADE_NEEDED')) {
      await tg('✅ <b>Code đang tốt!</b> Không cần nâng cấp lúc này.');
      return;
    }

    // Hiển thị đề xuất và yêu cầu duyệt
    await tgCall('sendMessage', {
      chat_id: OWNER(),
      text: `🆙 <b>Antigravity Upgrade Proposals</b>\n\n${esc(result.content.substring(0, 3000))}\n\n<i>Apply các thay đổi này?</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Áp dụng tất cả', callback_data: 'upgrade:apply' },
          { text: '❌ Bỏ qua',         callback_data: 'upgrade:skip' }
        ]]
      }
    });

    // Lưu proposal để xử lý khi user bấm nút
    pendingUpgrade = { content: result.content, timestamp: Date.now() };

  } catch(err) {
    log('ERROR', `AutoUpgrade crash: ${err.message}`);
    await tg(`❌ AutoUpgrade lỗi: ${esc(err.message)}`);
  }
}

async function applyUpgrade(proposal) {
  log('INFO', '[AutoUpgrade] Áp dụng upgrade...');
  const matches = [...proposal.matchAll(/\[UPGRADE_\d+\]([\s\S]*?)\[\/UPGRADE_\d+\]/gi)];

  if (matches.length === 0) {
    await tg('⚠️ Không tìm thấy upgrade block hợp lệ!');
    return;
  }

  let applied = 0;
  let src = fs.readFileSync(BOTJS, 'utf8');

  for (const m of matches) {
    const block = m[1];
    const findMatch    = block.match(/find:\s*([\s\S]+?)(?=replace:|$)/i);
    const replaceMatch = block.match(/replace:\s*([\s\S]+?)$/i);
    if (findMatch && replaceMatch) {
      const f = findMatch[1].trim();
      const r = replaceMatch[1].trim();
      if (src.includes(f)) {
        src = src.replace(f, r);
        applied++;
        log('INFO', `  ✅ Upgrade ${applied} áp dụng thành công`);
      }
    }
  }

  if (applied > 0) {
    // Backup trước khi ghi
    fs.writeFileSync(BOTJS + '.bak', fs.readFileSync(BOTJS, 'utf8'));
    fs.writeFileSync(BOTJS, src, 'utf8');
    await tg(`✅ <b>Áp dụng ${applied}/${matches.length} upgrade thành công!</b>\n\n🔄 Khởi động lại...`);
    await delay(2000);
    autoRestart();
  } else {
    await tg('⚠️ Không thể áp dụng upgrade — code source đã thay đổi?');
  }
}

let pendingUpgrade = null;

// ═══════════════════════════════════════════════════════════
//  SECTION 7 — AUTO-RESTART
// ═══════════════════════════════════════════════════════════

let restartCount = 0;
const MAX_RESTARTS = 5;

function autoRestart() {
  restartCount++;
  if (restartCount > MAX_RESTARTS) {
    log('ERROR', `Đã restart ${MAX_RESTARTS} lần, dừng!`);
    tg(`🛑 <b>Bot dừng</b> — đã restart ${MAX_RESTARTS} lần liên tiếp. Cần can thiệp!`).catch(()=>{});
    return;
  }
  log('INFO', `🔄 Auto-restart lần ${restartCount}...`);
  setTimeout(() => {
    const child = spawn('node', ['bot.js'], { cwd: __dir, detached: true, stdio: 'ignore', shell: true });
    child.unref();
    process.exit(0);
  }, 3000);
}

// ═══════════════════════════════════════════════════════════
//  SECTION 8 — TRENDING (Data Sources)
// ═══════════════════════════════════════════════════════════

async function fetchHN() {
  try {
    const r = await axios.get('https://hn.algolia.com/api/v1/search?tags=story&query=AI&hitsPerPage=10', { timeout: 15000 });
    return r.data.hits.map(h => ({
      title: h.title, url: h.url, points: h.points, source: 'HackerNews'
    })).sort((a,b) => b.points - a.points).slice(0,5);
  } catch(e) { return []; }
}

async function fetchDevTo() {
  const all = [];
  for (const tag of ['ai','webdev','machinelearning']) {
    try {
      const r = await axios.get(`https://dev.to/api/articles?tag=${tag}&top=1&per_page=5`, { timeout: 10000 });
      all.push(...r.data.map(a => ({ title: a.title, url: a.url, points: a.positive_reactions_count, source: 'Dev.to' })));
    } catch(e) {}
  }
  return all.sort((a,b) => b.points - a.points).slice(0,5);
}

async function fetchReddit() {
  const all = [];
  for (const sub of ['artificial','MachineLearning','programming']) {
    try {
      const r = await axios.get(`https://www.reddit.com/r/${sub}/hot.json?limit=5`, {
        timeout: 10000, headers: { 'User-Agent': 'fb-auto-bot/6.0' }
      });
      all.push(...(r.data?.data?.children || []).map(p => ({
        title: p.data.title, url: `https://reddit.com${p.data.permalink}`,
        points: p.data.ups, source: 'Reddit'
      })));
    } catch(e) {}
  }
  return all.sort((a,b) => b.points - a.points).slice(0,5);
}

async function getAllTrending() {
  log('INFO', '📡 Thu thập trending...');
  const [hn, devto, reddit] = await Promise.all([fetchHN(), fetchDevTo(), fetchReddit()]);
  const all = [...hn, ...devto, ...reddit].sort((a,b) => b.points - a.points).slice(0,12);
  log('INFO', `📊 ${all.length} bài trending từ ${['HN','DevTo','Reddit'].filter(s => all.some(a => a.source.includes(s.replace('HN','Hacker').replace('DevTo','Dev')))).length} nguồn`);
  return all;
}

// ═══════════════════════════════════════════════════════════
//  SECTION 9 — CONTENT GENERATION (SEO-optimized)
// ═══════════════════════════════════════════════════════════

async function generateSEOPost(trendingOverride = null) {
  const trending = trendingOverride || await getAllTrending();

  const trendingText = trending.length > 0
    ? trending.map((t,i) => `${i+1}. [${t.source}] "${t.title}" (${t.points} points)\n   URL: ${t.url}`).join('\n')
    : 'Không có data trending — viết về xu hướng AI/Tech mới nhất năm 2025.';

  const recentTitles = postHistory.slice(-30).map(h => h.title).join(' | ');

  // 3-step chain prompting cho chất lượng cao nhất
  const step1Prompt = `== BƯỚC 1: RESEARCH ==
Từ danh sách trending sau, tìm ra 1 CHỦ ĐỀ HOT NHẤT và thú vị nhất để viết bài Facebook:

${trendingText}

Output: Tên chủ đề + lý do tại sao chủ đề này thu hút người đọc Việt Nam.
Bài đã đăng gần đây (KHÔNG chọn chủ đề tương tự): ${recentTitles || 'chưa có'}`;

  const step2Prompt = `== BƯỚC 2: VIẾT BÀI FACEBOOK CHUẨN SEO ==
${config.aiPrompt.replace('{trending_data}', trendingText)}

Bài đã đăng gần đây (TRÁNH lặp nội dung): ${recentTitles || 'chưa có'}`;

  log('INFO', '🤖 [AI] Bước 1: Chọn chủ đề...');
  const step1 = await callAI(step1Prompt, { temperature: 0.7, preferModel: 'Antigravity Pro', maxTokens: 500 });
  if (!step1) { log('WARN', 'Bước 1 thất bại, dùng prompt thẳng'); }

  const finalPrompt = step1
    ? `Chủ đề được chọn: ${step1.content}\n\n${step2Prompt}`
    : step2Prompt;

  log('INFO', '🤖 [AI] Bước 2: Viết bài chuẩn SEO...');
  const result = await callAI(finalPrompt, { temperature: 0.85, preferModel: 'Antigravity Pro', maxTokens: 1500 });

  if (result) {
    postHistory.push({
      title: trending[0]?.title || 'AI Content',
      timestamp: new Date().toISOString(),
      provider: result.provider,
      length: result.content.length
    });
    saveHistory();
    log('INFO', `✅ Bài viết: ${result.content.length} ký tự | Provider: ${result.provider}`);
    return result.content;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  SECTION 10 — POSTER GENERATOR
// ═══════════════════════════════════════════════════════════

async function createPoster(postContent) {
  try {
    const nodeHtmlToImage = require('node-html-to-image');
    const posterPath = path.join(POSTER_DIR, `poster_${Date.now()}.png`);
    const headline = postContent.split('\n')[0].replace(/[🔥💡⚡🚀✅→]/g, '').replace(/[#<>]/g, '').trim().substring(0, 100);
    const bodyText = postContent.split('\n').slice(1,4).join(' ').replace(/[<>]/g,'').substring(0, 200);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;800;900&display=swap');
      *{margin:0;padding:0;box-sizing:border-box;}
      body{width:1200px;height:630px;overflow:hidden;
        background:linear-gradient(135deg,#0a0a1a 0%,#1a0a2e 40%,#0d1f3c 100%);
        font-family:'Be Vietnam Pro',sans-serif;color:#fff;position:relative;}
      .noise{position:absolute;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");opacity:0.4;}
      .glow1{position:absolute;width:500px;height:500px;border-radius:50%;background:radial-gradient(circle,rgba(124,58,237,0.35) 0%,transparent 70%);top:-150px;right:-100px;}
      .glow2{position:absolute;width:400px;height:400px;border-radius:50%;background:radial-gradient(circle,rgba(6,182,212,0.25) 0%,transparent 70%);bottom:-100px;left:-80px;}
      .glow3{position:absolute;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(251,191,36,0.2) 0%,transparent 70%);bottom:120px;right:250px;}
      .wrap{position:relative;z-index:10;padding:52px 60px;height:100%;display:flex;flex-direction:column;justify-content:space-between;}
      .top{display:flex;align-items:center;gap:12px;}
      .badge{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,rgba(124,58,237,0.4),rgba(6,182,212,0.3));border:1px solid rgba(124,58,237,0.6);border-radius:999px;padding:8px 22px;font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;backdrop-filter:blur(8px);}
      .dot{width:8px;height:8px;border-radius:50%;background:#7c3aed;animation:pulse 2s infinite;}
      @keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.5;transform:scale(1.5);}}
      .headline{font-size:46px;font-weight:900;line-height:1.18;max-width:860px;background:linear-gradient(135deg,#fff 0%,#e0d7ff 50%,#a5f3fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
      .body{font-size:18px;font-weight:400;color:rgba(255,255,255,0.65);max-width:780px;line-height:1.5;margin-top:10px;}
      .bottom{display:flex;justify-content:space-between;align-items:flex-end;}
      .tags{display:flex;gap:10px;flex-wrap:wrap;}
      .tag{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:10px;padding:5px 14px;font-size:13px;font-weight:600;color:rgba(255,255,255,0.8);}
      .brand{font-size:14px;color:rgba(255,255,255,0.35);font-weight:600;letter-spacing:0.5px;text-align:right;}
      .brand span{display:block;font-size:11px;color:rgba(255,255,255,0.2);}
    </style></head><body>
      <div class="noise"></div>
      <div class="glow1"></div><div class="glow2"></div><div class="glow3"></div>
      <div class="wrap">
        <div class="top">
          <div class="badge"><div class="dot"></div>🔥 TRENDING AI & TECH</div>
        </div>
        <div>
          <div class="headline">${headline}</div>
          <div class="body">${bodyText}</div>
        </div>
        <div class="bottom">
          <div class="tags">
            <div class="tag">#AI2025</div>
            <div class="tag">#VibeCoding</div>
            <div class="tag">#LLM</div>
            <div class="tag">#CôngNghệ</div>
          </div>
          <div class="brand">HKTech Bot<span>Powered by Antigravity</span></div>
        </div>
      </div>
    </body></html>`;

    await nodeHtmlToImage({
      output: posterPath, html,
      puppeteerArgs: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
    });
    log('INFO', `🖼️ Poster: ${posterPath}`);
    return posterPath;
  } catch(e) {
    log('WARN', `Poster thất bại: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 11 — FACEBOOK MESSENGER (Puppeteer)
// ═══════════════════════════════════════════════════════════

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function findBrowser() {
  return CHROME_PATHS.find(p => fs.existsSync(p)) || null;
}

async function launchBrowser() {
  const execPath = findBrowser();
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: SESSION_DIR,
    executablePath: execPath || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars', '--disable-notifications',
      '--disable-dev-shm-usage', '--window-size=1366,768', '--lang=vi-VN'
    ],
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });
  return { browser, page };
}

async function ensureFbLogin(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(3000);
  if (!page.url().includes('/login')) { log('INFO', '✅ FB: Đã đăng nhập'); return true; }

  log('WARN', '⚠️ Cần đăng nhập Facebook!');
  await tg('⚠️ <b>Cần đăng nhập Facebook!</b>\nBot đang mở trình duyệt — login thủ công (3 phút).');

  for (let i = 0; i < 36; i++) {
    await delay(5000);
    if (!page.url().includes('/login')) {
      await tg('✅ <b>Đăng nhập FB thành công!</b>');
      return true;
    }
  }
  await tg('❌ Timeout đăng nhập. Thử lại sau!');
  return false;
}

async function postToMessenger(message, posterPath = null) {
  log('INFO', '📨 Gửi Messenger...');
  let browser = null;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    const page  = launched.page;

    if (!(await ensureFbLogin(page))) { await browser.close(); return false; }

    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(4000);

    // Gửi poster nếu có
    if (posterPath && fs.existsSync(posterPath)) {
      try {
        await page.evaluate(() => {
          document.querySelectorAll('input[type="file"]').forEach(el =>
            el.style.cssText = 'display:block!important;opacity:1!important;position:fixed!important;top:0!important;left:0!important;z-index:99999!important;'
          );
        });
        await delay(400);
        const fi = await page.$('input[type="file"]');
        if (fi) { await fi.uploadFile(posterPath); log('INFO', '📎 Poster attached'); await delay(3000); }
      } catch(e) { log('WARN', `Poster skip: ${e.message}`); }
    }

    // Tìm ô nhập chat
    const CHAT_SELECTORS = [
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label="Aa"][contenteditable]',
      '[contenteditable="true"][data-lexical-editor]',
      'div[contenteditable="true"]',
    ];

    let chatBox = null;
    for (const sel of CHAT_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 8000 });
        chatBox = await page.$(sel);
        if (chatBox) { log('INFO', `Chat: ${sel}`); break; }
      } catch(e) {}
    }

    if (!chatBox) {
      throw new Error('Không tìm thấy ô chat Messenger!');
    }

    await chatBox.click();
    await delay(600);

    // Type từng dòng
    for (let i = 0, lines = message.split('\n'); i < lines.length; i++) {
      await page.keyboard.type(lines[i], { delay: 6 });
      if (i < lines.length - 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }

    await delay(1000);
    await page.keyboard.press('Enter');
    await delay(3000);

    log('INFO', '╔════════════════════════════════════╗');
    log('INFO', '║  ✅  MESSENGER: GỬI THÀNH CÔNG!   ║');
    log('INFO', '╚════════════════════════════════════╝');

    await tg(`✅ <b>Đã đăng Facebook!</b>\n\n<i>${esc(message.substring(0, 250))}...</i>`);
    await page.close();
    return true;

  } catch(err) {
    log('ERROR', `postToMessenger: ${err.message}`);
    await antigravitySelfFix(err.message, 'postToMessenger');
    return false;
  } finally {
    if (browser) { try { await browser.close(); } catch(e) {} }
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 12 — PENDING POSTS STORE
// ═══════════════════════════════════════════════════════════

const pendingPosts = new Map();
let isGenerating = false;
const makePendingKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);

async function generateAndQueue(reason = 'auto') {
  if (isGenerating) { await tg('⏳ Đang tạo bài rồi, đợi tí...'); return; }
  isGenerating = true;
  log('INFO', `📝 Tạo bài mới (${reason})...`);
  await tg(`🔄 <b>Đang tạo bài mới...</b>\nLý do: ${reason}`);

  try {
    const post = await generateSEOPost();
    if (!post) { await tg('❌ AI không tạo được bài! Kiểm tra 9Router.'); return; }

    let posterPath = null;
    try { posterPath = await createPoster(post); } catch(e) {}

    const key = makePendingKey();
    pendingPosts.set(key, { content: post, posterPath, ts: Date.now() });

    // Gửi poster lên Telegram nếu có
    if (posterPath) {
      await tgPhoto(posterPath, '🖼️ Preview poster bài viết');
    }

    // Gửi bài để duyệt
    await tgApproval(post, key);
    log('INFO', `📤 Bài ${key} đang chờ duyệt`);

    // Hết hạn sau 60 phút
    setTimeout(() => {
      if (pendingPosts.has(key)) {
        pendingPosts.delete(key);
        log('INFO', `🗑️ Bài ${key} hết hạn (60 phút)`);
      }
    }, 60 * 60 * 1000);

  } catch(err) {
    log('ERROR', `generateAndQueue: ${err.message}`);
    await antigravitySelfFix(err.message, 'generateAndQueue');
  } finally {
    isGenerating = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 13 — TELEGRAM COMMAND HANDLER
// ═══════════════════════════════════════════════════════════

const COMMANDS = {
  '/start'     : () => tg(`👋 <b>FB Auto-Bot v6.0 — Antigravity Edition</b>\n\nLuồng:\n  🔄 Antigravity AI tạo bài chuẩn SEO\n  📤 Gửi Telegram để bạn duyệt\n  ✅ Bấm → Tự đăng Facebook\n\n<b>Lệnh:</b>\n• <code>tạo bài</code> — Tạo & gửi duyệt ngay\n• <code>trending</code> — Top trending hiện tại\n• <code>upgrade</code> — Antigravity review & nâng cấp bot\n• <code>status</code> — Trạng thái bot\n• Câu hỏi tự do → Antigravity trả lời`),
  'tạo bài'   : () => generateAndQueue('lệnh Telegram'),
  'viết bài'  : () => generateAndQueue('lệnh Telegram'),
  'đăng bài'  : () => generateAndQueue('lệnh Telegram'),
  'chạy'      : () => generateAndQueue('lệnh Telegram'),
  'upgrade'   : () => antigravityAutoUpgrade(),
  'nâng cấp'  : () => antigravityAutoUpgrade(),
  'status'    : () => tg(
    `📋 <b>BOT STATUS v6.0</b>\n\n` +
    `✅ Antigravity AI: <b>Online</b>\n` +
    `📊 Bài đã đăng: ${postHistory.length}\n` +
    `📝 Đang chờ duyệt: ${pendingPosts.size}\n` +
    `🔧 Lần self-fix: ${selfFixCount}/${MAX_SELF_FIX}\n` +
    `⏱ Chu kỳ: ${config.intervalMinutes} phút\n` +
    `🕒 ${new Date().toLocaleString('vi-VN')}`
  ),
};

async function handleTgMessage(text) {
  const lower = text.toLowerCase().trim();

  // Kiểm tra exact command
  for (const [cmd, fn] of Object.entries(COMMANDS)) {
    if (lower === cmd || lower.startsWith(cmd)) return fn();
  }

  // Kiểm tra keyword
  if (['trending','hot','xu hướng'].some(k => lower.includes(k))) {
    const trending = await getAllTrending();
    return tg('📊 <b>TOP TRENDING HIỆN TẠI</b>\n\n' +
      trending.slice(0,8).map((t,i) => `${i+1}. <b>[${t.source}]</b> ${esc(t.title)}\n   ⭐ ${t.points} pts`).join('\n\n')
    );
  }

  // Câu hỏi tự do → Antigravity
  if (text.length > 3) {
    await tg('🤖 Antigravity đang trả lời...');
    const r = await callAI(text, { preferModel: 'Antigravity Pro' });
    if (r) return tg(`🤖 <b>${r.provider}</b>\n\n${esc(r.content.substring(0, 3500))}`);
    return tg('❌ AI không phản hồi!');
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 14 — TELEGRAM POLLING
// ═══════════════════════════════════════════════════════════

let lastUpdateId = 0;

async function pollTelegram() {
  if (!config.telegramToken) return;
  try {
    const resp = await tgCall('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 20,
      allowed_updates: ['message', 'callback_query']
    }, true);
    if (!resp?.ok || !resp.result?.length) return;

    for (const upd of resp.result) {
      lastUpdateId = upd.update_id;

      // Callback (nút bấm)
      if (upd.callback_query) {
        const cb     = upd.callback_query;
        const fromId = String(cb.from.id);
        if (fromId !== OWNER()) { await tgAnswerCb(cb.id, '⛔ Không có quyền'); continue; }

        const [action, key] = (cb.data || '').split(':');
        await tgAnswerCb(cb.id);

        // Upgrade callbacks
        if (action === 'upgrade') {
          if (key === 'apply' && pendingUpgrade) {
            await tgEditMsg(cb.message.chat.id, cb.message.message_id, '⏳ <b>Đang áp dụng upgrade...</b>');
            await applyUpgrade(pendingUpgrade.content);
            pendingUpgrade = null;
          } else if (key === 'skip') {
            pendingUpgrade = null;
            await tgEditMsg(cb.message.chat.id, cb.message.message_id, '❌ <b>Upgrade bị bỏ qua.</b>');
          }
          continue;
        }

        // Post callbacks
        if (!pendingPosts.has(key)) {
          await tgEditMsg(cb.message.chat.id, cb.message.message_id, '⚠️ <b>Bài đã hết hạn hoặc đã xử lý.</b>');
          continue;
        }

        const pending = pendingPosts.get(key);

        if (action === 'approve') {
          pendingPosts.delete(key);
          await tgEditMsg(cb.message.chat.id, cb.message.message_id,
            `⏳ <b>Đang đăng lên Facebook...</b>\n\n<i>${esc(pending.content.substring(0,200))}...</i>`
          );
          let sent = false;
          for (let i = 1; i <= 2; i++) {
            sent = await postToMessenger(pending.content, pending.posterPath);
            if (sent) break;
            if (i < 2) { await tg('⏳ Thử lại sau 20s...'); await delay(20000); }
          }
          if (!sent) await tg('❌ <b>Đăng Facebook thất bại!</b>');

        } else if (action === 'regen') {
          pendingPosts.delete(key);
          await tgEditMsg(cb.message.chat.id, cb.message.message_id, '🔄 <b>Đang viết lại bài...</b>');
          await generateAndQueue('viết lại');

        } else if (action === 'reject') {
          pendingPosts.delete(key);
          await tgEditMsg(cb.message.chat.id, cb.message.message_id, '❌ <b>Bài đã bị bỏ qua.</b>');
        }
        continue;
      }

      // Text message
      if (upd.message?.text) {
        const m      = upd.message;
        const fromId = String(m.from?.id || m.chat?.id);
        if (fromId !== OWNER()) continue;
        try { await handleTgMessage(m.text); }
        catch(e) {
          log('ERROR', `handleTgMessage: ${e.message}`);
          await tg(`❌ ${esc(e.message)}`);
        }
      }
    }
  } catch(e) {
    if (!e.message?.includes('timeout') && !e.message?.includes('ETIMEDOUT')) {
      log('WARN', `[Poll] ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  SECTION 15 — MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  🤖 FB AUTO-BOT v6.0 — ANTIGRAVITY EDITION              ║');
  console.log('║  ✅ Luồng: Trending → AI SEO → TG Duyệt → FB Post      ║');
  console.log('║  🛡️  Self-Fix: Antigravity tự sửa code khi lỗi          ║');
  console.log('║  🚀 Auto-Upgrade: Antigravity review & nâng cấp định kỳ ║');
  console.log(`║  ⏱  Chu kỳ: ${String(config.intervalMinutes + ' phút — Upgrade: ' + (config.autoUpgradeIntervalHours||12) + 'h').padEnd(45)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Khởi động
  await tg(
    `🚀 <b>FB AUTO-BOT v6.0 — ANTIGRAVITY EDITION</b>\n\n` +
    `🤖 AI: Antigravity Pro (primary)\n` +
    `✅ SEO Content: Bật\n` +
    `🛡️ Self-Fix: Bật (tối đa ${MAX_SELF_FIX} lần)\n` +
    `🚀 Auto-Upgrade: Mỗi ${config.autoUpgradeIntervalHours || 12}h\n` +
    `⏱ Tạo bài: Mỗi ${config.intervalMinutes} phút\n` +
    `🕒 ${new Date().toLocaleString('vi-VN')}\n\n` +
    `Lệnh: <code>tạo bài</code> | <code>upgrade</code> | <code>status</code>`
  );

  // Telegram polling — chạy liên tục
  log('INFO', '👂 Telegram polling ON');
  (async () => { while(true) { await pollTelegram(); await delay(800); } })().catch(e => log('ERROR', `Poll: ${e.message}`));

  // Lần chạy đầu tiên
  const first = (config.autoExecuteDelayMinutes || 2) * 60 * 1000;
  log('INFO', `⏳ Tạo bài đầu tiên sau ${config.autoExecuteDelayMinutes || 2} phút...`);
  setTimeout(() => generateAndQueue('auto - lần đầu'), first);

  // Chu kỳ đăng bài
  setInterval(() => generateAndQueue('auto - định kỳ'), config.intervalMinutes * 60 * 1000);

  // Auto-Upgrade định kỳ
  const upgradeInterval = (config.autoUpgradeIntervalHours || 12) * 60 * 60 * 1000;
  setInterval(antigravityAutoUpgrade, upgradeInterval);

  log('INFO', '✅ Bot sẵn sàng!');
}

// Global error handlers
process.on('uncaughtException',  async err => { log('ERROR', `💥 UNCAUGHT: ${err.message}`);   await antigravitySelfFix(err.message, 'uncaughtException'); });
process.on('unhandledRejection', async rsn => { log('ERROR', `💥 UNHANDLED: ${rsn}`);           await antigravitySelfFix(String(rsn), 'unhandledRejection'); });

main().catch(async err => {
  log('ERROR', `💥 MAIN CRASH: ${err.message}`);
  await tg(`💥 <b>BOT CRASH!</b>\n<pre>${esc(err.message)}</pre>`);
  if (config.autoRestart) autoRestart();
});
