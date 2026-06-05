// SeekDeep preflight runner — replaces the manual "node --check + py_compile +
// smoke test" sequence with a single command. Runs each stage, prints a green
// or red one-liner per stage, exits non-zero on any failure.
//
// Usage:
//   npm run preflight
//   node scripts/preflight.mjs
//
// Stages (skip a stage by passing --skip-<stage>):
//   js         — node --check on every JS file we ship (index, smoke, preflight, gui/*.js)
//   html-js    — node --check on every inline <script> block in gui/*.html
//                (skips src=, type=text/babel, type=module). Catches inline-script
//                parse errors that previously shipped without CI noticing.
//   py         — python -m py_compile on every .py we ship (server, warmup, gui_endpoints)
//   smoke      — node smoke_test.mjs (no Discord login, no model load)
//   gui-smoke  — python scripts/smoke_gui_endpoints.py (token auth + /config/status
//                + /events WS + /data/* normalizers via TestClient).
//                Self-skips if fastapi/httpx/pydantic aren't importable.
//
// Exit code 0 only when EVERY stage passes (or was skipped).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  const targets = ['local_ai_server.py', 'warmup_local_cache.py', 'gui_endpoints.py', 'release_signing.py',
                   'scripts/gen_release_keypair.py', 'scripts/sign_release_manifest.py']
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

function runGuiSmoke() {
  // End-to-end check for the FastAPI side-car (token auth, /config/status,
  // /events WS round-trip, /data/* normalizers). Lives in Python because
  // it imports gui_endpoints + uses fastapi.TestClient. Needs only fastapi
  // + httpx + pydantic installed (NOT torch/transformers/etc).
  const venvPy = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const py = existsSync(venvPy) ? venvPy : 'python';
  const script = path.join(ROOT, 'scripts', 'smoke_gui_endpoints.py');
  if (!existsSync(script)) return { ok: true, detail: 'script missing; skipped' };
  // Skip cleanly if fastapi isn't importable -- e.g. CI without the deps yet.
  const probe = spawnSync(py, ['-c', 'import fastapi, httpx, pydantic'],
    { cwd: ROOT, encoding: 'utf8' });
  if (probe.status !== 0) {
    return { ok: true, detail: 'fastapi/httpx/pydantic not installed; skipped' };
  }
  const r = spawnSync(py, [script], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    // Surface the failure summary line if present
    const lines = (r.stdout || r.stderr || '').trim().split('\n');
    const fail = lines.find((l) => /FAIL|fail$/i.test(l)) || lines.slice(-1)[0] || 'gui-smoke failed';
    return { ok: false, detail: fail.slice(0, 160) };
  }
  const tail = (r.stdout || '').trim().split('\n').slice(-1)[0] || '';
  return { ok: true, detail: tail };
}

console.log('SeekDeep preflight');
console.log('-------------------');

stage('js', () => {
  // Parse-check every JS file we ship. gui/nav.js carries the GUI's auth
  // interceptor + jump palette + SeekDeepPrompt API — a parse error there
  // silently breaks every page.
  const targets = ['index.js', 'lib/url-fetch-policy.js', 'smoke_test.mjs', 'scripts/preflight.mjs', 'scripts/run-python.mjs', 'scripts/audit_endpoint_coverage.mjs', 'scripts/check-release-files.mjs', 'scripts/check-env-coverage.mjs', 'gui/nav.js', 'gui/events.js', 'gui/version.js', 'gui/fetch.js', 'gui/playground.js', 'gui/stats.js', 'gui/ml-deps.js', 'gui/model-install.js', 'gui/notify.js', 'gui/updater.js', 'gui/launcher.js', 'gui/config-render.js', 'gui/emoji-vault.js', 'gui/force-react.js', 'gui/tts.js', 'gui/bot-bridge.js', 'gui/add-model.page.js', 'gui/boot.page.js', 'gui/changelog.page.js', 'gui/architecture.page.js', 'gui/docs.page.js', 'gui/image-ab.page.js', 'gui/index.page.js', 'gui/personas.page.js', 'gui/roadmap.page.js', 'gui/pitch.page.js', 'gui/prompts.page.js', 'gui/setup-wizard.page.js', 'gui/tour.page.js', 'gui/api.page.js', 'gui/memory.page.js', 'gui/seekdeep-loading.page.js', 'gui/settings.page.js', 'gui/docs.flags.page.js', 'gui/chat.page1.js', 'gui/chat.page2.js', 'gui/chat.page3.js'];
  for (const t of targets) {
    if (!existsSync(path.join(ROOT, t))) continue;
    const r = checkJsFile(t);
    if (!r.ok) return r;
  }
  return { ok: true, detail: targets.filter((t) => existsSync(path.join(ROOT, t))).join(', ') };
});

