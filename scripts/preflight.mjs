// SeekDeep preflight runner — replaces the manual "node --check + py_compile +
// smoke test" sequence with a single command. Runs each stage, prints a green
// or red one-liner per stage, exits non-zero on any failure.
//
// Usage:
//   npm run preflight
//   node scripts/preflight.mjs
//
// Stages (skip a stage by passing --skip-<stage>):
//   js     — node --check index.js, smoke_test.mjs, scripts/preflight.mjs
//   py     — python -m py_compile local_ai_server.py warmup_local_cache.py
//   smoke  — node smoke_test.mjs
//
// Exit code 0 only when EVERY stage passes (or was skipped).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const argv = new Set(process.argv.slice(2));
const skip = (name) => argv.has(`--skip-${name}`);

const stages = [];
const t0 = Date.now();

function stage(name, fn) {
  if (skip(name)) {
    stages.push({ name, ok: true, skipped: true, ms: 0 });
    console.log(`  --  ${name.padEnd(8)} skipped`);
    return;
  }
  const start = Date.now();
  let ok = true;
  let detail = '';
  try {
    const result = fn();
    if (result === false) ok = false;
    if (result && typeof result === 'object') {
      ok = result.ok !== false;
      detail = result.detail || '';
    }
  } catch (err) {
    ok = false;
    detail = err?.message || String(err);
  }
  const ms = Date.now() - start;
  stages.push({ name, ok, ms, detail });
  const marker = ok ? '  ok ' : ' FAIL';
  const line = `${marker} ${name.padEnd(8)} ${ms}ms${detail ? ' :: ' + detail : ''}`;
  console.log(line);
}

function checkJsFile(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return { ok: false, detail: `${rel} missing` };
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { ok: false, detail: `${rel}: ${(r.stderr || '').split('\n').filter(Boolean)[0] || 'parse error'}` };
  }
  return { ok: true };
}

function runSmokeTest() {
  const r = spawnSync(process.execPath, ['smoke_test.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const tail = (r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    return { ok: false, detail: tail || (r.stderr || '').slice(0, 120) };
  }
  // Pull "pass=N fail=M" off the tail for a clean detail line.
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  return { ok: true, detail: tail };
}

function runPyCompile() {
  const venvPy = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const py = existsSync(venvPy) ? venvPy : 'python';
  // gui_endpoints.py is owned by us with extensive audit overrides; a parse
  // regression there silently breaks the entire GUI write side at boot.
  const targets = ['local_ai_server.py', 'warmup_local_cache.py', 'gui_endpoints.py']
    .filter((f) => existsSync(path.join(ROOT, f)));
  if (!targets.length) return { ok: true, detail: 'no python files to compile' };
  const r = spawnSync(py, ['-m', 'py_compile', ...targets], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').split('\n').filter(Boolean)[0] || 'compile error';
    return { ok: false, detail: err.slice(0, 160) };
  }
  return { ok: true, detail: targets.join(', ') };
}

console.log('SeekDeep preflight');
console.log('-------------------');

stage('js', () => {
  // Parse-check every JS file we ship. gui/nav.js carries the GUI's auth
  // interceptor + jump palette + SeekDeepPrompt API — a parse error there
  // silently breaks every page.
  const targets = ['index.js', 'smoke_test.mjs', 'scripts/preflight.mjs', 'gui/nav.js', 'gui/events.js', 'gui/version.js'];
  for (const t of targets) {
    if (!existsSync(path.join(ROOT, t))) continue;
    const r = checkJsFile(t);
    if (!r.ok) return r;
  }
  return { ok: true, detail: targets.filter((t) => existsSync(path.join(ROOT, t))).join(', ') };
});

stage('py', () => runPyCompile());
stage('smoke', () => runSmokeTest());

const failed = stages.filter((s) => !s.ok);
const passed = stages.filter((s) => s.ok && !s.skipped);
const skipped = stages.filter((s) => s.skipped);

console.log('-------------------');
console.log(`${passed.length} ok · ${failed.length} fail · ${skipped.length} skipped · ${Date.now() - t0}ms`);

if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
