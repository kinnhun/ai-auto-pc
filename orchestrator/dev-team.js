/**
 * orchestrator/dev-team.js
 * ═══════════════════════════════════════════════════════════
 * 🏢 DEV TEAM COORDINATOR — Điều phối toàn bộ đội dev
 * 
 * Đây là entry point chính. Bot.js gọi DevTeam.*
 * DevTeam điều phối sang đúng module:
 *   - Code tasks → AgentManager → AI models
 *   - PC tasks → ComputerController
 *   - Claude tasks → ClaudeCodeRunner
 * 
 * TEAM ROSTER:
 *   🧠 Senior Dev        — fix bug
 *   🔍 Code Reviewer     — review, upgrade
 *   ✍️  Content Writer    — Facebook content
 *   📊 Trend Analyst     — trending analysis
 *   🖥️  PC Controller     — machine automation
 *   ⚡ Claude Coder      — full codebase edits
 *   🔧 Backup Dev        — fallback
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const AgentMgr    = require('./agent-manager');
const PC          = require('./computer-controller');
const Claude      = require('./claude-code-runner');
const TaskRunner  = require('./task-runner');
const guard       = require('./git-safety-guard');
const path        = require('path');
const fs          = require('fs');

const ROOT = path.join(__dirname, '..');

// ── DEPS ────────────────────────────────────────────────────
let _tg        = null;
let _tgRaw     = null;
let _tgPhoto   = null;
let _restartFn = null;

function init({ tg, tgPhoto, restartFn, tgRaw }) {
  _tg        = tg;
  _tgRaw     = tgRaw || tg;
  _tgPhoto   = tgPhoto;
  _restartFn = restartFn;

  // Init TaskRunner
  TaskRunner.init({ tg, tgRaw: _tgRaw, restartFn });
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── PC TASK EXECUTOR ────────────────────────────────────────
/**
 * Luồng PC task đầy đủ:
 *   1. Screenshot "before"
 *   2. Gửi TG + hỏi AI phải làm gì
 *   3. AI phân tích màn hình → đề xuất [ACTION]
 *   4. Hỏi approval nếu cần
 *   5. Thực thi actions
 *   6. Screenshot "after" → báo cáo
 */
async function runPCTask(instruction, opts = {}) {
  const { requireApproval = true } = opts;

  await _tg?.(`🖥️ <b>PC Controller</b>\n📋 Task: ${esc(instruction)}\n⏳ Chụp màn hình...`);

  // 1. Screenshot before
  const beforeShot = await PC.screenshot('before_task');
  if (beforeShot) await _tgPhoto?.(beforeShot, '📸 Màn hình hiện tại');

  // 2. Build prompt với màn hình
  const screenInfo = await PC.getScreenInfo();
  const prompt = `Bạn là PC Controller agent. Nhìn vào thông tin màn hình bên dưới và thực thi task.

THÔNG TIN MÀN HÌNH:
${screenInfo.output || 'Không lấy được'}

TASK:
${instruction}

OUTPUT FORMAT — Chỉ được output các [ACTION] theo format này:
[ACTION type="screenshot"]
[ACTION type="click" x="<số>" y="<số>" button="left|right"]
[ACTION type="type" text="<nội dung>"]
[ACTION type="hotkey" combo="<ctrl+s|alt+f4|...>"]
[ACTION type="run" cmd="<lệnh shell>"]
[ACTION type="openapp" app="<tên app>" args="<args>"]
[ACTION type="focus" title="<tên cửa sổ>"]

RULES:
- Nếu yêu cầu MỞ HOẶC TRUY CẬP WEBSITE (vd: Facebook, YouTube), hãy dùng: [ACTION type="openapp" app="chrome" args="https://facebook.com"]
- Chỉ làm đúng task được giao
- Không mở app không liên quan
- Không chạy lệnh nguy hiểm (rm, del, format)
- Nếu không chắc, hãy tạo kế hoạch an toàn.

PLAN:
[viết kế hoạch ngắn trước khi action]`;

  const aiResult = await AgentMgr.callAgent('pc_screenshot', prompt);
  if (!aiResult) {
    await _tg?.('❌ PC Controller AI không phản hồi!');
    return;
  }

  // Extract plan
  const plan = aiResult.content.match(/PLAN:\s*([\s\S]*?)(?=\[ACTION|$)/i)?.[1]?.trim();

  // Parse actions
  const actionCount = (aiResult.content.match(/\[ACTION/gi) || []).length;

  if (requireApproval && actionCount > 0) {
    // Gửi preview + hỏi duyệt
    const taskId = `pc_${Date.now().toString(36)}`;
    pendingPCTasks.set(taskId, { aiText: aiResult.content, instruction });

    await _tgRaw?.({
      text: `🖥️ <b>PC Controller — Chờ Duyệt</b>\n\n` +
        `📋 Task: ${esc(instruction)}\n\n` +
        (plan ? `📌 Kế hoạch:\n${esc(plan.substring(0,300))}\n\n` : '') +
        `⚙️ Số actions: ${actionCount}\n` +
        `\n<i>Duyệt để thực thi:</i>`,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Thực thi', callback_data: `pc_exec:${taskId}` },
          { text: '👁 Xem chi tiết', callback_data: `pc_preview:${taskId}` },
          { text: '❌ Hủy', callback_data: `pc_cancel:${taskId}` }
        ]]
      }
    });
    return;
  }

  // Auto-execute
  await _executePCActions(aiResult.content, instruction);
}

