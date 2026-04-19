/**
 * orchestrator/task-runner.js
 * ═══════════════════════════════════════════════════════════
 * Task Queue + Agent Runner
 * 
 * Luồng xử lý đúng kiểu agent-first:
 * 
 *  Task (từ Telegram / error handler / schedule)
 *      ↓
 *  PromptBuilder.buildPrompt(taskType, ctx)
 *      ↓
 *  callAI(prompt) → Antigravity Pro
 *      ↓
 *  parsePatches(response)
 *      ↓
 *  [confidence ≥ threshold?]
 *      ↓ YES              ↓ NO
 *  autoApply         pendingApproval → Telegram
 *      ↓
 *  GitSafetyGuard.applyPatch × N
 *      ↓
 *  syntaxCheck / testCmd
 *      ↓
 *  commit "post-patch"
 *      ↓
 *  TelegramReporter.report(result)
 *      ↓
 *  [restart nếu cần]
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { buildPrompt, parsePatches, WHITELIST, getTestCmd } = require('./prompt-builder');
const AgentMgr = require('./agent-manager');
const guard    = require('./git-safety-guard');
const { spawnSync } = require('child_process');
const path     = require('path');
const fs       = require('fs');

const ROOT     = path.join(__dirname, '..');

// ── DEPS (injected từ bot.js) ────────────────────────────────────
let _tg        = null;
let _tgRaw     = null;
let _restartFn = null;

function init({ tg, tgRaw, restartFn }) {
  _tg        = tg;
  _tgRaw     = tgRaw;
  _restartFn = restartFn;
  // AgentMgr không cần inject — tự đọc config.json
}

// ── PENDING TASKS (chờ approval) ────────────────────────────
const pendingTasks = new Map();

// ── VERIFIER ────────────────────────────────────────────────

function runTest(testCmd) {
  try {
    const [cmd, ...args] = testCmd.split(' ');
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    return { ok: r.status === 0, output: (r.stdout + r.stderr).trim().substring(0, 500) };
  } catch(e) {
    return { ok: false, output: e.message };
  }
}

// ── REPORT FORMATTER ────────────────────────────────────────

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function formatReport({ taskType, results, plan, testPlan, duration }) {
  const ok  = results.filter(r => r.ok);
  const bad = results.filter(r => !r.ok);

  const patchLines = results.map((r, i) => {
    if (r.type === 'cmd') return `${r.ok ? '✅' : '❌'} CMD: <code>${esc(r.cmd || '')}</code>`;
    return `${r.ok ? '✅' : '❌'} ${r.file || '?'} ${r.confidence ? `(${r.confidence}%)` : ''} ${r.rollback ? '→ ROLLED BACK' : ''}`;
  });

  return [
    `📋 <b>Task Report: ${taskType.toUpperCase()}</b>`,
    `✅ ${ok.length} OK  |  ❌ ${bad.length} FAIL  |  ⏱ ${duration}ms`,
    plan ? `\n📌 <b>Plan:</b>\n${esc(plan.substring(0, 400))}` : '',
    `\n<b>Patches:</b>\n${patchLines.join('\n')}`,
    bad.length > 0 ? `\n⚠️ <b>Errors:</b>\n${bad.map(r => esc(r.error || '')).join('\n')}` : '',
    testPlan ? `\n🧪 <b>Test plan:</b>\n${esc(testPlan.substring(0, 300))}` : '',
  ].filter(Boolean).join('\n');
}

// ── MAIN RUNNER ─────────────────────────────────────────────

/**
 * @param {string} taskType - loại task (fix_bug, upgrade, ...)
 * @param {object} ctx      - context
 * @param {object} opts     - override options
 */
