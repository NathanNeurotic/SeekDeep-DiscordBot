#!/usr/bin/env node
// DUP-3 guard: every env var the code reads must be documented in .env.example
// (the full reference) or listed in IGNORE below (system / third-party / internal
// keys that are not SeekDeep knobs). Keeps the "is there a knob for X?" reference
// honest — a new SEEKDEEP_* env added in code can't silently go undocumented.
//
// Run with --report to just print the gap (for triage); default exits non-zero on
// any undocumented key.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };
const REPORT = process.argv.includes('--report');

// --- keys documented in the env templates (incl. commented `# KEY=` examples) ---
function documentedKeys() {
  const keys = new Set();
  for (const f of ['.env.example', '.env.default']) {
    for (const line of read(f).split('\n')) {
      const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

// --- env keys referenced in code (Node + Python + Rust; browser gui/*.js excluded) ---
const JS_FILES = ['index.js', 'scripts/preflight.mjs', 'scripts/run-python.mjs', 'scripts/doctor.mjs', 'scripts/audit_endpoint_coverage.mjs', 'scripts/check-release-files.mjs', 'lib/url-fetch-policy.js'];
const PY_FILES = ['local_ai_server.py', 'gui_endpoints.py', 'warmup_local_cache.py', 'release_signing.py', 'scripts/gen_release_keypair.py', 'scripts/sign_release_manifest.py'];
const RUST_FILES = ['src-tauri/src/sidecar.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/main.rs'];

function codeKeys() {
  const refs = new Map();
  const add = (k, f) => { (refs.get(k) || refs.set(k, new Set()).get(k)).add(f); };
  for (const f of JS_FILES) {
    const s = read(f);
    // Gemini: \b word-boundary on every env-extraction pattern so a custom helper
    // (custom_getenv, my_environ, myprocess.env, …) can't substring-match and add a
    // phantom key. Real os.getenv / process.env / env::var all sit on a boundary.
    for (const m of s.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) add(m[1], f);
    for (const m of s.matchAll(/\bprocess\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) add(m[1], f);
  }
  for (const f of PY_FILES) {
    const s = read(f);
    // Gemini: `os.` optional so `from os import getenv, environ` callers are caught too.
    for (const m of s.matchAll(/\b(?:os\.)?getenv\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) add(m[1], f);
    for (const m of s.matchAll(/\b(?:os\.)?environ\.get\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) add(m[1], f);
    for (const m of s.matchAll(/\b(?:os\.)?environ\.setdefault\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) add(m[1], f);
    for (const m of s.matchAll(/\b(?:os\.)?environ\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g)) add(m[1], f);
  }
  // CI-4: the Rust shell reads env too (std::env::var) — scan it so a Tauri knob
  // (e.g. SEEKDEEP_PYTHON) can't silently go undocumented.
  for (const f of RUST_FILES) {
    const s = read(f);
    for (const m of s.matchAll(/\benv::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]+)"/g)) add(m[1], f);
  }
  return refs;
}

// --- keys that are legitimately NOT user-facing SeekDeep knobs ---
// System / CI / test-runner env, build-only secrets, and internal IPC flags the
// launcher sets — none belong in the user-facing .env reference.
const IGNORE = new Set([
  'CI',                            // CI detection (set by the CI runner)
  'PYTEST_CURRENT_TEST',           // pytest internal
  'VIRTUAL_ENV',                   // Python venv standard
  'GITHUB_TOKEN',                  // standard GitHub token (self-update rate limit)
  'SEEKDEEP_TEST_MODE',            // test-harness flag (smoke_test.mjs / pytest)
  'SEEKDEEP_FRESH_BOOT',           // internal IPC flag the launcher sets, not user-set
  'SEEKDEEP_RELEASE_SIGNING_SEED', // BUILD SECRET — only the signing script reads it; never goes in .env
]);
const IGNORE_PREFIX = [];

// Best-effort: pull a key's default value out of code, for --scaffold.
function defaultFor(key) {
  for (const f of JS_FILES) {
    // Gemini: also match bracket notation process.env['KEY'] (codeKeys does).
    const m = read(f).match(new RegExp('\\bprocess\\.env(?:\\.' + key + '|\\[\\s*[\'"]' + key + '[\'"]\\s*\\])\\s*(?:\\|\\||\\?\\?)\\s*([^\\s);,&|}]+)'));
    if (m) return m[1].replace(/^['"]|['"]$/g, '');
  }
  for (const f of PY_FILES) {
    // Gemini: `os.` optional + include environ.setdefault, matching codeKeys.
    const m = read(f).match(new RegExp('\\b(?:os\\.)?(?:getenv|environ\\.get|environ\\.setdefault)\\(\\s*["\\\']' + key + '["\\\']\\s*,\\s*([^\\),]+)'));
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

const documented = documentedKeys();
const refs = codeKeys();
const undocumented = [...refs.keys()].filter((k) =>
  !documented.has(k) && !IGNORE.has(k) && !IGNORE_PREFIX.some((p) => k.startsWith(p)),
).sort();

if (process.argv.includes('--scaffold')) {
  for (const k of undocumented) console.log(`${k}=${defaultFor(k)}`);
  process.exit(0);
}

if (REPORT) {
  console.log(`code keys: ${refs.size} · documented: ${documented.size} · undocumented (minus ignore): ${undocumented.length}\n`);
  for (const k of undocumented) console.log(`${k}\t<- ${[...refs.get(k)].join(', ')}`);
  process.exit(0);
}

if (undocumented.length) {
  console.error(`DUP-3: ${undocumented.length} env key(s) read by code but not in .env.example (and not ignore-listed):`);
  for (const k of undocumented) console.error(`  - ${k}  (${[...refs.get(k)].join(', ')})`);
  console.error('\nFix: document each in .env.example, or add genuinely-non-knob keys to IGNORE in scripts/check-env-coverage.mjs.');
  process.exit(1);
}
console.log(`env-coverage: all ${refs.size} code-referenced env keys are documented (or ignore-listed)`);
