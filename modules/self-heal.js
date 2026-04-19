/**
 * modules/self-heal.js
 * ═══════════════════════════════════════════════════════════
 * Antigravity Self-Heal — thin wrapper trên TaskRunner
 * 
 * Tất cả logic nặng (prompt build, safety, git, diff)
 * đã được tách vào orchestrator/*.
 * Module này chỉ làm:
 *   1. Phân loại lỗi → task type phù hợp
 *   2. Gọi TaskRunner.runTask()
 *   3. Quản lý fix count / lock
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const TaskRunner = require('../orchestrator/task-runner');
const { WHITELIST } = require('../orchestrator/prompt-builder');

const ROOT      = path.join(__dirname, '..');
const ERROR_LOG = path.join(ROOT, 'error_history.json');

// ── CONFIG ─────────────────────────────────────────────────
const HEAL_CONFIG = {
  maxFixPerSession        : 5,
  requireApproval         : true,
  autoApproveIfConfident  : 90,
  healLogDir              : path.join(ROOT, 'heal_log'),
  writableFiles           : WHITELIST,
};

if (!fs.existsSync(HEAL_CONFIG.healLogDir)) {
  fs.mkdirSync(HEAL_CONFIG.healLogDir, { recursive: true });
}

// ── STATE ──────────────────────────────────────────────────
let fixCount = 0;
let healLock = false;

// ── ERROR CLASSIFIER ───────────────────────────────────────
/**
 * Phân loại lỗi → task type phù hợp
 * Thay vì dùng 1 prompt generic, dùng đúng template
 */
function classifyError(errorMsg, context) {
  const msg = `${errorMsg} ${context}`.toLowerCase();

  if (msg.includes('telegram') || msg.includes('chat_id') || msg.includes('bot token') || msg.includes('tgcall')) {
    return 'fix_telegram';
  }
  if (msg.includes('selector') || msg.includes('waitforselector') || msg.includes('puppeteer') || msg.includes('messenger') || msg.includes('chatbox')) {
    return 'fix_selector';
  }
  return 'fix_bug'; // default
}

// ── LOAD ERROR HISTORY ─────────────────────────────────────
function loadErrorHistory() {
  try { return JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); }
  catch(e) { return []; }
}

// ── INIT ────────────────────────────────────────────────────
function init({ tg, callAI, restartFn }) {
  // TaskRunner cần tgRaw (cho inline keyboard)
  TaskRunner.init({
    callAI,
    tg,
    tgRaw: tg,     // bot.js inject tgRaw qua initSelfHeal
    restartFn,
  });
}

// ── SELF-HEAL ENTRY ────────────────────────────────────────
async function selfHeal(errorMsg, context, opts = {}) {
  if (healLock) return;
  if (fixCount >= HEAL_CONFIG.maxFixPerSession) return;

  healLock = true;
  fixCount++;

  try {
    const taskType    = classifyError(errorMsg, context);
    const errorHistory = loadErrorHistory();

    await TaskRunner.runTask(taskType, {
      error      : errorMsg,
      context,
      targetFile : 'bot.js',
      errorHistory,
    }, {
      requireApproval  : HEAL_CONFIG.requireApproval,
      autoApproveConf  : HEAL_CONFIG.autoApproveIfConfident,
      restartFn        : opts.restartFn,
    });
  } finally {
    healLock = false;
  }
}

// ── HANDLE CALLBACK ────────────────────────────────────────
async function handleCallback(action, taskId) {
  return TaskRunner.handleCallback(action, taskId);
}

module.exports = {
  init,
  selfHeal,
  handleCallback,
  getFixCount  : () => fixCount,
  resetFixCount: () => { fixCount = 0; },
  pendingPatches: TaskRunner.pendingTasks, // backwards compat
  HEAL_CONFIG,
};
