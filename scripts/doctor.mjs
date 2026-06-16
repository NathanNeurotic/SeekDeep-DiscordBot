import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// Standalone .env loader — was `import dotenv from 'dotenv'` which broke
// when the Installer spawned doctor.mjs from %APPDATA%/SeekDeep/app/
// where there's no node_modules. The doctor's whole job is to diagnose
// before you have any deps, so it can't depend on npm packages itself.
// Minimal parser: KEY=VALUE per line, optional quotes, ignore # comments.
const dotenv = {
  config({ path: envPath } = {}) {
    try {
      const raw = fs.readFileSync(envPath, 'utf-8');
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        // Strip surrounding quotes if balanced.
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Don't overwrite values already in process.env (matches dotenv default).
        if (!(key in process.env)) process.env[key] = val;
      }
      return { parsed: true };
    } catch (err) {
      return { error: err };
    }
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

let passCount = 0;
let warnCount = 0;
let failCount = 0;

function formatStatus(status) {
  if (status === 'PASS') return `${colors.green}[PASS]${colors.reset}`;
  if (status === 'WARN') return `${colors.yellow}[WARN]${colors.reset}`;
  if (status === 'FAIL') return `${colors.red}[FAIL]${colors.reset}`;
  return `[${status}]`;
}

function report(status, category, message) {
  if (status === 'PASS') passCount++;
  else if (status === 'WARN') warnCount++;
  else if (status === 'FAIL') failCount++;
  console.log(`${formatStatus(status)} ${colors.bold}${category.padEnd(20)}:${colors.reset} ${message}`);
}

function looksLikePlaceholder(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return /YOUR_|TOKEN_HERE|CLIENT_ID_HERE|KEY_HERE|CHANGE_ME|PASTE_/i.test(v);
}

// timer cleanup in finally so an early throw can't leak handles
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function summarizeAndExit() {
  console.log(`\n${colors.cyan}${colors.bold}=== Diagnostics Summary ===${colors.reset}`);
  console.log(`${formatStatus('PASS')} ${passCount} checks passed`);
  console.log(`${formatStatus('WARN')} ${warnCount} warnings generated`);
  console.log(`${formatStatus('FAIL')} ${failCount} checks failed\n`);

  if (failCount > 0) {
    console.log(`${colors.red}${colors.bold}SeekDeep doctor found required setup errors. Resolve the [FAIL] lines above.${colors.reset}`);
    process.exitCode = 1;
  } else if (warnCount > 0) {
    console.log(`${colors.yellow}${colors.bold}SeekDeep doctor completed with warnings. The bot may still run, but review the [WARN] lines.${colors.reset}`);
    process.exitCode = 0;
  } else {
    console.log(`${colors.green}${colors.bold}SeekDeep doctor completed successfully. Setup is ready to run.${colors.reset}`);
    process.exitCode = 0;
  }
}

console.log(`${colors.cyan}${colors.bold}=== SeekDeep Doctor Setup Diagnostics ===${colors.reset}\n`);

async function run() {
  try {
    const rawVersion = process.version;
    const major = parseInt(rawVersion.substring(1), 10);
    const minor = parseInt(rawVersion.split('.')[1] || '0', 10) || 0;
    // engines floor is >=22.12.0 (@discordjs/voice 0.19 requires it); enforce the
    // minor too so Node 22.0–22.11 don't falsely pass the major-only check.
    if (major > 22 || (major === 22 && minor >= 12)) report('PASS', 'Node Version', `${rawVersion} (>= 22.12.0 required)`);
    else report('FAIL', 'Node Version', `${rawVersion} is below required v22.12.0. Install Node.js 22.12+ LTS.`);
  } catch (err) {
    report('FAIL', 'Node Version', `Failed to determine Node version: ${err.message}`);
  }

  try {
    const npmVersion = execSync('npm -v', { stdio: 'pipe' }).toString().trim();
    report('PASS', 'npm CLI', `v${npmVersion} is available`);
  } catch (err) {
    report('FAIL', 'npm CLI', `npm command not found or failed to execute: ${err.message}`);
  }

  // .env.default is the first-run template that setup_local.ps1 copies from;
  // .env.example is the full env reference. Both are tracked in git.
  const envDefaultPath = path.join(rootDir, '.env.default');
  const envExamplePath = path.join(rootDir, '.env.example');
  if (fs.existsSync(envDefaultPath)) report('PASS', '.env.default', 'First-run template exists');
  else report('FAIL', '.env.default', 'Missing. setup_local.ps1 expects this file to create .env.');

  if (fs.existsSync(envExamplePath)) report('PASS', '.env.example', 'Full reference file exists');
  else report('WARN', '.env.example', 'Missing full env reference file');

  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) {
    report('FAIL', '.env File', 'Missing from repository root. Run setup_local.ps1 or copy .env.default to .env, then fill required values.');
    summarizeAndExit();
    return;
  }
  report('PASS', '.env File', 'File exists');

  dotenv.config({ path: envPath });

  const token = process.env.DISCORD_TOKEN;
  if (!token || token.trim() === '') {
    report('FAIL', 'DISCORD_TOKEN', 'Missing or empty in .env');
  } else if (looksLikePlaceholder(token)) {
    report('FAIL', 'DISCORD_TOKEN', 'Still set to a placeholder value');
  } else {
    report('PASS', 'DISCORD_TOKEN', 'Present (masked for security)');
  }

  // DISCORD_CLIENT_ID is WARN, not FAIL: the bot can reply to mentions without
  // it. It's only needed for slash + context-menu command registration
  // diagnostics, which the bot itself handles gracefully when absent.
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || clientId.trim() === '') {
    report('WARN', 'DISCORD_CLIENT_ID', 'Missing or empty. Message replies still work; slash/context command registration diagnostics will be incomplete.');
  } else if (looksLikePlaceholder(clientId)) {
    report('WARN', 'DISCORD_CLIENT_ID', 'Still set to a placeholder value');
  } else if (!/^\d{15,25}$/.test(clientId.trim())) {
    report('WARN', 'DISCORD_CLIENT_ID', 'Present but does not look like a Discord snowflake ID');
  } else {
    report('PASS', 'DISCORD_CLIENT_ID', 'Present (masked for security)');
  }

  const localAiBaseUrlStr = process.env.LOCAL_AI_BASE_URL || 'http://127.0.0.1:7865';
  let localAiUrl;
  try {
    localAiUrl = new URL(localAiBaseUrlStr);
    report('PASS', 'LOCAL_AI_BASE_URL', `Valid URL: ${localAiBaseUrlStr}`);
    if (!['127.0.0.1', 'localhost'].includes(localAiUrl.hostname)) {
      report('WARN', 'LOCAL_AI_BASE_URL', 'Not loopback. Prompts and media may leave this machine if the server is remote.');
    }
  } catch (err) {
    report('FAIL', 'LOCAL_AI_BASE_URL', `Invalid URL format '${localAiBaseUrlStr}': ${err.message}`);
  }

  if (localAiUrl) {
    const startupTimeout = parseInt(process.env.SEEKDEEP_STARTUP_HEALTH_TIMEOUT_MS || '4000', 10);

    try {
      const res = await fetchWithTimeout(new URL('/health', localAiUrl).href, startupTimeout);
      if (res.ok) {
        const health = await res.json().catch(() => null);
        if (health && typeof health === 'object') {
          report('PASS', 'Local AI /health', `Online (Device: ${health.device || 'unknown'}, CUDA: ${health.cuda_available ? 'yes' : 'no'})`);
        } else {
          report('WARN', 'Local AI /health', 'Online but returned unparseable JSON response');
        }
      } else {
        report('WARN', 'Local AI /health', `Reachable but returned status ${res.status}`);
      }
    } catch (err) {
      report('WARN', 'Local AI /health', `Offline at ${localAiBaseUrlStr}: ${err.message}`);
    }

    try {
      const res = await fetchWithTimeout(new URL('/gpu', localAiUrl).href, startupTimeout);
      if (res.ok) {
        const gpu = await res.json().catch(() => null);
        if (gpu && typeof gpu === 'object') {
          const deviceName = gpu.device_name || 'unknown';
          const vramUsed = gpu.used_mb ? `${gpu.used_mb}MB` : 'unknown';
          const vramTotal = gpu.total_mb ? `${gpu.total_mb}MB` : 'unknown';
          report('PASS', 'Local AI /gpu', `Online (GPU: ${deviceName}, VRAM Used/Total: ${vramUsed}/${vramTotal})`);
        } else {
          report('WARN', 'Local AI /gpu', 'Online but returned unparseable GPU JSON response');
        }
      } else {
        report('WARN', 'Local AI /gpu', `Reachable but returned status ${res.status}`);
      }
    } catch (err) {
      report('WARN', 'Local AI /gpu', `Offline at ${localAiBaseUrlStr}: ${err.message}`);
    }
  }

  // Match the bot's actual semantics from index.js: WEB_AUTO_SEARCH is opt-in
  // via the literal string 'true', OR via WEB_SEARCH_PROVIDER=searxng. Don't
  // accept '1'/'on'/'yes' here because the bot itself doesn't.
  const webSearchEnabled = process.env.WEB_AUTO_SEARCH === 'true' || process.env.WEB_SEARCH_PROVIDER === 'searxng';
  const searxngBaseUrlStr = process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
  if (webSearchEnabled) {
    try {
      const searxngUrl = new URL(searxngBaseUrlStr);
      if (!['127.0.0.1', 'localhost'].includes(searxngUrl.hostname)) {
        report('WARN', 'SearXNG URL', 'Not loopback. Search queries may go to a remote SearXNG instance.');
      }
      const res = await fetchWithTimeout(searxngUrl.href, 3000);
      if (res.ok || [401, 403, 404].includes(res.status)) {
        report('PASS', 'SearXNG Gateway', `Reachable at ${searxngBaseUrlStr}`);
      } else {
        report('WARN', 'SearXNG Gateway', `Reachable but returned status ${res.status}`);
      }
    } catch (err) {
      report('WARN', 'SearXNG Gateway', `Offline at ${searxngBaseUrlStr}: ${err.message}`);
    }
  } else {
    report('PASS', 'SearXNG Gateway', 'Disabled (WEB_AUTO_SEARCH is not "true")');
  }

  const dirsToCheck = [
    { name: 'models/huggingface', path: path.join(rootDir, 'models', 'huggingface') },
    { name: 'temp', path: path.join(rootDir, 'temp') },
    { name: 'logs', path: path.join(rootDir, 'logs') },
    { name: 'outputs', path: path.join(rootDir, 'outputs') },
    { name: 'saved_generations', path: path.join(rootDir, 'saved_generations') },
  ];

  for (const dir of dirsToCheck) {
    try {
      if (fs.existsSync(dir.path)) report('PASS', `Dir: ${dir.name}`, 'Exists');
      else {
        fs.mkdirSync(dir.path, { recursive: true });
        report('PASS', `Dir: ${dir.name}`, 'Created successfully');
      }
    } catch (err) {
      report('FAIL', `Dir: ${dir.name}`, `Failed to verify/create path '${dir.path}': ${err.message}`);
    }
  }

  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const lines = envContent.split(/\r?\n/);
    const placeholderWarnings = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      if (val && looksLikePlaceholder(val)) placeholderWarnings.push(`${key} (Line ${i + 1})`);
    }
    if (placeholderWarnings.length > 0) {
      report('WARN', 'Secret Scanner', `Placeholder values still present: ${placeholderWarnings.join(', ')}`);
    } else {
      report('PASS', 'Secret Scanner', 'No obvious default placeholders remaining');
    }
  } catch (err) {
    report('WARN', 'Secret Scanner', `Failed to scan .env file: ${err.message}`);
  }

  summarizeAndExit();
}

run().catch((err) => {
  console.error(`${colors.red}Fatal Doctor Crash:${colors.reset}`, err);
  process.exitCode = 1;
});