async function runTask(taskType, ctx = {}, opts = {}) {
  const startTs = Date.now();
  const taskId  = `${taskType}_${Date.now().toString(36)}`;

  // 1. Build prompt
  let built;
  try {
    built = buildPrompt(taskType, ctx);
  } catch(e) {
    await _tg?.(`❌ PromptBuilder error: ${e.message}`);
    return { ok: false, error: e.message };
  }

  const { prompt, taskDef, testCmd, whitelist, targetFile } = built;
  const requireApproval = opts.requireApproval ?? taskDef.require_approval;
  const autoConf        = opts.autoApproveConf ?? taskDef.auto_approve_confidence;

  // Hiển thị agent sẽ dùng
  const agents      = AgentMgr.getAgentsForTask(taskType);
  const primaryAgent = agents[0];

  await _tg?.(
    `💼 <b>Task: ${taskType.toUpperCase()}</b>\n` +
    `${primaryAgent?.name || '❓ Unknown'}: ${primaryAgent?.role || ''}\n` +
    `📂 Target: <code>${targetFile}</code>\n` +
    `🕬 Test: <code>${testCmd}</code>\n` +
    `⏳ Đang gọi agent...`
  );

  // 2. Call đúng agent theo task type (AgentManager tự chọn model)
  const aiResult = await AgentMgr.callAgent(taskType, prompt, {
    temperature: opts.temperature,
    maxTokens  : opts.maxTokens,
  });

  if (!aiResult) {
    await _tg?.(`❌ Tất cả agents fail cho task: ${taskType}!`);
    return { ok: false, error: 'All agents failed' };
  }

  // 3. Parse response
  const { patches, plan, testPlan, noUpgrade } = parsePatches(aiResult.content);

  if (noUpgrade) {
    await _tg?.(`✅ <b>${taskType}</b>: Không cần thay đổi.\n\n${esc(aiResult.content.substring(0, 400))}`);
    return { ok: true, noChange: true };
  }

  if (patches.length === 0) {
    await _tg?.(
      `⚠️ <b>Không parse được patch.</b>\n\n` +
      `AI response:\n<pre>${esc(aiResult.content.substring(0, 600))}</pre>`
    );
    return { ok: false, error: 'No patches parsed' };
  }

  // Giới hạn số patch
  const maxPatches = opts.maxPatches ?? taskDef.max_patches ?? 3;
  const finalPatches = patches.slice(0, maxPatches);

  // Tính confidence trung bình
  const avgConf = Math.round(
    finalPatches.reduce((s, p) => s + (p.confidence || 70), 0) / finalPatches.length
  );

  // Tóm tắt patches
  const summary = finalPatches.map((p, i) =>
    p.type === 'cmd'
      ? `${i+1}. [CMD] <code>${esc(p.cmd.substring(0,80))}</code>`
      : `${i+1}. [PATCH] <b>${p.file}</b> conf=${p.confidence}%\n<code>${esc(p.find.substring(0,100))}</code>`
  ).join('\n');

  // 4. Approval decision
  const shouldAutoApply = !requireApproval || avgConf >= autoConf;

  if (!shouldAutoApply) {
    // Lưu pending, gửi Telegram để duyệt
    pendingTasks.set(taskId, { taskType, patches: finalPatches, plan, testPlan, testCmd, whitelist, targetFile, ctx });

    await _tgRaw?.({
      text:
        `🔧 <b>Agent đề xuất — Chờ Duyệt</b>\n\n` +
        `Task: <b>${taskType}</b>  |  Confidence: <b>${avgConf}%</b>\n\n` +
        (plan ? `📌 Kế hoạch:\n${esc(plan.substring(0,300))}\n\n` : '') +
        `🔧 Patches (${finalPatches.length}):\n${summary}\n\n` +
        `<i>Chọn hành động:</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Áp dụng',   callback_data: `task_apply:${taskId}` },
          { text: '👁 Xem code',  callback_data: `task_preview:${taskId}` },
          { text: '❌ Bỏ qua',    callback_data: `task_skip:${taskId}` }
        ]]
      }
    });

    return { ok: true, pending: true, taskId };
  }

  // 5. Auto-apply
  await _tg?.(
    `🚀 <b>Auto-apply</b> (${avgConf}% confidence ≥ ${autoConf}%)\n\n` +
    (plan ? `📌 ${esc(plan.substring(0,200))}\n\n` : '') +
    `Patches: ${finalPatches.length}`
  );

  return await _executePatchSet({ taskType, patches: finalPatches, plan, testPlan, testCmd, whitelist, targetFile, taskId, startTs });
}

// ── EXECUTE PATCH SET ───────────────────────────────────────

async function _executePatchSet({ taskType, patches, plan, testPlan, testCmd, whitelist, targetFile, taskId, startTs }) {
  const results = [];

  for (const patch of patches) {
    const r = guard.applyPatch(patch, { whitelist, patchId: taskId, taskType });
    results.push(r);
    if (!r.ok && patch.type === 'file') {
      // Dừng nếu file patch fail (cmd fail thì tiếp)
      break;
    }
  }

  // Run test nếu có JS patch success
  const hasFilePatch = results.some(r => r.ok && r.file);
  let testResult     = null;
  if (hasFilePatch && testCmd) {
    testResult = runTest(testCmd);
    if (!testResult.ok) {
      // Test fail → rollback tất cả file patches
      await _tg?.(`❌ <b>Test fail!</b> Đang rollback...\n<pre>${esc(testResult.output)}</pre>`);
      for (const r of results) {
        if (r.ok && r.file) guard.fileRollback(r.file);
      }
      results.forEach(r => { if (r.file) r.rollback = true; r.ok = false; });
    }
  }

  const duration = Date.now() - (startTs || Date.now());
  const report   = formatReport({ taskType, results, plan, testPlan, duration });

  await _tg?.(report);

  // Restart nếu cần (có patch thành công vào bot.js)
  const patchedCore = results.some(r => r.ok && r.file === 'bot.js');
  if (patchedCore && testResult?.ok !== false) {
    await _tg?.('🔄 <b>Restart bot sau khi patch...</b>');
    setTimeout(() => _restartFn?.(), 2500);
  }

  return { ok: results.some(r => r.ok), results, testResult };
}

// ── HANDLE APPROVAL CALLBACK ────────────────────────────────

async function handleCallback(action, taskId) {
  const task = pendingTasks.get(taskId);
  if (!task) { await _tg?.('⚠️ Task đã hết hạn hoặc đã xử lý!'); return; }

  if (action === 'task_apply') {
    pendingTasks.delete(taskId);
    await _tg?.('⏳ <b>Đang áp dụng patches...</b>');
    await _executePatchSet({ ...task, taskId, startTs: Date.now() });

  } else if (action === 'task_preview') {
    const preview = task.patches.map((p, i) =>
      p.type === 'cmd'
        ? `[${i+1}] CMD: ${p.cmd}`
        : `[${i+1}] ${p.file}:\nFIND: ${p.find.substring(0,300)}\nREPLACE: ${p.replace.substring(0,300)}`
    ).join('\n\n---\n\n');
    await _tg?.(`📄 <b>Code Preview</b>\n\n<pre>${esc(preview.substring(0, 3500))}</pre>`);

  } else if (action === 'task_skip') {
    pendingTasks.delete(taskId);
    await _tg?.('❌ Task bị bỏ qua. Không có thay đổi.');
  }
}

module.exports = {
  init,
  runTask,
  handleCallback,
  pendingTasks,
};