stage('html-js', () => {
  // Inline-script parse check. Every <script>...</script> block in gui/*.html
  // that DOES NOT have a src= attribute and is NOT type="text/babel" (those
  // are JSX transformed at runtime by @babel/standalone) gets extracted and
  // run through `node --check`. AUD-013 — previously a parse error in an
  // inline script shipped without CI noticing because preflight only checked
  // top-level .js files.
  const guiDir = path.join(ROOT, 'gui');
  if (!existsSync(guiDir)) return { ok: true, detail: 'no gui/ dir' };
  const htmlFiles = readdirSync(guiDir).filter((f) => f.endsWith('.html'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sd-html-js-'));
  let checked = 0;
  let failure = null;
  try {
    // Greedy regex over inline scripts. Skip the open tag if it has src= or
    // type="text/babel"/"module" markers we can't node-check.
    //
    // CRITICAL: strip <style>…</style> blocks and <!-- … --> HTML comments
    // first. Otherwise the word "<script>" appearing inside a CSS comment or
    // an HTML doc-comment would match SCRIPT_RE and the scanner would
    // happily try to parse hundreds of lines of CSS + HTML as JavaScript.
    const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    const stripNonJs = (s) => s
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    for (const file of htmlFiles) {
      if (failure) break;
      const html = stripNonJs(readFileSync(path.join(guiDir, file), 'utf8'));
      let m;
      let i = 0;
      while ((m = SCRIPT_RE.exec(html)) !== null) {
        const attrs = m[1] || '';
        const body  = m[2] || '';
        if (/\bsrc\s*=/i.test(attrs)) continue;
        if (/\btype\s*=\s*["']?text\/babel/i.test(attrs)) continue;
        if (/\btype\s*=\s*["']?module/i.test(attrs)) continue;
        if (!body.trim()) continue;
        i++;
        const tmpJs = path.join(tmp, `${path.basename(file, '.html')}-${i}.js`);
        writeFileSync(tmpJs, body, 'utf8');
        const r = spawnSync(process.execPath, ['--check', tmpJs], { encoding: 'utf8' });
        checked++;
        if (r.status !== 0) {
          const err = (r.stderr || '').split('\n').filter(Boolean)[0] || 'parse error';
          failure = { ok: false, detail: `gui/${file} block #${i}: ${err.slice(0, 160)}` };
          break;
        }
      }
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  if (failure) return failure;
  return { ok: true, detail: `${checked} inline blocks across ${htmlFiles.length} html files` };
});

stage('py', () => runPyCompile());
stage('smoke', () => runSmokeTest());
stage('gui-smoke', () => runGuiSmoke());

// SEC-2: type-check the Rust desktop shell. cargo check catches a broken
// sidecar.rs / lib.rs before it reaches an MSI build. Skip-with-warn when
// cargo isn't installed (most contributors editing JS/Python won't have a
// Rust toolchain) so this never blocks a non-Rust change — but on machines
// + CI that DO have cargo, a Rust compile error fails preflight.
stage('rust', () => {
  const manifest = path.join(ROOT, 'src-tauri', 'Cargo.toml');
  if (!existsSync(manifest)) return { ok: true, detail: 'no src-tauri/Cargo.toml' };
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    // Not a failure — just absent. Warn so the gap is visible.
    return { ok: true, detail: 'cargo not installed — skipped (install Rust to type-check the desktop shell)' };
  }
  // On Linux, Tauri's webview links GTK/webkit/glib via pkg-config. When those
  // system libs are absent — the lightweight CI preflight runner (ubuntu-latest
  // ships cargo but NOT the GTK stack), or a contributor without them — cargo
  // check fails on a -sys crate with a pkg-config/gobject error: an ENVIRONMENT
  // gap, not a code error. Skip-with-warn; the dedicated `rust` CI job installs
  // the libs and runs the real check. (Windows/macOS Tauri don't use GTK, so the
  // probe is Linux-only and local cargo check still runs there.)
  if (process.platform === 'linux') {
    const pk = spawnSync('pkg-config', ['--exists', 'gtk+-3.0'], { encoding: 'utf8' });
    if (pk.error || pk.status !== 0) {
      return { ok: true, detail: 'Tauri GTK/webkit system libs absent — skipped (the dedicated rust CI job runs the real cargo check)' };
    }
  }
  const r = spawnSync('cargo', ['check', '--quiet', '--manifest-path', manifest], {
    encoding: 'utf8', cwd: ROOT,
  });
  if (r.status !== 0) {
    const err = (r.stderr || '');
    // Belt-and-suspenders: a missing system library (GTK/webkit/glib/gobject)
    // is an environment gap, not a code error — skip rather than fail. A real
    // Rust compile error has none of these markers and still fails preflight.
    if (/pkg-config|gobject-2\.0|gtk\+?-3\.0|webkit2?gtk|could not find system library/i.test(err)) {
      return { ok: true, detail: 'Tauri system libs absent (pkg-config/GTK) — skipped; dedicated rust CI job runs the real check' };
    }
    const tail = err.split('\n').filter(Boolean).slice(-3).join(' | ');
    return { ok: false, detail: `cargo check failed: ${tail.slice(0, 240)}` };
  }
  return { ok: true, detail: `cargo check clean (${(probe.stdout || '').trim()})` };
});

// CRIT-3: docs drift guard. Fail-closed assertions so the version-filename,
// memory-default, and smoke-count drift the audit found (DOC-1 / CONF-1 /
// DOC-2) cannot silently come back. Pure string/file checks — fast, no
// network, no server boot.
stage('docs', () => {
  const problems = [];

  // (a) DOC-1: README must not hardcode a SeekDeep_<x.y.z>_ download
  // filename — those drift from package.json every release. The canonical
  // form is the SeekDeep_<version>_ placeholder.
  const readmePath = path.join(ROOT, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    const hard = readme.match(/SeekDeep_\d+\.\d+\.\d+[_-]/g);
    if (hard && hard.length) {
      problems.push(`README hardcodes version filename(s): ${[...new Set(hard)].join(', ')} — use SeekDeep_<version>_ (DOC-1)`);
    }
  }

  // (b) CONF-1: the four rolling-memory caps in .env.example must match
  // .env.default (the canonical source). Drift here is exactly the bug
  // CONF-1 fixed.
  const memKeys = ['MAX_CONTEXT_MESSAGES', 'MAX_CONTEXT_CHARS',
                   'SEEKDEEP_MEMORY_RECENT_ENTRIES', 'SEEKDEEP_MEMORY_CONTEXT_CHARS'];
  const readEnv = (rel) => {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) return null;
    const map = {};
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) map[m[1]] = m[2].trim();
    }
    return map;
  };
  const def = readEnv('.env.default');
  const ex = readEnv('.env.example');
  if (def && ex) {
    for (const k of memKeys) {
      if (def[k] != null && ex[k] != null && def[k] !== ex[k]) {
        problems.push(`.env.example ${k}=${ex[k]} != .env.default ${k}=${def[k]} (CONF-1)`);
      }
    }
    // Superset invariant (MAINTAINER.md 4.4): .env.example documents EVERY
    // committed key. A key in .env.default but absent from .env.example means a
    // user reading the reference can't discover it. Enforce what was a manual
    // `comm -13` check so it can't silently drift again.
    const missingInExample = Object.keys(def).filter((k) => !(k in ex)).sort();
    if (missingInExample.length) {
      problems.push(`.env.example missing ${missingInExample.length} key(s) present in .env.default (superset invariant, MAINTAINER.md 4.4): ${missingInExample.slice(0, 10).join(', ')}`);
    }
  }

  // (c) DOC-2: the smoke total must be read live. Assert smoke_test.mjs still
  // prints a `pass=<N>` line (the live-count mechanism the README now points
  // at) so nobody silently replaces it with a frozen number.
  const smokePath = path.join(ROOT, 'smoke_test.mjs');
  if (existsSync(smokePath)) {
    const smoke = readFileSync(smokePath, 'utf8');
    if (!/pass=/.test(smoke)) {
      problems.push('smoke_test.mjs no longer prints a live `pass=` total (DOC-2)');
    }
  }

  // (d) Version-sync: package.json (the SoT _read_pkg_version reads), src-tauri/
  // Cargo.toml (env!("CARGO_PKG_VERSION")), and the seekdeep entry in Cargo.lock
  // must agree — drift makes the Rust shell report a different version than the
  // bundled Python server, so the boot-time stale-server guard misfires every
  // launch. (These three are bumped by hand each release; this catches a typo.)
  const pkgPath = path.join(ROOT, 'package.json');
  const cargoTomlPath = path.join(ROOT, 'src-tauri', 'Cargo.toml');
  const cargoLockPath = path.join(ROOT, 'src-tauri', 'Cargo.lock');
  if (existsSync(pkgPath) && existsSync(cargoTomlPath)) {
    let pkgVer = null;
    try { pkgVer = JSON.parse(readFileSync(pkgPath, 'utf8')).version; } catch { problems.push('package.json is not valid JSON'); }
    const tomlVer = (readFileSync(cargoTomlPath, 'utf8').match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
    if (pkgVer && tomlVer && pkgVer !== tomlVer) {
      problems.push(`version drift: package.json ${pkgVer} != src-tauri/Cargo.toml ${tomlVer}`);
    }
    if (pkgVer && existsSync(cargoLockPath)) {
      const lockVer = (readFileSync(cargoLockPath, 'utf8').match(/name = "seekdeep"\r?\nversion = "([^"]+)"/) || [])[1];
      if (lockVer && pkgVer !== lockVer) {
        problems.push(`version drift: package.json ${pkgVer} != Cargo.lock seekdeep ${lockVer} (run cargo build to sync the lock)`);
      }
    }
    // CI-2: package-lock.json drifted unnoticed (it lagged ~19 patch versions)
    // because the version-sync guard didn't include it. npm ci tolerates a
    // root-version mismatch, so it never red-X'd CI — guard it explicitly.
    const pkgLockPath = path.join(ROOT, 'package-lock.json');
    if (pkgVer && existsSync(pkgLockPath)) {
      let plVer = null;
      try {
        const pl = JSON.parse(readFileSync(pkgLockPath, 'utf8'));
        plVer = pl.version || pl.packages?.['']?.version || null;
      } catch { problems.push('package-lock.json is not valid JSON'); }
      if (plVer && pkgVer !== plVer) {
        problems.push(`version drift: package.json ${pkgVer} != package-lock.json ${plVer} (run npm install --package-lock-only)`);
      }
    }
  }

  // (e) AUD-005: canonical-doc drift guards. The code is safer than the docs
  // were — and stale docs are how safer code gets "simplified" back into unsafe
  // code. Fail-closed on the three drifts the audit found. Scoped to the
  // maintainer/user docs that teach future agents; docs/audits/* legitimately
  // QUOTE the stale phrases as evidence, so they are intentionally NOT scanned.
  const CANON_DOCS = ['README.md', 'SECURITY.md', 'INTEGRATION.md', 'MAINTAINER.md', 'CODEX_REPO_BRIEF.md', 'AGENTS.md'];
  for (const rel of CANON_DOCS) {
    const p = path.join(ROOT, rel);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const ln = i + 1;
      // AUD-005a: no doc may claim img2img is ON by default (code default is off).
      if (/IMG2IMG/.test(line) && /\bon by default\b/i.test(line)) {
        problems.push(`${rel}:${ln} claims IMG2IMG is "on by default" — code defaults off (AUD-005)`);
      }
      // AUD-005b: no doc may claim /logs/* or sensitive /data/* are OPEN reads
      // (both are token-gated now).
      if (/\/(logs|data)\/\*/.test(line) && /\bopen\b/i.test(line)) {
        problems.push(`${rel}:${ln} claims '/logs/*' or '/data/*' is an open read — both are token-gated (AUD-005)`);
      }
      // AUD-005c: the snapshot file is singular (archive-snapshot.json).
      if (/archive-snapshots\.json/.test(line)) {
        problems.push(`${rel}:${ln} references 'archive-snapshots.json' — the file is singular 'archive-snapshot.json' (AUD-005)`);
      }
    });
  }

  // DUP-1: the four runtime-file lists (self-update / signing / bundle / extract)
  // must stay in sync with release-files.json. Delegate to the dedicated guard.
  {
    const rf = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-release-files.mjs')], { cwd: ROOT, encoding: 'utf8' });
    if (rf.status !== 0) {
      const msg = (rf.stderr || rf.stdout || 'release-files guard failed').trim().replace(/\s*\n\s*/g, ' ');
      problems.push(`release-files: ${msg}`);
    }
  }

  // DUP-3: every env var the code reads must be documented in .env.example (or be
  // in the guard's ignore-list of system/test/build-secret keys).
  {
    const ec = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-env-coverage.mjs')], { cwd: ROOT, encoding: 'utf8' });
    if (ec.status !== 0) {
      const msg = (ec.stderr || ec.stdout || 'env-coverage guard failed').trim().replace(/\s*\n\s*/g, ' ');
      problems.push(`env-coverage: ${msg}`);
    }
  }

  if (problems.length) return { ok: false, detail: problems.join(' · ') };
  return { ok: true, detail: 'version-filenames placeholder · env caps aligned · smoke total live · version-sync ok · doc-drift guards ok · release-files ok · env-coverage ok' };
});

// AUD-006: endpoint→GUI/test coverage map drift guard. Regenerates the map in
// memory and fails if docs/ENDPOINT_COVERAGE.md is stale, so an endpoint
// rename / auth change / new route can't silently diverge from the doc.
stage('coverage', () => {
  const script = path.join(ROOT, 'scripts', 'audit_endpoint_coverage.mjs');
  if (!existsSync(script)) return { ok: true, detail: 'coverage generator absent; skipped' };
  const r = spawnSync(process.execPath, [script, '--check'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || 'coverage map stale';
    return { ok: false, detail: msg.slice(0, 160) };
  }
  return { ok: true, detail: 'endpoint coverage map up to date' };
});

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
