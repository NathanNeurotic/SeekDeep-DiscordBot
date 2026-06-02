# Tauri CSP Tightening Plan (AUD-003)

> Staged plan to narrow the desktop WebView's Content-Security-Policy. The
> `open_external` host/scheme allowlist (the lower-risk half of AUD-003) already
> shipped — see `src-tauri/src/lib.rs::open_external_url_allowed` + its unit
> tests. CSP tightening is sequenced here because it **can break GUI pages** and
> must be rolled out page-by-page with regression testing, not in one flip.

## Current state (intentionally permissive)

`src-tauri/tauri.conf.json`:

```jsonc
"security": {
  "csp": "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "dangerousDisableAssetCspModification": ["script-src", "style-src"]
}
```

`app.withGlobalTauri = true` also exposes the full `window.__TAURI__` bridge to every page.

Why it's currently this loose:
- The GUI is a large set of designer-shipped HTML pages with **inline `<script>` blocks** (`'unsafe-inline'`).
- At least one runtime dependency (suspected: `@babel/standalone` for `type="text/babel"` JSX, and/or an inline `eval`-based helper) needs `'unsafe-eval'`.
- Local backend calls go to `http://127.0.0.1:7865` and `ws://127.0.0.1:7865` (the `http://127.0.0.1:*` / `ws://` sources).

The blast radius this creates: if any XSS lands in the GUI, the permissive CSP + global Tauri bridge make it easy to escalate. The `open_external` allowlist already removed the "open any URL / any local protocol handler" escalation; CSP tightening removes the rest.

## Inventory mechanism (already in CI)

`scripts/preflight.mjs` `html-js` stage already enumerates every inline `<script>` block in `gui/*.html` (it extracts and `node --check`s each one). Its count line (`N inline blocks across M html files`) is the live inventory to drive this work — when it reaches near-zero inline blocks, `'unsafe-inline'` can drop.

## Staged rollout

Each step is independently shippable and independently revertable. Do not advance to the next step until the previous one has ridden a release with no CSP-console regressions.

### Step 1 — host the inline scripts as modules (no CSP change yet)
- For each `gui/*.html`, move its inline `<script>` body into a sibling `gui/<page>.js` loaded with `<script src="…">`.
- Keep `type="text/babel"` JSX blocks last (they need the eval-based transformer; handle in Step 3).
- Acceptance: `html-js` inline-block count trends to (near) zero; every page still loads; Playwright `e2e/control-center.spec.mjs` stays green.

### Step 2 — drop `'unsafe-inline'` for scripts
- Once inline non-babel scripts are externalized, remove `'unsafe-inline'` from the script side and remove `script-src` from `dangerousDisableAssetCspModification`.
- Prefer an explicit `script-src 'self' http://127.0.0.1:* ...` over relying on `default-src`.
- Acceptance: app boots; no `Refused to execute inline script` console errors on any page; e2e green. Style `'unsafe-inline'` can stay until a separate pass moves inline `style=` usage.

### Step 3 — remove `'unsafe-eval'`
- Identify the exact consumer. Candidates: `@babel/standalone` (`type="text/babel"`), any `new Function(...)`/`eval(...)` in shipped JS.
- If Babel-in-browser is the only consumer, precompile those JSX blocks at build time (or convert to plain JS) so the transformer — and `'unsafe-eval'` — can be dropped.
- Acceptance: grep shipped JS for `eval(`/`new Function(`; app fully functional without `'unsafe-eval'`; e2e green.

### Step 4 — narrow remaining sources
- Replace broad `https:` and `data:`/`blob:` in `default-src` with explicit `img-src`/`connect-src`/`media-src` lists scoped to what the GUI actually loads (loopback API + WS + any first-party CDN assets).
- Acceptance: no broken images / fetches / EventSource / WebSocket; e2e green.

### Step 5 — consider disabling `withGlobalTauri`
- Once pages call Tauri via explicit `import { invoke } from '@tauri-apps/api/core'` (or the per-page bridge shim) instead of `window.__TAURI__`, set `app.withGlobalTauri = false`.
- This is last because it touches every page that currently reads `window.__TAURI__` (e.g. `gui/updater.js`, `gui/model-install.js`, `gui/prompts.html`, `gui/seekdeep-loading.html`).
- Acceptance: every Tauri-invoking page still works in the packaged app; e2e green.

## Release-testing note (do before any CSP step ships)

CSP tightening cannot be fully validated by `npm run preflight` (it doesn't run the packaged WebView). Before shipping each step:
1. Build the Tauri app (`npm run tauri build` or the nightly workflow).
2. Open every GUI page in the packaged app with the devtools console visible.
3. Watch for `Refused to …` CSP violations and broken interactions.
4. Run `npm run test:e2e` against the dev server for the scripted flows.

Roll back by restoring the prior `csp` string + `dangerousDisableAssetCspModification` entry; these are config-only, no code change.

## Status

- [x] `open_external` scheme + host allowlist (shipped; `open_external_url_allowed` + unit tests).
- [ ] Step 1 — externalize inline scripts.
- [ ] Step 2 — drop `'unsafe-inline'` (scripts).
- [ ] Step 3 — drop `'unsafe-eval'`.
- [ ] Step 4 — narrow `default-src`.
- [ ] Step 5 — disable `withGlobalTauri`.
