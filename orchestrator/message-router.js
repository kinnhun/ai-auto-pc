/**
 * orchestrator/message-router.js
 * ═══════════════════════════════════════════════════════════
 * SINGLE-AGENT ROUTER — Mỗi message chỉ 1 agent phụ trách
 * 
 * Luồng:
 *   Message → PatternMatcher → 1 Handler → 1 Agent → Reply
 * 
 * KHÔNG để nhiều agent cùng xử lý 1 message.
 * KHÔNG gọi AI để phân loại (dùng pattern nhanh hơn).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ── ROUTE TABLE ─────────────────────────────────────────────
// Mỗi route: { pattern, agent, handler }
// pattern: regex test trên text.toLowerCase()
// handler: tên hàm trong HANDLERS
// Thứ tự ưu tiên: đặt specific trước, generic sau

const ROUTES = [

  // ── ADMIN / SYSTEM ───────────────────────────────────────
  { pattern: /^(on|off|bật|tắt|bat|tat)\s+\w/,  handler: 'admin_toggle',    agent: 'SYSTEM' },
  { pattern: /^(features|toggles|cài đặt)$/,     handler: 'show_features',   agent: 'SYSTEM' },
  { pattern: /^(status|trạng thái)$/,             handler: 'show_status',     agent: 'SYSTEM' },
  { pattern: /^(agents|team)$/,                   handler: 'show_agents',     agent: 'SYSTEM' },
  { pattern: /^\/start$/,                         handler: 'show_help',       agent: 'SYSTEM' },
  { pattern: /^help$/,                            handler: 'show_help',       agent: 'SYSTEM' },

  // ── PC CONTROLLER ────────────────────────────────────────
  { pattern: /^pc\s+.+/,                          handler: 'pc_task',         agent: 'PC_CONTROLLER' },
  { pattern: /^(mở|mo|open|tắt|đóng|close|ẩn|hiện|thu nhỏ|phóng to|chỉ để|giữ lại)\s+(.+)/, handler: 'pc_task', agent: 'PC_CONTROLLER' },
  { pattern: /^(vào|truy cập)\s+(fb|facebook|youtube|gg|google|web|trang|ứng dụng|app)/, handler: 'pc_task', agent: 'PC_CONTROLLER' },
  { pattern: /^(chụp|nhấn|bấm|click|gõ|type|cuộn|scroll|kéo|di chuột)\s+.+/, handler: 'pc_task', agent: 'PC_CONTROLLER' },
  { pattern: /^(chạy lệnh|cmd|terminal)\s+.+/,    handler: 'pc_task',         agent: 'PC_CONTROLLER' },

  // ── CLAUDE CODER ─────────────────────────────────────────
  { pattern: /^claude\s+.+/,                      handler: 'claude_task',     agent: 'CLAUDE_CODER' },
  { pattern: /^(refactor|tái cấu trúc)\s+.+/,    handler: 'claude_task',     agent: 'CLAUDE_CODER' },

  // ── LEARNING / MEMORY ────────────────────────────────────
  { pattern: /^(nhớ|ghi nhớ|học|lưu ý|tự học)\s+.+/, handler: 'learn_task', agent: 'LEARNING_AGENT' },

  // ── CONTENT + TREND ─────────────────────────────────────
  { pattern: /^(tạo bài|viết bài|đăng bài|chạy)$/, handler: 'create_post',  agent: 'CONTENT_WRITER' },
  { pattern: /^(trending|hot|xu hướng)$/,         handler: 'show_trending',   agent: 'TREND_ANALYST' },

  // ── CODE REVIEWER ────────────────────────────────────────
  { pattern: /^(upgrade|nâng cấp)$/,              handler: 'auto_upgrade',    agent: 'CODE_REVIEWER' },

  // ── FREE CHAT → SENIOR_DEV (LAST) ────────────────────────
  { pattern: /.{3,}/,                             handler: 'free_chat',       agent: 'SENIOR_DEV' },
];

// ── MATCH ────────────────────────────────────────────────────
/**
 * Tìm route đầu tiên khớp với text
 * @returns {{ handler, agent, matched }} hoặc null
 */
function route(text) {
  const lower = text.toLowerCase().trim();
  for (const r of ROUTES) {
    if (r.pattern.test(lower)) {
      return { handler: r.handler, agent: r.agent, matched: r.pattern.toString() };
    }
  }
  return null;
}

module.exports = { route, ROUTES };
