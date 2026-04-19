/**
 * orchestrator/computer-controller.js
 * ═══════════════════════════════════════════════════════════
 * 🖥️ PC CONTROLLER — Điều khiển máy tính Windows
 * 
 * Capabilities:
 *   📸 Screenshot → gửi Telegram để AI "nhìn" màn hình
 *   🖱️  Mouse click (tọa độ hoặc mô tả vị trí)
 *   ⌨️  Keyboard type / hotkey
 *   🚀 Mở ứng dụng
 *   💻 Chạy PowerShell / CMD
 *   🪟 Quản lý cửa sổ (focus, maximize, minimize)
 * 
 * Safety:
 *   - Mọi action gửi Telegram xem trước (screenshot before/after)
 *   - Có thể chạy ở chế độ dry-run (log nhưng không thực hiện)
 *   - Whitelist app được phép mở
 *   - Không tự xóa file, không format disk
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { execSync, spawnSync, spawn } = require('child_process');
const path  = require('fs');
const fs    = require('fs');
const pathM = require('path');

const ROOT      = pathM.join(__dirname, '..');
const SHOT_DIR  = pathM.join(ROOT, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── CONFIG ─────────────────────────────────────────────────
const PC_CONFIG = {
  dryRun       : false,   // true = chỉ log, không thực hiện
  delayBetween : 500,     // ms giữa các action
  screenshotBeforeAction: true,

  // App được phép mở
  allowedApps: [
    'notepad', 'code', 'chrome', 'msedge', 'explorer',
    'powershell', 'cmd', 'wt', 'cursor', 'windsurf',
    'node', 'npm', 'git',
  ],
};

// ── HELPERS ─────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toLocaleString('vi-VN')}] [PCCtrl] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(pathM.join(ROOT, 'bot.log'), line + '\n'); } catch(e) {}
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── SCREENSHOT ──────────────────────────────────────────────
async function screenshot(label = 'screen') {
  const ts   = Date.now();
  const file = pathM.join(SHOT_DIR, `${label}_${ts}.png`);
  try {
    const screenshotDesktop = require('screenshot-desktop');
    await screenshotDesktop({ filename: file });
    log(`📸 Screenshot: ${file}`);
    return file;
  } catch(e) {
    // Fallback: PowerShell native screenshot
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
$bitmap.Save('${file.replace(/\\/g,'/')}')
$g.Dispose(); $bitmap.Dispose()
`;
    try {
      execSync(`powershell -Command "${ps.replace(/"/g,"'").replace(/\n/g,' ')}"`, { timeout: 10000 });
      log(`📸 Screenshot (PS): ${file}`);
      return file;
    } catch(e2) {
      log(`❌ Screenshot thất bại: ${e2.message}`);
      return null;
    }
  }
}

// ── MOUSE CLICK ─────────────────────────────────────────────
async function click(x, y, button = 'left') {
  log(`🖱️  Click ${button} tại (${x}, ${y})`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua click'); return true; }

  // Dùng PowerShell + Windows Forms để click
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Clicker {
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int cButtons, int dwExtraInfo);
  public const int MOUSEEVENTF_LEFTDOWN = 0x02;
  public const int MOUSEEVENTF_LEFTUP = 0x04;
  public const int MOUSEEVENTF_RIGHTDOWN = 0x08;
  public const int MOUSEEVENTF_RIGHTUP = 0x10;
}
"@
$down = ${button === 'right' ? '[Clicker]::MOUSEEVENTF_RIGHTDOWN' : '[Clicker]::MOUSEEVENTF_LEFTDOWN'}
$up   = ${button === 'right' ? '[Clicker]::MOUSEEVENTF_RIGHTUP'  : '[Clicker]::MOUSEEVENTF_LEFTUP'}
[Clicker]::mouse_event($down, 0, 0, 0, 0)
Start-Sleep -Milliseconds 80
[Clicker]::mouse_event($up, 0, 0, 0, 0)
`;
  try {
    execSync(`powershell -Command "${ps.replace(/\n/g,' ')}"`, { timeout: 5000 });
    await delay(PC_CONFIG.delayBetween);
    return true;
  } catch(e) {
    log(`❌ Click thất bại: ${e.message}`);
    return false;
  }
}

// ── KEYBOARD TYPE ───────────────────────────────────────────
async function typeText(text) {
  log(`⌨️  Type: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua type'); return true; }

  // Dùng SendKeys qua PowerShell
  const safe = text
    .replace(/'/g, "''")
    .replace(/\+/g, '{+}')
    .replace(/\^/g, '{^}')
    .replace(/%/g,  '{%}')
    .replace(/~/g,  '{~}')
    .replace(/\(/g, '{(}')
    .replace(/\)/g, '{)}')
    .replace(/\n/g, '~');   // ~ = Enter trong SendKeys

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${safe}')
`;
  try {
    execSync(`powershell -Command "${ps.replace(/\n/g,' ')}"`, { timeout: 10000 });
    await delay(200);
    return true;
  } catch(e) {
    log(`❌ Type thất bại: ${e.message}`);
    return false;
  }
}

// ── HOTKEY ──────────────────────────────────────────────────
async function hotkey(combo) {
  // combo: 'ctrl+c', 'ctrl+v', 'alt+f4', 'win+r', etc.
  log(`⌨️  Hotkey: ${combo}`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua hotkey'); return true; }

  const keyMap = { 'ctrl': '^', 'alt': '%', 'shift': '+', 'win': '^{ESC}' };
  let sendKey  = combo;
  for (const [k, v] of Object.entries(keyMap)) {
    sendKey = sendKey.replace(new RegExp(k + '\\+', 'gi'), v);
  }

  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')
`;
  try {
    execSync(`powershell -Command "${ps.replace(/\n/g,' ')}"`, { timeout: 5000 });
    await delay(300);
    return true;
  } catch(e) {
    log(`❌ Hotkey thất bại: ${e.message}`);
    return false;
  }
}

// ── OPEN APP ─────────────────────────────────────────────────

// Tìm đường dẫn thực của browser
function resolveAppPath(app) {
  const lower = app.toLowerCase();
  const KNOWN = {
    chrome  : [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    msedge  : [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    firefox : ['C:\\Program Files\\Mozilla Firefox\\firefox.exe'],
    notepad : ['notepad.exe'],
    code    : ['code'],
    explorer: ['explorer.exe'],
  };

  const key = Object.keys(KNOWN).find(k => lower.includes(k));
  if (!key) return null;
  const paths = KNOWN[key];
  for (const p of paths) {
    if (!p.includes('\\') || fs.existsSync(p)) return p;
  }
  return paths[0];
}

/**
 * Mở URL trong trình duyệt — dùng cmd /c start (đáng tin nhất trên Windows)
 */
