// SeekDeep endpoint → GUI/test coverage map generator (AUD-006).
//
// The GUI/backend contract lives across FastAPI route decorators, dozens of
// inline HTML scripts, shared JS modules, the nav.js token monkey-patch, and
// two test suites. Nothing said "this route is called by this page with this
// auth and is covered by this test" — so an endpoint rename or auth change can
// silently break a page while backend smoke still passes.
//
// This script extracts:
//   * FastAPI routes (method, path, auth mode) from gui_endpoints.py +
//     local_ai_server.py;
//   * literal endpoint paths referenced in gui/*.{html,js};
//   * literal endpoint paths referenced in the test suites;
// and writes docs/ENDPOINT_COVERAGE.md — a table of method · path · auth ·
// first GUI caller · test coverage.
//
// Usage:
//   node scripts/audit_endpoint_coverage.mjs            # regenerate the doc
//   node scripts/audit_endpoint_coverage.mjs --check    # fail if the doc is stale
//
// The output is deterministic (sorted, no timestamps) so --check is a clean
// drift guard wired into `npm run preflight`.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const OUT_REL = 'docs/ENDPOINT_COVERAGE.md';

// Routes that gate auth manually INSIDE the handler rather than via a decorator
// Depends(), so the decorator scan would otherwise mislabel them "open":
//   * /logs/stream, /events — token via ?token= query param (EventSource /
//     WebSocket clients can't send headers).
//   * /data/{file} — conditional: the sensitive-file allowlist (server-stats,
//     auto-reactions, archive-snapshot, prompt-templates, …) requires the token;
//     non-sensitive files stay open. Labeled token* to flag the conditional gate.
const MANUAL_TOKEN_ROUTES = new Set(['/logs/stream', '/events', '/data/{file}']);

