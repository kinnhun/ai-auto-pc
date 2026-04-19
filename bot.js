/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  FB AUTO-BOT v6.1 — Powered by Antigravity AI              ║
 * ╠══════════════════════════════════════════════════════════════╣
 * ║  LUỒNG XỬ LÝ:                                              ║
 * ║  1. Thu thập trending (HN + DevTo + Reddit)                 ║
 * ║  2. Antigravity AI → tạo bài chuẩn SEO (3-step chain)      ║
 * ║  3. Generate poster HTML→PNG                                ║
 * ║  4. Gửi Telegram → User DUYỆT (inline keyboard)            ║
 * ║  5. Bấm ✅ → Puppeteer post lên Facebook Messenger          ║
 * ║  6. Lỗi → modules/self-heal.js:                            ║
 * ║       • Git backup (rollback point)                         ║
 * ║       • AI phân tích + sinh patch                           ║
 * ║       • Whitelist check                                     ║
 * ║       • Apply patch + syntax check                          ║
 * ║       • Rollback nếu fail                                   ║
 * ║       • Approval qua Telegram                               ║
 * ║       • Diff log + báo cáo                                  ║
 * ║  7. Mỗi 12h → Antigravity auto-upgrade (user duyệt)        ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const puppeteer = require('puppeteer');
const axios     = require('axios');
const fs        = require('fs');
const path      = require('path');
const { execSync, spawn } = require('child_process');
const SelfHeal  = require('./modules/self-heal');
const AgentMgr  = require('./orchestrator/agent-manager');
const DevTeam   = require('./orchestrator/dev-team');
const Router    = require('./orchestrator/message-router');

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

// ═══════════════════════════════════════════════════════════
//  SECTION 0 — CLI ARGS + FEATURE TOGGLES
// ═══════════════════════════════════════════════════════════

// Parse CLI args: node bot.js --no-autopost --no-upgrade --dry-run
const ARGS = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    })
);

// Feature toggles — có thể bật/tắt qua Telegram hoặc CLI
const FEATURES = {
  autoPost   : ARGS['no-autopost']  ? false : true,  // Tự động tạo bài định kỳ
  autoUpgrade: ARGS['no-upgrade']   ? false : true,  // Tự động upgrade code
  selfHeal   : ARGS['no-selfheal']  ? false : true,  // Tự động sửa lỗi
  pcControl  : ARGS['no-pc']        ? false : true,  // PC Controller
  postToFB   : ARGS['no-fb']        ? false : true,  // Đăng lên Facebook
  tgApproval : ARGS['no-approval']  ? false : true,  // Hỏi duyệt qua Telegram
  dryRun     : ARGS['dry-run']      ? true  : false, // Dry-run (không thực thi)
};

const CLI_MODE = !!ARGS['cli']; // node bot.js --cli → chỉ chạy 1 lần theo lệnh

function saveFeatures() {
  try {
    const cfg = loadConfig();
    cfg._features = FEATURES;
    fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  } catch(e) {}
}

