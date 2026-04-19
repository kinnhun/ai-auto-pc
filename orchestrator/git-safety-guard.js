/**
 * orchestrator/git-safety-guard.js
 * ═══════════════════════════════════════════════════════════
 * An toàn Git: backup, rollback, commit, diff
 * 
 * Policy:
 *   - Luôn commit trước khi apply patch
 *   - Lưu snapshot .bak cho từng file
 *   - node --check sau mỗi JS patch
 *   - Rollback ngay nếu syntax fail
 *   - Log diff dạng human-readable
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs                     = require('fs');
const path                   = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const DIFF_DIR = path.join(ROOT, 'heal_log');
if (!fs.existsSync(DIFF_DIR)) fs.mkdirSync(DIFF_DIR, { recursive: true });

// ── GIT ────────────────────────────────────────────────────

function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch(e) { return false; }
}

function gitCommit(message) {
  if (!isGitRepo()) return null;
  try {
    const safeMsg = message.replace(/"/g, "'").substring(0, 72);
    execSync('git add bot.js config.json modules/ orchestrator/', { cwd: ROOT, stdio: 'pipe' });
    const r = spawnSync('git', ['commit', '-m', safeMsg], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0) {
      return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    }
    // Nothing to commit → OK
    return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  } catch(e) {
    console.warn(`[GitGuard] commit error: ${e.message}`);
    return null;
  }
}

function gitRollback(hash, files = ['bot.js']) {
  if (!hash || !isGitRepo()) return false;
  try {
    execSync(`git checkout ${hash} -- ${files.join(' ')}`, { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch(e) {
    console.warn(`[GitGuard] rollback error: ${e.message}`);
    return false;
  }
}

function gitDiff() {
  try {
    return execSync('git diff HEAD', { cwd: ROOT, encoding: 'utf8' });
  } catch(e) { return ''; }
}

// ── FILE BACKUP ────────────────────────────────────────────

function fileBackup(relPath) {
  try {
    const abs = path.resolve(ROOT, relPath);
    if (!fs.existsSync(abs)) return null;
    const bak = abs + '.bak';
    fs.copyFileSync(abs, bak);
    return bak;
  } catch(e) { return null; }
}

function fileRollback(relPath) {
  try {
    const abs = path.resolve(ROOT, relPath);
    const bak = abs + '.bak';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, abs);
      return true;
    }
    return false;
  } catch(e) { return false; }
}

// ── SYNTAX CHECK ───────────────────────────────────────────

function syntaxCheck(relPath) {
  if (!relPath.endsWith('.js')) return { ok: true };
  try {
    const abs    = path.resolve(ROOT, relPath);
    const r      = spawnSync('node', ['--check', abs], { encoding: 'utf8' });
    const ok     = r.status === 0;
    const error  = ok ? null : (r.stderr || r.stdout || 'syntax error').trim();
    return { ok, error };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── DIFF LOG ───────────────────────────────────────────────

function logDiff({ file, before, after, taskType, patchId, result }) {
  try {
    const ts      = Date.now();
    const logFile = path.join(DIFF_DIR, `${ts}_${taskType}_${patchId}.json`);
    const lines_a = before.split('\n');
    const lines_b = after.split('\n');

    const changes = [];
    const maxLen  = Math.max(lines_a.length, lines_b.length);
    for (let i = 0; i < maxLen; i++) {
      if (lines_a[i] === undefined) changes.push({ type: '+', line: i+1, content: lines_b[i] });
      else if (lines_b[i] === undefined) changes.push({ type: '-', line: i+1, content: lines_a[i] });
      else if (lines_a[i] !== lines_b[i]) changes.push({ type: '~', line: i+1, from: lines_a[i], to: lines_b[i] });
    }

    fs.writeFileSync(logFile, JSON.stringify({
      timestamp  : new Date().toISOString(),
      file, taskType, patchId, result,
      stats      : { added: changes.filter(c=>c.type==='+').length, removed: changes.filter(c=>c.type==='-').length, changed: changes.filter(c=>c.type==='~').length },
      changes    : changes.slice(0, 200), // giới hạn
    }, null, 2));
    return logFile;
  } catch(e) { return null; }
}

// ── APPLY PATCH ────────────────────────────────────────────

/**
 * Áp dụng 1 patch với đầy đủ safety checks
 * @returns {{ ok, error, rollback, logFile, gitHash }}
 */
function applyPatch(patch, { whitelist, patchId, taskType }) {
  if (patch.type === 'cmd') {
    try {
      const out = execSync(patch.cmd, { cwd: ROOT, stdio: 'pipe', timeout: 60000 }).toString().trim();
      return { ok: true, type: 'cmd', cmd: patch.cmd, out: out.substring(0, 500) };
    } catch(e) {
      return { ok: false, type: 'cmd', error: e.message };
    }
  }

  // Whitelist check
  const rel = patch.file.replace(/\\/g, '/');
  if (!whitelist.includes(rel)) {
    return { ok: false, error: `File không trong whitelist: ${rel}`, whitelist_blocked: true };
  }

  const abs    = path.resolve(ROOT, rel);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';

  if (!before.includes(patch.find)) {
    return { ok: false, error: `'find' string không tồn tại trong ${rel}` };
  }

  // Git backup trước
  const gitHash = gitCommit(`pre-patch: ${taskType}/${patchId} → ${rel}`);

  // File backup
  fileBackup(rel);

  // Apply
  const after = before.replace(patch.find, patch.replace);
  fs.writeFileSync(abs, after, 'utf8');

  // Syntax check
  const syn = syntaxCheck(rel);
  if (!syn.ok) {
    // Rollback ngay
    fileRollback(rel);
    if (gitHash) gitRollback(gitHash, [rel]);
    const logFile = logDiff({ file: rel, before, after, taskType, patchId, result: 'ROLLBACK' });
    return { ok: false, error: `Syntax fail: ${syn.error}`, rollback: true, logFile };
  }

  // Log diff
  const logFile = logDiff({ file: rel, before, after, taskType, patchId, result: 'OK' });

  // Commit sau khi apply
  const postHash = gitCommit(`post-patch: ${taskType}/${patchId} → ${rel}`);

  return { ok: true, file: rel, gitHash: postHash, logFile, confidence: patch.confidence };
}

module.exports = {
  gitCommit,
  gitRollback,
  gitDiff,
  fileBackup,
  fileRollback,
  syntaxCheck,
  logDiff,
  applyPatch,
  isGitRepo,
};
