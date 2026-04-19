/**
 * orchestrator/agent-manager.js
 * ═══════════════════════════════════════════════════════════
 * AGENT MANAGER — Điều phối AI agents theo vai trò
 * 
 * Mỗi task → đúng agent → đúng model → đúng temperature
 * Không trùng lặp, không gọi 2 agent cùng lúc cho 1 task
 * 
 * AGENTS:
 *   🧠 Senior Dev      — fix bug, patch code (primary)
 *   🔍 Code Reviewer   — review, upgrade, refactor
 *   ✍️  Content Writer  — viết bài Facebook SEO
 *   📊 Trend Analyst   — phân tích trending
 *   🔧 Backup Dev      — dự phòng khi Senior Dev fail
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const Memory = require('./memory');

const ROOT         = path.join(__dirname, '..');
const AGENTS_FILE  = path.join(__dirname, 'agents.json');
const registry     = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));

const AI_ENDPOINT  = () => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).aiEndpoint; }
  catch(e) { return 'http://localhost:20128/v1/chat/completions'; }
};

function log(msg) {
  const line = `[${new Date().toLocaleString('vi-VN')}] [AgentMgr] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(ROOT, 'bot.log'), line + '\n'); } catch(e) {}
}

// ── AGENT LOOKUP ────────────────────────────────────────────

/**
 * Lấy danh sách agents (primary → fallback) cho 1 task type
 */
function getAgentsForTask(taskType) {
  const agentIds = registry.task_assignment[taskType];
  if (!agentIds?.length) {
    log(`⚠️ Không có agent nào cho task: ${taskType}`);
    return [];
  }
  return agentIds.map(id => ({ id, ...registry.agents[id] })).filter(Boolean);
}

/**
 * Lấy thông tin 1 agent theo ID
 */
function getAgent(agentId) {
  const a = registry.agents[agentId];
  if (!a) throw new Error(`Agent không tồn tại: ${agentId}`);
  return { id: agentId, ...a };
}

// ── CALL AGENT ──────────────────────────────────────────────

/**
 * Gọi đúng agent cho task, tự động fallback nếu primary fail
 * 
 * @param {string} taskType
 * @param {string} prompt
 * @param {object} opts   - override temperature, maxTokens
 * @returns {{ agentId, agentName, model, content, attempt }}
 */
async function callAgent(taskType, prompt, opts = {}) {
  const agents = getAgentsForTask(taskType);

  if (!agents.length) {
    throw new Error(`Không có agent nào cho task: ${taskType}`);
  }

  for (let i = 0; i < agents.length; i++) {
    const agent   = agents[i];
    const attempt = i + 1;

    if (attempt > 1) {
      log(`🔄 Fallback → ${agent.name} [${agent.model}]`);
    }

    log(`📞 Gọi ${agent.name} cho task "${taskType}" (attempt ${attempt}/${agents.length})`);

    try {
      const finalPrompt = prompt + Memory.getMemoryContext();
      
      const resp = await axios.post(AI_ENDPOINT(), {
        model      : agent.model,
        messages   : [{ role: 'user', content: finalPrompt }],
        temperature: opts.temperature ?? agent.temperature,
        max_tokens : opts.maxTokens   ?? agent.maxTokens,
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      });

      const content = resp.data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response');

      log(`✅ ${agent.name} hoàn thành (${content.length} chars)`);
      return {
        agentId  : agent.id,
        agentName: agent.name,
        model    : agent.model,
        content,
        attempt,
      };

    } catch(e) {
      const errMsg = e.response?.data?.error?.message || e.message;
      log(`❌ ${agent.name} thất bại: ${errMsg}`);

      if (i === agents.length - 1) {
        log(`🚫 Tất cả agents đều fail cho task: ${taskType}`);
        return null;
      }
    }
  }

  return null;
}

// ── STATUS REPORT ───────────────────────────────────────────

function getStatusReport() {
  const lines = Object.entries(registry.agents).map(([id, a]) =>
    `${a.name}: <b>${a.role}</b>\nTask: ${a.tasks.join(', ')}\nModel: <code>${a.model}</code>`
  );
  return lines.join('\n\n');
}

function getAgentSummary() {
  return Object.entries(registry.agents)
    .map(([id, a]) => `${a.name} → ${a.tasks.map(t => `<code>${t}</code>`).join(', ')}`)
    .join('\n');
}

module.exports = {
  callAgent,
  getAgent,
  getAgentsForTask,
  getStatusReport,
  getAgentSummary,
  registry,
};