const { SessionMap } = require('../modules/session-db');
const pendingPCTasks = new SessionMap('pendingPCTasks');

async function _executePCActions(aiText, label) {
  const results = await PC.executeAIActions(aiText, async (shotFile, caption) => {
    if (_tgPhoto && shotFile) await _tgPhoto(shotFile, caption);
  });

  const ok  = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok).length;
  const summary = results.map((r,i) =>
    `${r.ok ? '✅' : '❌'} [${r.type}] ${r.output ? r.output.substring(0,100) : r.error || ''}`
  ).join('\n');

  await _tg?.(
    `📋 <b>PC Task Report</b>\n` +
    `✅ ${ok} OK  |  ❌ ${bad} fail\n\n` +
    `<pre>${esc(summary.substring(0,1500))}</pre>`
  );
}

// ── CLAUDE CODE TASK ────────────────────────────────────────
async function runClaudeTask(task, opts = {}) {
  // Kiểm tra Claude Code có sẵn không
  if (!Claude.isAvailable()) {
    await _tg?.(Claude.getInstallInstructions());
    return;
  }

  await _tg?.(`⚡ <b>Claude Coder</b>\n📋 Task: ${esc(task.substring(0,200))}\n⏳ Đang chạy...`);

  // Git backup trước
  const hash = guard.gitCommit(`pre-claude: ${task.substring(0,50)}`);

  const result = await Claude.runTask(task, {
    onOutput: async (chunk) => {
      // Stream output ra Telegram mỗi 500 chars
      if (chunk.length > 50) {
        await _tg?.(`🔄 <pre>${esc(chunk.substring(0,500))}</pre>`).catch(()=>{});
      }
    }
  });

  if (result.ok) {
    guard.gitCommit(`post-claude: ${task.substring(0,50)}`);
    await _tg?.(`✅ <b>Claude Coder hoàn thành!</b>\n\n<pre>${esc(result.output.substring(0,2000))}</pre>`);
  } else {
    // Rollback nếu fail
    if (hash) guard.gitRollback(hash);
    await _tg?.(`❌ <b>Claude Coder thất bại</b>\n<pre>${esc(result.error || result.output || '')}</pre>\n🔄 Đã rollback!`);
  }
}

// ── TELEGRAM CALLBACK HANDLER ────────────────────────────────
async function handleCallback(action, key) {
  // Task Runner callbacks
  if (['task_apply', 'task_preview', 'task_skip'].includes(action)) {
    return TaskRunner.handleCallback(action, key);
  }

  // PC Controller callbacks
  if (action === 'pc_exec') {
    const task = pendingPCTasks.get(key);
    if (!task) { await _tg?.('⚠️ Task đã hết hạn!'); return; }
    pendingPCTasks.delete(key);
    await _tg?.('⏳ <b>Đang thực thi...</b>');
    await _executePCActions(task.aiText, task.instruction);

  } else if (action === 'pc_preview') {
    const task = pendingPCTasks.get(key);
    if (!task) { await _tg?.('⚠️ Task đã hết hạn!'); return; }
    // Trích các action ra preview
    const preview = [...task.aiText.matchAll(/\[ACTION[^\]]+\]/gi)]
      .map((m,i) => `${i+1}. ${m[0]}`)
      .join('\n');
    await _tg?.(`👁 <b>Actions Preview</b>\n\n<code>${esc(preview || 'Không có action')}</code>`);

  } else if (action === 'pc_cancel') {
    pendingPCTasks.delete(key);
    await _tg?.('❌ PC task đã hủy.');
  }
}

// ── TEAM STATUS ─────────────────────────────────────────────
async function getTeamStatus() {
  const claudeOk  = Claude.isAvailable();
  const screenOk  = await PC.getScreenInfo().then(r => r.ok).catch(()=>false);

  const lines = [
    `🏢 <b>DEV TEAM STATUS</b>`,
    ``,
    `🧠 Senior Dev     — Antigravity Pro  ✅`,
    `🔍 Code Reviewer  — Codex            ✅`,
    `✍️  Content Writer — AG Flash          ✅`,
    `📊 Trend Analyst  — AG Flash          ✅`,
    `🖥️  PC Controller  — PowerShell       ${screenOk ? '✅' : '⚠️'}`,
    `⚡ Claude Coder   — Claude CLI       ${claudeOk ? '✅' : '❌ Chưa cài'}`,
    `🔧 Backup Dev     — Codex High       ✅`,
    ``,
    claudeOk ? '' : `⚡ Cài Claude Code:\n<code>npm install -g @anthropic-ai/claude-code</code>`,
  ].filter(l => l !== undefined).join('\n');

  return lines;
}

module.exports = {
  init,
  runPCTask,
  runClaudeTask,
  handleCallback,
  getTeamStatus,
  pendingPCTasks,
};
