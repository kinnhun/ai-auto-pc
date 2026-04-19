/**
 * orchestrator/prompt-builder.js
 * ═══════════════════════════════════════════════════════════
 * Xây dựng prompt có cấu trúc từ task + context
 * 
 * Thay vì nhồi mọi thứ vào 1 prompt dạng tự do,
 * module này ghép theo layers:
 *   system_base  — ràng buộc cố định (không thay đổi)
 *   task_prompt  — template theo loại task
 *   context      — file code liên quan, lỗi, history
 *   constraints  — whitelist, rollback policy, test cmd
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT         = path.join(__dirname, '..');
const PROMPTS_FILE = path.join(__dirname, 'prompts.json');
const prompts      = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8'));

// ── WHITELIST (single source of truth) ─────────────────────
const WHITELIST = [
  'bot.js',
  'config.json',
  'modules/self-heal.js',
  'modules/content.js',
  'modules/browser.js',
  'modules/poster.js',
  'orchestrator/prompts.json',
];

// ── TEST COMMANDS ───────────────────────────────────────────
const TEST_COMMANDS = {
  'bot.js'                 : 'node --check bot.js',
  'modules/self-heal.js'   : 'node --check modules/self-heal.js',
  'default'                : 'node --check {file}',
};

function getTestCmd(file) {
  return TEST_COMMANDS[file] || TEST_COMMANDS['default'].replace('{file}', file);
}

// ── CODE EXTRACTOR ──────────────────────────────────────────
/**
 * Trích đoạn code liên quan đến lỗi (±50 dòng)
 * Tránh gửi toàn bộ file (tốn token)
 */
function extractRelevantCode(file, errorMsg, maxLines = 80) {
  try {
    const abs   = path.resolve(ROOT, file);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');

    // Tìm dòng liên quan đến lỗi
    const keywords = errorMsg
      .split(' ')
      .filter(w => w.length > 4 && !/^(error|Error|the|and|for|not|from)$/.test(w))
      .slice(0, 5);

    let centerLine = -1;
    for (const kw of keywords) {
      const idx = lines.findIndex(l => l.includes(kw));
      if (idx > -1) { centerLine = idx; break; }
    }

    if (centerLine === -1) centerLine = 0;

    const start = Math.max(0, centerLine - 40);
    const end   = Math.min(lines.length, centerLine + 40);

    return lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
  } catch(e) {
    return `// Không đọc được file: ${e.message}`;
  }
}

// ── MAIN BUILDER ────────────────────────────────────────────
/**
 * @param {string} taskType - key trong prompts.json tasks
 * @param {object} ctx - context object
 *   ctx.error        - error message
 *   ctx.context      - mô tả ngữ cảnh
 *   ctx.targetFile   - file chính cần sửa
 *   ctx.errorHistory - mảng lỗi gần đây
 *   ctx.extraFiles   - mảng file phụ cần lấy code
 */
function buildPrompt(taskType, ctx = {}) {
  const taskDef    = prompts.tasks[taskType];
  if (!taskDef) throw new Error(`Unknown task type: ${taskType}`);

  const targetFile = ctx.targetFile || 'bot.js';
  const whitelist  = WHITELIST.join(', ');
  const testCmd    = getTestCmd(targetFile);

  // Code context: file chính + các file liên quan
  const allFiles   = [targetFile, ...(ctx.extraFiles || [])].filter(Boolean);
  const codeSnippets = allFiles.map(f => {
    const snippet = extractRelevantCode(f, ctx.error || ctx.context || '', 80);
    return `// === ${f} ===\n${snippet}`;
  }).join('\n\n');

  // Error history (tối đa 8 gần nhất)
  const errorHistoryStr = (ctx.errorHistory || [])
    .slice(-8)
    .map((e, i) => `${i+1}. [${e.ts || '?'}] ${String(e.error).substring(0, 120)}`)
    .join('\n') || 'Không có';

  // Ghép template
  let taskPrompt = taskDef.template
    .replace(/{whitelist}/g,     whitelist)
    .replace(/{error}/g,         ctx.error || 'Không có thông tin lỗi')
    .replace(/{context}/g,       ctx.context || '')
    .replace(/{code_snippet}/g,  codeSnippets)
    .replace(/{error_history}/g, errorHistoryStr)
    .replace(/{target_file}/g,   targetFile)
    .replace(/{test_cmd}/g,      testCmd);

  // Ghép system_base + task + constraints cuối
  const fullPrompt = [
    prompts.system_base,
    '',
    '═'.repeat(60),
    `TASK TYPE: ${taskType.toUpperCase()}`,
    `TARGET FILE: ${targetFile}`,
    `TEST CMD: ${testCmd}`,
    `WHITELIST: ${whitelist}`,
    '═'.repeat(60),
    '',
    taskPrompt,
  ].join('\n');

  return {
    prompt  : fullPrompt,
    taskDef,
    testCmd,
    whitelist: WHITELIST,
    targetFile,
  };
}

// ── PARSE AI RESPONSE ───────────────────────────────────────
/**
 * Parse patches từ AI response
 * Format: [PATCH file="..." confidence=X] find: ... replace: ... [/PATCH]
 */
function parsePatches(aiText) {
  const patches = [];

  // File patches
  const re = /\[PATCH\s+file="([^"]+)"(?:\s+confidence=(\d+))?\]([\s\S]*?)\[\/PATCH\]/gi;
  let m;
  while ((m = re.exec(aiText)) !== null) {
    const file       = m[1].trim();
    const confidence = parseInt(m[2] || '70', 10);
    const block      = m[3];
    const findM      = block.match(/find:\s*([\s\S]*?)(?=replace:|$)/i);
    const repM       = block.match(/replace:\s*([\s\S]*?)$/i);
    if (findM && repM) {
      patches.push({
        type       : 'file',
        file,
        confidence,
        find       : findM[1].trim(),
        replace    : repM[1].trim(),
      });
    }
  }

  // CMD patches
  const cmdRe = /\[CMD\]([\s\S]*?)\[\/CMD\]/gi;
  while ((m = cmdRe.exec(aiText)) !== null) {
    const cmd = m[1].trim();
    if (cmd) patches.push({ type: 'cmd', cmd, confidence: 80 });
  }

  // Plan & test_plan (informational)
  const plan     = aiText.match(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/i)?.[1]?.trim();
  const testPlan = aiText.match(/\[TEST_PLAN\]([\s\S]*?)\[\/TEST_PLAN\]/i)?.[1]?.trim();
  const noUpgrade = aiText.includes('[NO_UPGRADE_NEEDED]');

  return { patches, plan, testPlan, noUpgrade };
}

module.exports = {
  buildPrompt,
  parsePatches,
  WHITELIST,
  getTestCmd,
  extractRelevantCode,
};
