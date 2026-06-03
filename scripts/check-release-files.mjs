#!/usr/bin/env node
// DUP-1 drift guard: assert the four hand-maintained runtime-file lists stay in
// sync with release-files.json (the single source of truth). Run by preflight.
//
// A mismatch here means self-update, signing, bundling, or extraction would ship
// a different file set than the others — e.g. a new module added to the bundle
// but not to the self-updater (so it never updates) or the signing manifest (so
// the signature check fails). Edit release-files.json, then update whichever
// consumer this names.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Pull the string-literal members out of an array assigned right after `marker`
// (e.g. "single_files = " or "let files = "). CI-5: the scan is string- and
// comment-aware — it anchors `marker` at the START of a code line (so a commented-
// out "# single_files = [ OLD ]" can't be matched), tracks string/comment state,
// and counts bracket depth, so a `]` inside a comment or a filename can't truncate
// (and silently mask) the list. Collects every quoted member; returns null if no
// matching `]` is found.
function extractArray(src, marker) {
  const re = new RegExp('(?:^|\\n)[ \\t]*' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\[');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length; // just past the opening '['
  let depth = 1, inStr = null, lineComment = false, cur = '';
  const items = [];
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (lineComment) { if (c === '\n') lineComment = false; i++; continue; }
    if (inStr) {
      if (c === '\\') { cur += src[i + 1] || ''; i += 2; continue; }
      if (c === inStr) { items.push(cur); cur = ''; inStr = null; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === '/' && src[i + 1] === '/') { lineComment = true; i += 2; continue; }
    if (c === '#') { lineComment = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; cur = ''; i++; continue; }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    i++;
  }
  return depth === 0 ? items : null;
}

const sot = JSON.parse(read('release-files.json'));
const core = sot.core_files;
const bundleExtra = sot.bundle_extra;
const subdirs = sot.subdirs;

const errors = [];
// Gemini: sort-compare (the Set-size trick mis-passes lists with differing
// duplicates, e.g. ['x','y','y'] vs ['x','x','y']). These lists shouldn't have
// duplicates, but compare robustly anyway.
const setEq = (a, b) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort(), y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};
const diff = (got, want) => ({
  missing: want.filter((x) => !got.includes(x)),
  unexpected: got.filter((x) => !want.includes(x)),
});
function check(label, got, want) {
  if (got == null) { errors.push(`${label}: could not locate the list (marker not found — parser needs updating?)`); return; }
  if (!setEq(got, want)) errors.push(`${label} drifted from release-files.json: ${JSON.stringify(diff(got, want))}`);
}

// 1. self-updater single_files == core
check('gui_endpoints.py single_files', extractArray(read('gui_endpoints.py'), 'single_files = '), core);

// 2. signing manifest single files == core; subdirs == subdirs
const signingSrc = read('release_signing.py');
check('release_signing.py MANIFEST_SINGLE_FILES', extractArray(signingSrc, 'MANIFEST_SINGLE_FILES = '), core);
check('release_signing.py MANIFEST_SUBDIRS', extractArray(signingSrc, 'MANIFEST_SUBDIRS = '), subdirs);

// 3. tauri bundle.resources (strip ../) == core + bundle_extra + gui glob
{
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  const res = (conf.bundle?.resources || []).map((r) => r.replace(/^\.\.\//, ''));
  check('tauri.conf.json bundle.resources', res, [...core, ...bundleExtra, 'gui/**/*']);
}

// 4. sidecar extraction files == core + bundle_extra
check('src-tauri/src/sidecar.rs files[]', extractArray(read('src-tauri/src/sidecar.rs'), 'let files = '), [...core, ...bundleExtra]);

if (errors.length) {
  console.error('release-files SoT drift detected:');
  for (const e of errors) console.error('  - ' + e);
  console.error('\nFix: reconcile release-files.json with the named consumer(s).');
  process.exit(1);
}
console.log('release-files: gui_endpoints/release_signing/tauri.conf/sidecar all in sync with release-files.json');