function featureStatus() {
  const icon = (on) => on ? '🟢' : '🔴';
  return [
    `⚙️ <b>FEATURE TOGGLES</b>`,
    ``,
    `${icon(FEATURES.autoPost)}    autopost   — Tự động tạo bài`,
    `${icon(FEATURES.autoUpgrade)} upgrade    — Tự động nâng cấp code`,
    `${icon(FEATURES.selfHeal)}    selfheal   — Tự sửa lỗi`,
    `${icon(FEATURES.pcControl)}   pc         — PC Controller`,
    `${icon(FEATURES.postToFB)}    postfb     — Đăng lên Facebook`,
    `${icon(FEATURES.tgApproval)}  approval   — Hỏi duyệt qua Telegram`,
    `${icon(FEATURES.dryRun)}      dryrun     — Dry-run mode`,
    ``,
    `Bật: <code>on autopost</code>  |  Tắt: <code>off autopost</code>`,
  ].join('\n');
}


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
//  SECTION 5 — ANTIGRAVITY SELF-HEAL (via modules/self-heal.js)
// ═══════════════════════════════════════════════════════════
// Self-heal được tách ra modules/self-heal.js với đầy đủ safety:
//   • Whitelist file được phép sửa
//   • Git backup trước mỗi patch
//   • Syntax check sau mỗi patch
//   • Diff log (heal_log/)
//   • Rollback tự động nếu fail
//   • Approval qua Telegram
//
// Khởi tạo module sau khi tg() và callAI() đã sẵn sàng
function initSelfHeal() {
  const TaskRunner = require('./orchestrator/task-runner');

  // tgSimple: gửi text
  const tgSimple = async (text) =>
    tgCall('sendMessage', { chat_id: OWNER(), text, parse_mode: 'HTML' });

  // tgRaw: gửi object (hỗ trợ inline keyboard, caption, ...)
  const tgRaw = async (payload) => {
    if (typeof payload === 'string') return tgSimple(payload);
    return tgCall('sendMessage', { chat_id: OWNER(), parse_mode: 'HTML', ...payload });
  };

  SelfHeal.init({
    tg        : tgRaw,
    callAI,             // self-heal giữ callAI để fallback
    restartFn : autoRestart,
  });

  // Init DevTeam (bao gồm TaskRunner + PC + Claude)
  DevTeam.init({
    tg        : tgSimple,
    tgPhoto   : tgPhoto,    // gửi ảnh lên TG
    tgRaw,
    restartFn : autoRestart,
  });

  log('INFO', `✅ Agents: ${Object.values(AgentMgr.registry.agents).map(a=>a.name).join(' | ')}`);
}

// Shorthand gọi từ các error handler
// LOCK: chống gọi trùng lặp khi nhiều error cùng lúc
let _selfFixBusy = false;
let _selfFixLast = 0;
const SELF_FIX_COOLDOWN_MS = 15000; // 15s cooldown giữa các lần fix