async function openURL(url, browser = 'default') {
  log(`🌐 Mở URL: ${url} [${browser}]`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua openURL'); return { ok: true }; }

  try {
    if (browser === 'default') {
      // Mở bằng trình duyệt mặc định — LUÔN hoạt động trên Windows
      execSync(`cmd /c start "" "${url}"`, { shell: true, timeout: 8000, stdio: 'pipe' });
    } else {
      const exePath = resolveAppPath(browser) || browser;
      execSync(`cmd /c start "" "${exePath}" "${url}"`, { shell: true, timeout: 8000, stdio: 'pipe' });
    }
    await delay(2000);
    return { ok: true };
  } catch(e) {
    log(`❌ openURL thất bại: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Mở ứng dụng hoặc URL
 * args: string URL hoặc { url, args }
 */
async function openApp(appName, args = '') {
  const lower = appName.toLowerCase();

  // Allowedapps check
  const isAllowed = PC_CONFIG.allowedApps.some(a => lower.includes(a))
    || (typeof args === 'string' && args.startsWith('http')); // URL luôn OK
  if (!isAllowed) {
    log(`⛔ App không trong whitelist: ${appName}`);
    return { ok: false, error: `${appName} không được phép` };
  }

  const url = typeof args === 'object' ? args.url : args;

  // Nếu args là URL → openURL
  if (url?.startsWith('http')) {
    return openURL(url, lower.includes('edge') ? 'msedge' : lower.includes('firefox') ? 'firefox' : 'chrome');
  }

  log(`🚀 Mở app: ${appName}`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua mở app'); return { ok: true }; }

  const exePath = resolveAppPath(appName) || appName;
  const extraArgs = typeof args === 'string' ? args : '';

  try {
    // cmd /c start — đáng tin cậy nhất, không cần spawn
    execSync(`cmd /c start "" "${exePath}"${extraArgs ? ' ' + extraArgs : ''}`, {
      shell: true, timeout: 8000, stdio: 'pipe'
    });
    await delay(1500);
    return { ok: true };
  } catch(e) {
    // Fallback: PowerShell Start-Process
    try {
      execSync(`powershell -Command "Start-Process '${exePath.replace(/'/g,"''")}'"`, {
        shell: true, timeout: 8000, stdio: 'pipe'
      });
      await delay(1500);
      return { ok: true };
    } catch(e2) {
      log(`❌ Mở app thất bại: ${e2.message}`);
      return { ok: false, error: e2.message };
    }
  }
}


// ── RUN COMMAND ──────────────────────────────────────────────
async function runCmd(cmd, opts = {}) {
  const { cwd = ROOT, timeout = 30000, safe = false } = opts;

  // Chặn lệnh nguy hiểm
  const dangerous = ['format', 'del /f', 'rd /s', 'rm -rf', 'rmdir /s', 'shutdown', 'taskkill /f'];
  if (!safe && dangerous.some(d => cmd.toLowerCase().includes(d))) {
    log(`⛔ Lệnh nguy hiểm bị chặn: ${cmd}`);
    return { ok: false, error: 'Lệnh bị chặn vì lý do an toàn' };
  }

  log(`💻 Run: ${cmd}`);
  if (PC_CONFIG.dryRun) { log('[DRY-RUN] Bỏ qua cmd'); return { ok: true, output: '[dry-run]' }; }

  try {
    const out = execSync(cmd, { cwd, stdio: 'pipe', timeout, encoding: 'utf8' });
    return { ok: true, output: out.trim().substring(0, 2000) };
  } catch(e) {
    return { ok: false, error: e.message, output: (e.stdout || '') + (e.stderr || '') };
  }
}

// ── WINDOW MANAGER ───────────────────────────────────────────
async function focusWindow(title) {
  log(`🪟 Focus window: "${title}"`);
  const ps = `
$wnd = Get-Process | Where-Object {$_.MainWindowTitle -like '*${title}*'} | Select-Object -First 1
if ($wnd) {
  Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class Win { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }
"@
  [Win]::SetForegroundWindow($wnd.MainWindowHandle)
  Write-Output "OK: $($wnd.MainWindowTitle)"
} else { Write-Output "NOT FOUND" }
`;
  try {
    const out = execSync(`powershell -Command "${ps.replace(/\n/g,' ')}"`, { timeout: 5000, encoding: 'utf8' });
    const ok  = !out.includes('NOT FOUND');
    log(ok ? `✅ Focused: ${title}` : `⚠️ Window không tìm thấy: ${title}`);
    return { ok, output: out.trim() };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── GET SCREEN INFO ──────────────────────────────────────────
async function getScreenInfo() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$s = [System.Windows.Forms.Screen]::PrimaryScreen
$pos = [System.Windows.Forms.Cursor]::Position
Write-Output "Screen: $($s.Bounds.Width)x$($s.Bounds.Height)"
Write-Output "Cursor: $($pos.X),$($pos.Y)"
$procs = Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json
Write-Output $procs
`;
  try {
    const out = execSync(`powershell -Command "${ps.replace(/\n/g,' ')}"`, { timeout: 5000, encoding: 'utf8' });
    return { ok: true, output: out.trim() };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// ── AI-GUIDED ACTION (main entry) ────────────────────────────
/**
 * Nhận instruction từ AI, parse và thực thi
 * AI output format:
 *   [ACTION type="click" x=100 y=200]
 *   [ACTION type="type" text="hello world"]
 *   [ACTION type="hotkey" combo="ctrl+s"]
 *   [ACTION type="run" cmd="npm install"]
 *   [ACTION type="openapp" app="notepad"]
 *   [ACTION type="screenshot"]
 *   [ACTION type="focus" title="Chrome"]
 */
async function executeAIActions(aiText, tgFn) {
  const re      = /\[ACTION\s+type="([^"]+)"([^\]]*)\]/gi;
  const results = [];
  let m;

  while ((m = re.exec(aiText)) !== null) {
    const type   = m[1].toLowerCase();
    const attrs  = m[2];

    const getAttr = (name) => {
      const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
      return match ? match[1] : null;
    };

    log(`🤖 AI Action: type="${type}" attrs="${attrs.trim()}"`);

    if (PC_CONFIG.screenshotBeforeAction && type !== 'screenshot') {
      const before = await screenshot(`before_${type}`);
      if (before && tgFn) await tgFn?.(before, `📸 Before ${type}`);
    }

    let result;
    switch(type) {
      case 'screenshot':
        const shot = await screenshot('ai_request');
        result = { ok: !!shot, file: shot };
        if (shot && tgFn) await tgFn?.(shot, '📸 Screenshot theo yêu cầu');
        break;
      case 'click':
        result = await click(parseInt(getAttr('x')||0), parseInt(getAttr('y')||0), getAttr('button')||'left');
        result = { ok: result };
        break;
      case 'type':
        result = { ok: await typeText(getAttr('text') || '') };
        break;
      case 'hotkey':
        result = { ok: await hotkey(getAttr('combo') || '') };
        break;
      case 'run':
        result = await runCmd(getAttr('cmd') || '');
        break;
      case 'openapp':
        result = await openApp(getAttr('app') || '', getAttr('args') || '');
        break;
      case 'focus':
        result = await focusWindow(getAttr('title') || '');
        break;
      default:
        result = { ok: false, error: `Unknown action: ${type}` };
    }

    results.push({ type, ...result });

    // Screenshot after để xác nhận
    if (PC_CONFIG.screenshotBeforeAction && type !== 'screenshot' && result.ok) {
      await delay(800);
      const after = await screenshot(`after_${type}`);
      if (after && tgFn) await tgFn?.(after, `📸 After ${type}`);
    }
  }

  return results;
}

module.exports = {
  screenshot,
  click,
  typeText,
  hotkey,
  openApp,
  runCmd,
  focusWindow,
  getScreenInfo,
  executeAIActions,
  PC_CONFIG,
};
