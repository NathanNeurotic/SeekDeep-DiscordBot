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
// (e.g. "single_files = " or "let files = "). Tolerates multi-line arrays and
// // or # line comments. These lists are flat (no nested brackets).
function extractArray(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const open = src.indexOf('[', at);
  const close = src.indexOf(']', open);
  if (open < 0 || close < 0) return null;
  const items = [];
  for (let line of src.slice(open + 1, close).split('\n')) {
    line = line.replace(/\/\/.*$/, '').replace(/#.*$/, ''); // drop line comments
    for (const m of line.matchAll(/"([^"]+)"/g)) items.push(m[1]);
  }
  return items;
}

const sot = JSON.parse(read('release-files.json'));
const core = sot.core_files;
const bundleExtra = sot.bundle_extra;
const subdirs = sot.subdirs;

const errors = [];
const setEq = (a, b) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
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