async function antigravitySelfFix(errorMsg, context) {
  const now = Date.now();
  if (_selfFixBusy || (now - _selfFixLast) < SELF_FIX_COOLDOWN_MS) {
    log('WARN', `[SelfFix] Đang bận hoặc cooldown — bỏ qua (context: ${context})`);
    return;
  }
  _selfFixBusy = true;
  _selfFixLast = now;
  try {
    return await SelfHeal.selfHeal(errorMsg, context, { restartFn: autoRestart });
  } finally {
    _selfFixBusy = false;
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

  // Bước 1: TREND_ANALYST chọn chủ đề
  log('INFO', '🤖 [TREND_ANALYST] Chọn chủ đề hot nhất...');
  const step1 = await AgentMgr.callAgent('analyze_trend', step1Prompt, { temperature: 0.6 });
  if (!step1) { log('WARN', 'TREND_ANALYST thất bại, tiếp tục...'); }

  const finalPrompt = step1
    ? `Chủ đề được chọn: ${step1.content}\n\n${step2Prompt}`
    : step2Prompt;

  // Bước 2: CONTENT_WRITER viết bài chuẩn SEO
  log('INFO', '✍️ [CONTENT_WRITER] Viết bài chuẩn SEO...');
  const result = await AgentMgr.callAgent('write_content', finalPrompt, { temperature: 0.85 });

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
      puppeteerArgs: {
        executablePath: findBrowser() || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }
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
  if (!execPath) {
    throw new Error('Không tìm thấy Chrome/Edge trên máy! Cài Chrome hoặc kiểm tra đường dẫn.');
  }

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: SESSION_DIR,
    executablePath: execPath,
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

  // Chờ browser khởi động xong trước khi lấy pages
  await delay(1500);

  let page;
  try {
    const pages = await browser.pages();
    page = pages.length > 0 ? pages[0] : await browser.newPage();
  } catch(e) {
    log('WARN', `pages() lỗi: ${e.message} — thử newPage()`);
    page = await browser.newPage();
  }

  if (!page) throw new Error('Unable to get browser page');

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3] });
  });

  log('INFO', `🌐 Browser launched: ${execPath.split('\\').pop()}`);
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
  'upgrade'   : () => FEATURES.autoUpgrade ? antigravityAutoUpgrade() : tg('🔴 autoUpgrade đang tắt. Dùng <code>on upgrade</code> để bật'),
  'nâng cấp'  : () => FEATURES.autoUpgrade ? antigravityAutoUpgrade() : tg('🔴 autoUpgrade đang tắt'),
  'agents'    : () => tg(`📋 <b>AGENT REGISTRY</b>\n\n${AgentMgr.getStatusReport()}`),
  'team'      : async () => tg(await DevTeam.getTeamStatus()),
  'features'  : () => tg(featureStatus()),
  'toggles'   : () => tg(featureStatus()),
  'status'    : () => tg(
    `📋 <b>BOT STATUS v6.2 — Dev Team Edition</b>\n\n` +
    `🏢 Team: ${Object.values(AgentMgr.registry.agents).map(a=>a.emoji||'🤖').join('')}\n` +
    `📊 Bài đã đăng: ${postHistory.length}\n` +
    `📝 Đang chờ duyệt: ${pendingPosts.size}\n` +
    `🛡️ Self-Heal fixes: ${SelfHeal.getFixCount()}/${SelfHeal.HEAL_CONFIG.maxFixPerSession}\n` +
    `⏱ Chu kỳ: ${config.intervalMinutes} phút\n` +
    `🕒 ${new Date().toLocaleString('vi-VN')}\n\n` +
    `Lệnh: <code>pc <việc></code> | <code>claude <việc></code> | <code>features</code>`
  ),
};