const DECORATOR_RE = /@(?:app|router)\.(get|post|put|delete|patch|websocket)\(\s*(['"])([^'"]+)\2/;

function parseRoutes(relFile, serverLabel) {
  const abs = path.join(ROOT, relFile);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  const routes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DECORATOR_RE.exec(lines[i]);
    if (!m) continue;
    const method = m[1].toUpperCase();
    const routePath = m[3];
    // Scan from the decorator line down to the function `def` (the decorator
    // args + any stacked decorators) to find the auth dependency, which may sit
    // on a continuation line.
    let auth = 'open';
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      if (/_require_gui_token|require_gui_token/.test(lines[j])) { auth = 'token'; break; }
      if (/^\s*(async\s+)?def\s/.test(lines[j]) && j > i) break;
    }
    if (auth === 'open' && MANUAL_TOKEN_ROUTES.has(routePath)) auth = 'token*';
    routes.push({ method, path: routePath, auth, server: serverLabel, file: relFile, line: i + 1 });
  }
  return routes;
}

// Extract endpoint-shaped path literals from a GUI/test file. Catches
// `'/data/x.json'`, `SEEKDEEP_BASE + '/health'`, and template literals like
// `` `/memory/user/${id}/fact` `` (the ${...} becomes a wildcard).
function extractReferencedPaths(text) {
  const found = new Set();
  // Quoted or backtick strings beginning with a slash that look like a route.
  const RE = /(['"`])(\/[a-zA-Z][\w./${}:-]*)\1/g;
  let m;
  while ((m = RE.exec(text)) !== null) {
    let p = m[2];
    // Drop a query string and normalize JS template holes to a wildcard.
    p = p.split('?')[0].replace(/\$\{[^}]*\}/g, '*');
    if (p.length > 1) found.add(p);
  }
  return found;
}

function collectFromDir(relDir, exts) {
  const abs = path.join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => ({ rel: `${relDir}/${f}`, text: readFileSync(path.join(abs, f), 'utf8') }));
}

// Build a matcher for a route path: {param} and * become a single-segment
// wildcard. Returns a RegExp anchored to the full path.
function routeMatcher(routePath) {
  const escaped = routePath
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{[^}]+\}/g, '[^/]+')
    .replace(/\*/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

// Does any referenced literal path match this route?
function refMatchesRoute(routePath, refPaths) {
  const rx = routeMatcher(routePath);
  for (const ref of refPaths) {
    // Normalize a referenced wildcard so a single segment matches a {param}.
    if (rx.test(ref)) return true;
  }
  return false;
}

function generate() {
  const routes = [
    ...parseRoutes('gui_endpoints.py', 'gui_endpoints.py'),
    ...parseRoutes('local_ai_server.py', 'local_ai_server.py'),
  ];

  // GUI callers: path-literal set per file (for "first caller") + global set.
  const guiFiles = collectFromDir('gui', ['.html', '.js']);
  const guiPathsByFile = guiFiles.map((f) => ({ rel: f.rel, paths: extractReferencedPaths(f.text) }));

  // Test references (any matching path => covered).
  const testFiles = [
    ...collectFromDir('e2e', ['.mjs', '.js', '.spec.mjs']),
    ...['scripts/smoke_gui_endpoints.py', 'scripts/dev/verify_e2e.py']
      .filter((r) => existsSync(path.join(ROOT, r)))
      .map((r) => ({ rel: r, text: readFileSync(path.join(ROOT, r), 'utf8') })),
  ];
  const testPaths = new Set();
  for (const t of testFiles) for (const p of extractReferencedPaths(t.text)) testPaths.add(p);

  for (const r of routes) {
    let firstCaller = '';
    for (const g of guiPathsByFile) {
      if (refMatchesRoute(r.path, g.paths)) { firstCaller = g.rel.replace(/^gui\//, ''); break; }
    }
    r.firstGuiCaller = firstCaller || '—';
    r.tested = refMatchesRoute(r.path, testPaths) ? 'yes' : 'no';
  }

  // Deterministic order: server, then path, then method.
  routes.sort((a, b) =>
    a.server.localeCompare(b.server) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const byServer = new Map();
  for (const r of routes) {
    if (!byServer.has(r.server)) byServer.set(r.server, []);
    byServer.get(r.server).push(r);
  }

  const lines = [];
  lines.push('# Endpoint → GUI / Test Coverage Map (AUD-006)');
  lines.push('');
  lines.push('> **Generated** by `scripts/audit_endpoint_coverage.mjs`. Do not edit by hand —');
  lines.push('> run `node scripts/audit_endpoint_coverage.mjs` to regenerate. `npm run preflight`');
  lines.push('> fails (the `coverage` stage) when this file drifts from the code.');
  lines.push('>');
  lines.push('> Columns: HTTP method · route path · auth mode (`token` = `X-SeekDeep-Token`');
  lines.push('> required via decorator; `token*` = gated manually inside the handler — `?token=`');
  lines.push('> for EventSource/WebSocket, or the per-file sensitive allowlist on `/data/{file}`;');
  lines.push('> `open` = no token) · first GUI file that references the path · whether a test');
  lines.push('> suite (`e2e/`, `scripts/smoke_gui_endpoints.py`, `scripts/dev/verify_e2e.py`)');
  lines.push('> references it. `—` / `no` are drift signals, not necessarily bugs (some routes');
  lines.push('> are tray-only or future-facing); investigate before assuming coverage.');
  lines.push('');
  let total = 0;
  let open = 0;
  let untested = 0;
  for (const [server, rs] of byServer) {
    lines.push(`## ${server} (${rs.length} routes)`);
    lines.push('');
    lines.push('| Method | Path | Auth | First GUI caller | Tested |');
    lines.push('|---|---|---|---|---|');
    for (const r of rs) {
      lines.push(`| ${r.method} | \`${r.path}\` | ${r.auth} | ${r.firstGuiCaller} | ${r.tested} |`);
      total++;
      if (r.auth === 'open') open++;
      if (r.tested === 'no') untested++;
    }
    lines.push('');
  }
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total routes: **${total}**`);
  lines.push(`- Open (no token): **${open}**`);
  lines.push(`- Not referenced by any test suite: **${untested}**`);
  lines.push('');
  return lines.join('\n') + '\n';
}

const isCheck = process.argv.includes('--check');
const outAbs = path.join(ROOT, OUT_REL);
const generated = generate();

if (isCheck) {
  const current = existsSync(outAbs) ? readFileSync(outAbs, 'utf8') : '';
  if (current !== generated) {
    console.error(`[coverage] ${OUT_REL} is stale — run: node scripts/audit_endpoint_coverage.mjs`);
    process.exit(1);
  }
  console.log(`[coverage] ${OUT_REL} is up to date.`);
  process.exit(0);
} else {
  writeFileSync(outAbs, generated, 'utf8');
  console.log(`[coverage] wrote ${OUT_REL}`);
  process.exit(0);
}
