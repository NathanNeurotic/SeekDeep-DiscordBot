import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Helper to colorize output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function formatStatus(status) {
  if (status === 'PASS') return `${colors.green}[PASS]${colors.reset}`;
  if (status === 'WARN') return `${colors.yellow}[WARN]${colors.reset}`;
  if (status === 'FAIL') return `${colors.red}[FAIL]${colors.reset}`;
  return `[${status}]`;
}

console.log(`${colors.cyan}${colors.bold}=== SeekDeep Doctor Setup Diagnostics ===${colors.reset}\n`);

let passCount = 0;
let warnCount = 0;
let failCount = 0;

function report(status, category, message) {
  if (status === 'PASS') passCount++;
  else if (status === 'WARN') warnCount++;
  else if (status === 'FAIL') failCount++;
  console.log(`${formatStatus(status)} ${colors.bold}${category.padEnd(20)}:${colors.reset} ${message}`);
}

// Fetch helper with explicit timeout cleanup to prevent active handles on exit
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function run() {
  // 1. Node Version Check
  try {
    const rawVersion = process.version;
    const major = parseInt(rawVersion.substring(1), 10);
    if (major >= 20) {
      report('PASS', 'Node Version', `${rawVersion} (>= 20 required)`);
    } else {
      report('FAIL', 'Node Version', `${rawVersion} is below required v20. Please upgrade Node.`);
    }
  } catch (err) {
    report('FAIL', 'Node Version', `Failed to determine Node version: ${err.message}`);
  }

  // 2. npm Availability Check
  try {
    const npmVersion = execSync('npm -v', { stdio: 'pipe' }).toString().trim();
    report('PASS', 'npm CLI', `v${npmVersion} is available`);
  } catch (err) {
    report('FAIL', 'npm CLI', `npm command not found or failed to execute: ${err.message}`);
  }

  // 3. Check .env.example
  const envExamplePath = path.join(rootDir, '.env.example');
  const envExampleExists = fs.existsSync(envExamplePath);
  if (envExampleExists) {
    report('PASS', '.env.example', 'File exists');
  } else {
    report('WARN', '.env.example', 'Missing from repository root');
  }

  // 4. Check .env existence & load
  const envPath = path.join(rootDir, '.env');
  const envExists = fs.existsSync(envPath);
  if (!envExists) {
    report('FAIL', '.env File', 'Missing from repository root. Copy .env.example to .env to configure.');
    summarizeAndExit();
    return;
  }
  report('PASS', '.env File', 'File exists');

  // Load environment variables manually
  dotenv.config({ path: envPath });

  // 5. Discord Credentials Presence (without printing values)
  const token = process.env.DISCORD_TOKEN;
  if (!token || token.trim() === '') {
    report('FAIL', 'DISCORD_TOKEN', 'Missing or empty in .env');
  } else if (token.includes('YOUR_') || token.includes('TOKEN_HERE')) {
    report('FAIL', 'DISCORD_TOKEN', 'Still set to default placeholder value');
  } else {
    report('PASS', 'DISCORD_TOKEN', 'Present (masked for security)');
  }

  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId || clientId.trim() === '') {
    report('FAIL', 'DISCORD_CLIENT_ID', 'Missing or empty in .env');
  } else if (clientId.includes('YOUR_') || clientId.includes('CLIENT_ID_HERE')) {
    report('FAIL', 'DISCORD_CLIENT_ID', 'Still set to default placeholder value');
  } else {
    report('PASS', 'DISCORD_CLIENT_ID', 'Present (masked for security)');
  }

  // 6. Check URL Configuration
  const localAiBaseUrlStr = process.env.LOCAL_AI_BASE_URL || 'http://127.0.0.1:7865';
  let localAiUrl;
  try {
    localAiUrl = new URL(localAiBaseUrlStr);
    report('PASS', 'LOCAL_AI_BASE_URL', `Valid URL: ${localAiBaseUrlStr}`);
  } catch (err) {
    report('FAIL', 'LOCAL_AI_BASE_URL', `Invalid URL format '${localAiBaseUrlStr}': ${err.message}`);
  }

  // 7. Network Probes (Local AI Server /health and /gpu)
  if (localAiUrl) {
    const startupTimeout = parseInt(process.env.SEEKDEEP_STARTUP_HEALTH_TIMEOUT_MS || '4000', 10);
    
    // Probe health
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
        report('WARN', 'Local AI /health', `Offline (Server returned status ${res.status})`);
      }
    } catch (err) {
      report('WARN', 'Local AI /health', `Offline (Could not reach local AI server at ${localAiBaseUrlStr}: ${err.message})`);
    }

    // Probe gpu
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
        report('WARN', 'Local AI /gpu', `Offline (Server returned status ${res.status})`);
      }
    } catch (err) {
      report('WARN', 'Local AI /gpu', `Offline (Could not reach local AI server at ${localAiBaseUrlStr})`);
    }
  }

  // 8. SearXNG Check
  const webSearchEnabled = process.env.WEB_AUTO_SEARCH === 'true' || process.env.WEB_SEARCH_PROVIDER === 'searxng';
  const searxngBaseUrlStr = process.env.SEARXNG_BASE_URL || 'http://127.0.0.1:8080';
  if (webSearchEnabled) {
    try {
      const searxngUrl = new URL(searxngBaseUrlStr);
      const res = await fetchWithTimeout(searxngUrl.href, 3000);
      if (res.ok || res.status === 404 || res.status === 403 || res.status === 401) {
        report('PASS', 'SearXNG Gateway', `Online at ${searxngBaseUrlStr}`);
      } else {
        report('WARN', 'SearXNG Gateway', `Offline (Returned status ${res.status} at ${searxngBaseUrlStr})`);
      }
    } catch (err) {
      report('WARN', 'SearXNG Gateway', `Offline (Could not reach SearXNG at ${searxngBaseUrlStr}: ${err.message})`);
    }
  } else {
    report('PASS', 'SearXNG Gateway', 'Disabled (WEB_AUTO_SEARCH is not enabled)');
  }

  // 9. Directories Check & Create
  const dirsToCheck = [
    { name: 'models/huggingface', path: path.join(rootDir, 'models', 'huggingface') },
    { name: 'temp', path: path.join(rootDir, 'temp') },
    { name: 'logs', path: path.join(rootDir, 'logs') },
    { name: 'outputs', path: path.join(rootDir, 'outputs') },
    { name: 'saved_generations', path: path.join(rootDir, 'saved_generations') }
  ];

  for (const dir of dirsToCheck) {
    try {
      if (fs.existsSync(dir.path)) {
        report('PASS', `Dir: ${dir.name}`, 'Exists');
      } else {
        fs.mkdirSync(dir.path, { recursive: true });
        report('PASS', `Dir: ${dir.name}`, 'Created successfully');
      }
    } catch (err) {
      report('FAIL', `Dir: ${dir.name}`, `Failed to verify/create path '${dir.path}': ${err.message}`);
    }
  }

  // 10. Secret Scanner Sanity Check
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const lines = envContent.split(/\r?\n/);
    let placeholderWarnings = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      
      const parts = line.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      
      // Look for placeholders
      if (val && (val.includes('YOUR_') || val.includes('TOKEN_HERE') || val.includes('CLIENT_ID_HERE') || val.includes('KEY_HERE'))) {
        placeholderWarnings.push(`${key} (Line ${i + 1})`);
      }
    }
    
    if (placeholderWarnings.length > 0) {
      report('WARN', 'Secret Scanner', `The following environment keys contain placeholder values: ${placeholderWarnings.join(', ')}`);
    } else {
      report('PASS', 'Secret Scanner', 'No obvious default placeholders remaining');
    }
  } catch (err) {
    report('WARN', 'Secret Scanner', `Failed to scan .env file: ${err.message}`);
  }

  summarizeAndExit();
}

function summarizeAndExit() {
  console.log(`\n${colors.cyan}${colors.bold}=== Diagnostics Summary ===${colors.reset}`);
  console.log(`${formatStatus('PASS')} ${passCount} checks passed`);
  console.log(`${formatStatus('WARN')} ${warnCount} warnings generated`);
  console.log(`${formatStatus('FAIL')} ${failCount} checks failed\n`);

  if (failCount > 0) {
    console.log(`${colors.red}${colors.bold}SeekDeep doctor has found required setup errors. Please resolve the [FAIL] lines above.${colors.reset}`);
    process.exitCode = 1;
  } else {
    console.log(`${colors.green}${colors.bold}SeekDeep doctor completed successfully. Setup is ready to run.${colors.reset}`);
    process.exitCode = 0;
  }
}

run().catch((err) => {
  console.error(`${colors.red}Fatal Doctor Crash:${colors.reset}`, err);
  process.exitCode = 1;
});