async function handleTgMessage(text) {
  const lower = text.toLowerCase().trim();

  // 1. Kiểm tra Toggle Bật/Tắt
  const onM  = lower.match(/^(on|bật|bat)\s+(\w+)/);
  const offM = lower.match(/^(off|tắt|tat)\s+(\w+)/);
  const FEAT_ALIAS = {
    autopost: 'autoPost', 'auto-post': 'autoPost', 'tạo bài': 'autoPost',
    upgrade: 'autoUpgrade', 'nâng cấp': 'autoUpgrade',
    selfheal: 'selfHeal', 'self-heal': 'selfHeal', 'tự sửa': 'selfHeal',
    pc: 'pcControl', 'pc controller': 'pcControl',
    postfb: 'postToFB', facebook: 'postToFB',
    approval: 'tgApproval', 'duyệt': 'tgApproval',
    dryrun: 'dryRun', 'dry-run': 'dryRun', 'thử': 'dryRun',
  };

  if (onM || offM) {
    const [, , rawKey] = (onM || offM);
    const feat = FEAT_ALIAS[rawKey] || rawKey;
    if (feat in FEATURES) {
      FEATURES[feat] = !!onM;
      saveFeatures();
      return tg(`${onM ? '🟢' : '🔴'} <b>${feat}</b> đã ${onM ? 'BẬT' : 'TẮT'}\n\n${featureStatus()}`);
    } else {
      return tg(`⚠️ Feature không hợp lệ: <code>${rawKey}</code>\n\nDùng: <code>features</code> để xem danh sách`);
    }
  }

  // 2. Route message thông qua orchestrator/message-router.js
  const route = Router.route(text);
  if (!route) {
    return tg('❓ Lệnh không rõ ràng. Nhắn <code>help</code> để xem danh sách.');
  }

  log('INFO', `[Router] Matched route: ${route.agent}`);

  // 3. Điều phối theo Agent
  if (route.agent === 'SYSTEM') {
    if (lower === '/start' || lower === 'help') return COMMANDS['/start']();
    if (lower === 'status' || lower === 'trạng thái') return COMMANDS['status']();
    if (lower === 'features' || lower === 'toggles' || lower === 'cài đặt') return COMMANDS['features']();
    if (lower === 'agents' || lower === 'team') return COMMANDS['team']();
  } 
  
  else if (route.agent === 'PC_CONTROLLER') {
    if (!FEATURES.pcControl) return tg('🔴 PC Controller đang tắt. Gõ `on pc` để bật.');
    // Gửi toàn bộ text để AI tự phân tích ra action
    return DevTeam.runPCTask(text);
  } 
  
  else if (route.agent === 'CLAUDE_CODER') {
    const taskContent = text.replace(/^(claude|refactor|tái cấu trúc)\s+/i, '').trim();
    return DevTeam.runClaudeTask(taskContent);
  } 
  
  else if (route.agent === 'CONTENT_WRITER') {
    return generateAndQueue('lệnh Telegram');
  } 
  
  else if (route.agent === 'TREND_ANALYST') {
    const trending = await getAllTrending();
    return tg('📊 <b>TOP TRENDING HIỆN TẠI</b>\n\n' +
      trending.slice(0,8).map((t,i) => `${i+1}. <b>[${t.source}]</b> ${esc(t.title)}\n   ⭐ ${t.points} pts`).join('\n\n')
    );
  } 
  
  else if (route.agent === 'LEARNING_AGENT') {
    const memory = require('./orchestrator/memory');
    const input = text.replace(/^(nhớ|ghi nhớ|học|lưu ý|tự học)\s+/i, '').trim();
    await tg('🧠 Đang trích xuất bài học để ghi nhớ...');
    
    const prompt = `Bạn là Memory Agent. Phân tích feedback này của Boss và tóm tắt thành 1-2 câu kinh nghiệm cốt lõi để các AI khác học hỏi.\nFeedback: "${input}"\nChỉ trả về nội dung đúc kết, không thưa gửi gì thêm.`;
    const r = await AgentMgr.callAgent('extract_insight', prompt);
    
    if (r) {
      memory.learn(r.content.trim(), 'User Feedback');
      return tg(`✅ <b>Đã ghi nhớ:</b>\n<i>${esc(r.content)}</i>\n\nTừ nay toàn bộ đội ngũ AI sẽ tuân thủ nguyên tắc này khi nhận lệnh!`);
    } else {
      return tg('❌ Bận xíu r, chưa nhớ được!');
    }
  }

  else if (route.agent === 'CODE_REVIEWER') {
    return FEATURES.autoUpgrade ? antigravityAutoUpgrade() : tg('🔴 autoUpgrade đang tắt.');
  } 
  
  else if (route.agent === 'SENIOR_DEV') {
    await tg('🤖 (Thư ký AI) Đang suy nghĩ...');
    // Gọi bot trò chuyện / fix bug general
    const r = await AgentMgr.callAgent('fix_bug', text, { temperature: 0.5, maxTokens: 1000 });
    if (r) return tg(`${r.agentName}\n\n${esc(r.content.substring(0, 3500))}`);
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
        // Route tất cả callbacks qua DevTeam
        const devCallbacks = ['task_apply','task_preview','task_skip','pc_exec','pc_preview','pc_cancel'];
        if (devCallbacks.includes(action)) {
          await tgAnswerCb(cb.id);
          await DevTeam.handleCallback(action, key);
          continue;
        }

        // [1] Self-heal approval
        if (['heal_apply', 'heal_diff', 'heal_skip'].includes(action)) {
          await tgAnswerCb(cb.id);
          await SelfHeal.handleCallback(action, key, autoRestart);
          continue;
        }

        // [3] Upgrade callbacks
        if (action === 'upgrade') {
          await tgAnswerCb(cb.id);
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
  const mode = CLI_MODE ? 'CLI' : 'DAEMON';

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  🤖 FB AUTO-BOT v6.2 — DEV TEAM EDITION                 ║');
  console.log(`║  Mode: ${mode.padEnd(50)}║`);
  console.log(`║  autoPost:  ${String(FEATURES.autoPost).padEnd(48)}║`);
  console.log(`║  dryRun:    ${String(FEATURES.dryRun).padEnd(48)}║`);
  console.log(`║  CLI flags: ${Object.keys(ARGS).join(', ').padEnd(48).substring(0,48)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Khởi động modules
  initSelfHeal();

  await tg(
    `🚀 <b>FB AUTO-BOT v6.2 — DEV TEAM EDITION</b>\n\n` +
    `🏢 Team: 🧠 🔍 ✍️ 📊 🖥️ ⚡ 🔧\n` +
    `📋 Mode: <b>${mode}</b>\n` +
    featureStatus() + '\n\n' +
    `<b>CLI:</b>\n` +
    `<code>node bot.js</code>                  — chạy đầy đủ\n` +
    `<code>node bot.js --no-autopost</code>    — không tự đăng bài\n` +
    `<code>node bot.js --no-upgrade</code>     — không tự upgrade\n` +
    `<code>node bot.js --dry-run</code>        — thử nghiệm không làm thật\n` +
    `<code>node bot.js --cli</code>            — chờ lệnh thủ công`
  );

  // Telegram polling — luôn bật dù mode nào
  log('INFO', '👂 Telegram polling ON');
  (async () => { while(true) { await pollTelegram(); await delay(800); } })().catch(e => log('ERROR', `Poll: ${e.message}`));

  if (CLI_MODE) {
    // CLI mode: chỉ lắng nghe lệnh, không tự chạy schedule
    log('INFO', '⌨️  CLI mode — Chờ lệnh từ Telegram...');
    log('INFO', '   Dùng lệnh: tạo bài | upgrade | pc <việc> | claude <việc>');
  } else {
    // DAEMON mode: chạy tự động theo schedule
    if (FEATURES.autoPost) {
      const first = (config.autoExecuteDelayMinutes || 2) * 60 * 1000;
      log('INFO', `⏳ Tạo bài đầu tiên sau ${config.autoExecuteDelayMinutes || 2} phút...`);
      setTimeout(() => {
        if (FEATURES.autoPost) generateAndQueue('auto - lần đầu');
      }, first);
      setInterval(() => {
        if (FEATURES.autoPost) generateAndQueue('auto - định kỳ');
      }, config.intervalMinutes * 60 * 1000);
    } else {
      log('INFO', '🔴 autoPost TẮT — không tự tạo bài. Dùng lệnh "tạo bài" hoặc "on autopost"');
    }

    if (FEATURES.autoUpgrade) {
      const upgradeInterval = (config.autoUpgradeIntervalHours || 12) * 60 * 60 * 1000;
      setInterval(() => {
        if (FEATURES.autoUpgrade) antigravityAutoUpgrade();
      }, upgradeInterval);
    }
  }

  log('INFO', '✅ Bot sẵn sàng!');
}

// Global error handlers
process.on('uncaughtException',  async err => {
  log('ERROR', `💥 UNCAUGHT: ${err.message}`);
  if (FEATURES.selfHeal) await antigravitySelfFix(err.message, 'uncaughtException');
});
process.on('unhandledRejection', async rsn => {
  log('ERROR', `💥 UNHANDLED: ${rsn}`);
  if (FEATURES.selfHeal) await antigravitySelfFix(String(rsn), 'unhandledRejection');
});

main().catch(async err => {
  log('ERROR', `💥 MAIN CRASH: ${err.message}`);
  await tg(`💥 <b>BOT CRASH!</b>\n<pre>${esc(err.message)}</pre>`);
  if (config.autoRestart) autoRestart();
});
