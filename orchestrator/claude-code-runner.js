/**
 * orchestrator/claude-code-runner.js
 * ═══════════════════════════════════════════════════════════
 * ⚡ CLAUDE CODE RUNNER — Tích hợp Claude Code CLI
 * 
 * Claude Code là tool của Anthropic cho phép Claude tự:
 *   - Đọc/viết toàn bộ codebase
 *   - Chạy terminal commands
 *   - Search & replace thông minh
 *   - Multi-file edits
 * 
 * Setup:
 *   npm install -g @anthropic-ai/claude-code
 *   Set ANTHROPIC_API_KEY trong env
 * 
 * Cách dùng:
 *   ClaudeCodeRunner.runTask("fix bug X trong file Y")
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { execSync, spawn, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function log(msg) {
  const line = `[${new Date().toLocaleString('vi-VN')}] [ClaudeCode] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'bot.log'), line + '\n'); } catch(e) {}
}

// ── CHECK AVAILABILITY ──────────────────────────────────────

function isAvailable() {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch(e) { return false; }
}

function getInstallInstructions() {
  return [
    '⚡ <b>Cài Claude Code:</b>',
    '',
    '1. Lấy API key: https://console.anthropic.com/',
    '2. Chạy trong terminal:',
    '<code>npm install -g @anthropic-ai/claude-code</code>',
    '',
    '3. Set API key:',
    '<code>$env:ANTHROPIC_API_KEY = "sk-ant-xxx"</code>',
    '',
    '4. Test:',
    '<code>claude --version</code>',
  ].join('\n');
}

// ── RUN TASK ────────────────────────────────────────────────
/**
 * Chạy Claude Code với một task
 * @param {string} task - Mô tả task
 * @param {object} opts
 *   opts.cwd          - working directory (default: ROOT)
 *   opts.files        - danh sách file đặc biệt cần đọc
 *   opts.interactive  - true = chờ user input
 *   opts.timeout      - ms timeout (default: 5 phút)
 *   opts.onOutput     - callback khi có output
 */
async function runTask(task, opts = {}) {
  if (!isAvailable()) {
    return {
      ok   : false,
      error: 'Claude Code chưa được cài',
      hint : getInstallInstructions(),
    };
  }

  const { cwd = ROOT, timeout = 5 * 60 * 1000, onOutput } = opts;

  log(`⚡ Task: "${task.substring(0, 100)}"`);

  return new Promise((resolve) => {
    const output  = [];
    const errors  = [];

    // Build prompt với context
    const systemPrompt = `Bạn đang làm việc trong repo fb-auto-bot tại ${cwd}.

RULES:
- Chỉ sửa files: bot.js, config.json, modules/, orchestrator/
- Tạo git backup trước khi sửa
- Patch tối thiểu, không thay đổi logic không liên quan
- Sau khi sửa: chạy node --check để verify syntax`;

    const child = spawn('claude', [
      '--print',          // non-interactive, xuất ra stdout
      '--no-cache',
      '-p', `${systemPrompt}\n\n${task}`,
    ], {
      cwd,
      env   : { ...process.env },
      stdio : ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output.push(text);
      onOutput?.(text);
    });

    child.stderr.on('data', (data) => {
      errors.push(data.toString());
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, error: 'Timeout', output: output.join('') });
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const fullOutput = output.join('').trim();
      const fullError  = errors.join('').trim();
      log(`⚡ Claude Code kết thúc (code=${code}, ${fullOutput.length} chars)`);
      resolve({
        ok    : code === 0,
        output: fullOutput || fullError,
        code,
      });
    });
  });
}

// ── ANALYZE CODEBASE ────────────────────────────────────────
async function analyzeCodebase(question) {
  return runTask(
    `Phân tích codebase và trả lời: ${question}\n\nChỉ đọc files, không sửa gì.`,
  );
}

// ── MULTI-FILE EDIT ─────────────────────────────────────────
async function multiFileEdit(description, filesToEdit = []) {
  const filesStr = filesToEdit.length > 0 ? `\nFiles liên quan: ${filesToEdit.join(', ')}` : '';
  return runTask(`${description}${filesStr}`);
}

// ── SETUP WIZARD ────────────────────────────────────────────
async function setupWizard(tgFn) {
  const steps = [
    {
      check: () => !!process.env.ANTHROPIC_API_KEY,
      msg  : '❌ Chưa có ANTHROPIC_API_KEY',
      help : 'Lấy tại: https://console.anthropic.com/\nSau đó chạy:\n<code>$env:ANTHROPIC_API_KEY = "sk-ant-xxx"</code>',
    },
    {
      check: isAvailable,
      msg  : '❌ Claude Code chưa cài',
      help : '<code>npm install -g @anthropic-ai/claude-code</code>',
    },
  ];

  for (const step of steps) {
    if (!step.check()) {
      await tgFn?.(`${step.msg}\n\n${step.help}`);
      return false;
    }
  }

  await tgFn?.('✅ Claude Code đã sẵn sàng!');
  return true;
}

module.exports = {
  isAvailable,
  runTask,
  analyzeCodebase,
  multiFileEdit,
  setupWizard,
  getInstallInstructions,
};
