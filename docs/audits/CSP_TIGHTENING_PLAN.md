# Tauri CSP Tightening Plan (AUD-003)

> Staged plan to narrow the desktop WebView's Content-Security-Policy. The
> `open_external` host/scheme allowlist (the lower-risk half of AUD-003) already
> shipped — see `src-tauri/src/lib.rs::open_external_url_allowed` + its unit
> tests. CSP tightening is sequenced here because it **can break GUI pages** and
> must be rolled out page-by-page with regression testing, not in one flip.

> **Status — DEFERRED (low priority, not scheduled).** The verifiable wins
> shipped (dropped `'unsafe-eval'`, scoped `script-src`, added the
> `e2e/csp.spec.mjs` harness). The remaining `'unsafe-inline'` removal
> (Steps 1/2/5 below) is **intentionally parked** with no near-term date. It is
> defense-in-depth, not a fix for any known issue: there is no known GUI XSS,
> and the highest-value escalation path (`open_external`) is already locked down.
> It requires a 24-file inline-script/handler externalization that can only be
> verified by clicking through the **packaged** desktop app. Pick it up only when
> there's appetite for that hands-on pass; until then this is a conscious "won't
> do yet", not an oversight.

## Current state (intentionally permissive)

`src-tauri/tauri.conf.json`:

```jsonc
"security": {
  "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; media-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' https:",
  "dangerousDisableAssetCspModification": ["script-src", "style-src"]
}
```

This is the **already-tightened** policy (see "What's been done"). The original was a single permissive `default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: …` line.

`app.withGlobalTauri = true` still exposes the full `window.__TAURI__` bridge to every page.

What still keeps it from `script-src 'self'` alone:
- The GUI is a large set of designer-shipped HTML pages with **34 inline `<script>` blocks** across 24 files **plus 26 inline event-handler attributes** (`onclick=`, …) in `app.html` / `image-ab.html` / `seekdeep-loading.html`. All of those require `script-src 'unsafe-inline'`.
- (`'unsafe-eval'` is NOT needed — verified: zero `eval(` / `new Function(` / `type="text/babel"` in `gui/`. It has been dropped.)

The blast radius: if any XSS lands in the GUI, `'unsafe-inline'` + the global Tauri bridge make it easy to escalate. The `open_external` allowlist already removed the "open any URL / any local protocol handler" escalation; the remaining CSP work removes the inline-script escalation.

## What's been done (AUD-003 follow-up)

- **Verification harness** — `e2e/csp.spec.mjs` reads the shipped CSP from `tauri.conf.json`, injects it as a response header on every top-level `gui/*.html`, and asserts zero `securitypolicyviolation` events. Runs in `npm run test:e2e` (and the `e2e` CI job). This is what makes CSP changes verifiable without a packaged build — it caught the Google-Fonts dependency that a naive tightening would have broken.
- **Dropped `'unsafe-eval'`** and **split the monolithic `default-src` into explicit directives**, narrowing `script-src` to `'self' 'unsafe-inline'` (no more arbitrary `https:` script origins) and scoping the Google-Fonts origins explicitly. Verified green by the harness across all 24 pages.

## Inventory mechanism (already in CI)

`scripts/preflight.mjs` `html-js` stage already enumerates every inline `<script>` block in `gui/*.html` (it extracts and `node --check`s each one). Its count line (`N inline blocks across M html files`) is the live inventory to drive the remaining work — when it reaches near-zero inline blocks AND the 26 inline event handlers are converted to `addEventListener`, `'unsafe-inline'` can drop.

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

## Release-testing note (do before the REMAINING CSP steps ship)

The `e2e/csp.spec.mjs` harness verifies the policy against the dev-served pages with the production CSP injected — that's what made the eval-drop + directive-split safe to ship. But it loads pages; it doesn't click through every flow, and it isn't the packaged WebView. Before shipping Steps 1/2/5 (the `'unsafe-inline'` removal and `withGlobalTauri` change):
1. Extend `e2e/csp.spec.mjs` to drive the key interactions (not just page load) under the strict CSP, OR
2. Build the Tauri app (`npm run tauri build` or the nightly workflow) and open every GUI page with devtools open, watching for `Refused to …` and broken interactions.

Roll back by restoring the prior `csp` string; it's config-only, no code change.

## Status

- [x] `open_external` scheme + host allowlist (shipped; `open_external_url_allowed` + unit tests).
- [x] **CSP verification harness** — `e2e/csp.spec.mjs` (injects the shipped CSP, asserts zero violations across all top-level GUI pages; in `npm run test:e2e` + CI).
- [x] **Step 3 — drop `'unsafe-eval'`** (verified unused; harness green).
- [x] **Step 4 — split `default-src` into explicit directives + narrow `script-src` to `'self' 'unsafe-inline'`** (no more arbitrary `https:` script origins; Google-Fonts origins scoped). `connect-src`/`img-src`/`frame-src` intentionally still allow `https:` to avoid breaking unexercised flows — a later pass can scope these once interaction-level CSP coverage exists.
- [ ] Step 1 — externalize the 34 inline `<script>` blocks + convert the 26 inline event-handler attributes to `addEventListener` (the prerequisite for dropping `'unsafe-inline'`). Needs interaction-level harness coverage or a packaged-app pass.
- [ ] Step 2 — drop `'unsafe-inline'` from `script-src` (and then `style-src`).
- [ ] Step 5 — disable `withGlobalTauri`.
