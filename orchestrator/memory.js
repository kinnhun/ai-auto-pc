/**
 * orchestrator/memory.js
 * ═══════════════════════════════════════════════════════════
 * BỘ NHỚ TỰ HỌC (AUTONOMOUS LEARNING MEMORY)
 * Không chỉ code được patch, mà hành vi cũng được lưu trữ.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const MEM_FILE = path.join(__dirname, '..', 'memory.json');

function getMemory() {
  try { return JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); }
  catch(e) { return { lessons: [] }; }
}

function saveMemory(mem) {
  fs.writeFileSync(MEM_FILE, JSON.stringify(mem, null, 2), 'utf8');
}

function learn(insight, category = 'General') {
  const mem = getMemory();
  if (!mem.lessons) mem.lessons = [];
  
  // Tránh lặp bài học cũ do trùng lặp
  if (mem.lessons.some(l => l.insight === insight)) return;
  
  mem.lessons.push({ timestamp: new Date().toISOString(), category, insight });
  
  // Giữ tối đa 30 bài học gần nhất để không làm loãng prompt
  if (mem.lessons.length > 30) mem.lessons = mem.lessons.slice(-30);
  saveMemory(mem);
}

function getMemoryContext() {
  const mem = getMemory();
  if (!mem.lessons || !mem.lessons.length) return '';
  
  let ctx = `\n\n== BỘ NHỚ TỰ HỌC (SYSTEM MEMORY) ==\n`;
  ctx += `Hãy phân tích và áp dụng các "bài học" sau nếu nó liên quan đến yêu cầu của user hiện tại:\n`;
  mem.lessons.forEach(l => {
    ctx += `- [${l.category}] ${l.insight}\n`;
  });
  return ctx;
}

module.exports = { getMemory, saveMemory, learn, getMemoryContext };
