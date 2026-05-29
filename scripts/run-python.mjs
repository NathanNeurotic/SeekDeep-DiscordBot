#!/usr/bin/env node
// SeekDeep · cross-platform venv-python launcher (audit FIX-2)
// =============================================================
// npm script strings can't branch on OS, so the package.json entries that
// used to hardcode ".venv\Scripts\python.exe" (Windows-only) route through
// this instead: `node scripts/run-python.mjs <script.py> [args...]`.
//
// Resolution order (first existing wins), matching the convention the rest
// of the toolchain uses but adding the POSIX layout:
//   1. .venv/Scripts/python.exe   (Windows venv)
//   2. .venv/bin/python           (POSIX venv)
//   3. python3 / python on PATH   (no venv — best effort)
//
// Behavior on Windows is unchanged (still picks .venv/Scripts/python.exe when
// present). The win: the same `npm run setup:models` etc. now work on Linux
// and macOS clones too, instead of failing on a backslash path.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolvePython() {
  const candidates = process.platform === 'win32'
    ? [path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
       path.join(ROOT, '.venv', 'bin', 'python')]
    : [path.join(ROOT, '.venv', 'bin', 'python'),
       path.join(ROOT, '.venv', 'bin', 'python3'),
       path.join(ROOT, '.venv', 'Scripts', 'python.exe')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // No venv found — fall back to PATH python so the command at least tries.
  return process.platform === 'win32' ? 'python' : 'python3';
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('run-python.mjs: expected a python script path as the first argument');
  process.exit(2);
}

const py = resolvePython();
const r = spawnSync(py, args, { stdio: 'inherit', cwd: ROOT });
if (r.error) {
  console.error(`run-python.mjs: failed to launch ${py}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status == null ? 1 : r.status);
