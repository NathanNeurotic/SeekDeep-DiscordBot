# SeekDeep Whole-Repo Audit - 2026-06-02

> Current-state audit of `NathanNeurotic/SeekDeep-DiscordBot` on `main`.
> This is not a recycle of the superseded May 2026 audit notes.

## Scope And Baseline

Repo facts verified during this pass:

- GitHub repository: `NathanNeurotic/SeekDeep-DiscordBot`, public, default branch `main`.
- Local checkout branch: `main`.
- `package.json` version: `10.35.47`; `src-tauri/Cargo.toml` package name `seekdeep`, Rust edition `2021`, `rust-version = "1.77"`.
- Major current file sizes: `index.js` 24,065 lines; `gui_endpoints.py` 6,404 lines; `local_ai_server.py` 5,706 lines; `smoke_test.mjs` 2,059 lines; `scripts/smoke_gui_endpoints.py` 1,370 lines.
- Endpoint inventory from decorators: `gui_endpoints.py` has 66 FastAPI routes; `local_ai_server.py` has 23 FastAPI routes.
- Prior audit documents under `docs/audits/` are explicitly marked superseded at line 1, including `AGENT_AUDIT_2026-05-27.md` and `AGENT_AUDIT_CROSS_2026-05-27.md`.

Verification run:

- `npm run preflight` passed before the report: JS syntax, inline HTML JS syntax, Python compile, 576 Node smoke checks, 202 GUI endpoint smoke checks, Rust `cargo check`, and docs checks.
- A temporary local server was started with `node scripts/run-python.mjs local_ai_server.py`, waited to `/health`, then stopped after verification.
- `python scripts/dev/verify_e2e.py` passed 19/19 live endpoint checks, including `/health`, `/gpu`, tokened `/logs/tail`, tokened `/data/auto-reactions.json`, bot launcher start/status/stop, `/chat`, and `/chart`.
- `npm run test:e2e` passed 11/11 Playwright tests.
- No live Discord messages were sent by this audit. The bot launcher check was non-posting and stopped the process it started.
- Secrets and local IDs from `.env`, `keys.txt`, `logs/`, and runtime `data/*.json` are intentionally not reproduced here.

Severity key:

- `P0`: exploitable critical breakage requiring immediate stop-ship.
- `P1`: high-impact security, release-chain, or user-visible correctness issue.
- `P2`: meaningful risk, coverage gap, or misleading contract likely to cause regressions.
- `P3`: low-risk correctness/polish problem.
- `DEBT`: architectural drag that is not a single bug yet, but makes bugs expensive.

## Executive Summary

No current `P0` was verified. The old headline issues about wildcard CORS, unauthenticated heavy model endpoints, open logs/data, missing image caps, and unconsumed self-update sentinel are fixed in current `main`.

The remaining serious risk is narrower and sharper:

- The self-update path is token-gated and integrity-checked against GitHub tree blob SHAs, but it still updates executable code from mutable `main`/broad `v*` refs, has no route-level concurrency lock, and reads remote bodies unbounded.
- Discord/user-supplied image URL fetching has timeout/size/MIME guards but no private-IP or redirect-aware SSRF policy.
- The Tauri app intentionally runs with broad WebView privileges: `withGlobalTauri`, `unsafe-inline`, `unsafe-eval`, and an unvalidated `open_external` command.
- Several docs still teach obsolete endpoint auth and feature-flag defaults. This is not cosmetic; those docs are exactly where future agents will copy incorrect assumptions from.
- The preflight and e2e suite is strong for normal operations, but the highest-authority update path is not directly covered.

## Findings

### AUD-001 - Self-update trust and concurrency are not strong enough

- `ID`: AUD-001
- `severity`: P1
- `status`: verified

`Evidence`:

- `gui_endpoints.py:2739` registers `POST /system/self-update` with `Depends(_require_gui_token)`.
- `gui_endpoints.py:2748` defaults `SEEKDEEP_SELF_UPDATE_ENABLED` to on unless set off.
- `gui_endpoints.py:2752-2759` allows `main`, any string starting with `v`, or a 7-40 character lowercase hex string, then builds `https://raw.githubusercontent.com/NathanNeurotic/SeekDeep-DiscordBot/{ref}/`.
- `gui_endpoints.py:2781-2787` defines `_fetch()` and returns `r.read()` without a byte limit.
- `gui_endpoints.py:2867-2888` verifies staged file content against GitHub tree blob SHAs.
- `gui_endpoints.py:2903-2920` commits staged files with per-file `src.replace(target)`.
- `gui_endpoints.py:2937-2939` writes `.self-updated`.
- Search command `rg -n "self_update_lock|_self_update_lock|Lock\(" gui_endpoints.py` found locks for event bus, transition state, and dependency install, but no self-update lock.
- `src-tauri/src/sidecar.rs` consumes `.self-updated`; the old sentinel-not-consumed claim is no longer true.

`Broken because`:

The endpoint is protected from anonymous callers, but it is still an executable code update mechanism that accepts mutable `main` and an over-broad `v*` prefix. The Git tree SHA check proves the raw files match GitHub's reported tree for that ref; it does not prove the ref was intended as a trusted release, signed, immutable, or compatible with the local installation. Two concurrent self-update requests can also stage and commit at the same time because there is no explicit update lock. Remote reads are unbounded, so a bad or unexpectedly huge GitHub/API response can waste memory during an update.

`Bad because`:

This is the highest-authority local action in the app: it replaces Python, GUI, script, package, and requirements files that the sidecar later runs. A compromised maintainer account, accidental bad `main`, ref confusion, or concurrent click can brick the install or execute unintended code. The current guardrails are much better than blind download, but the trust model is still weaker than the blast radius.

`Fix`:

- Add a module-level `_self_update_lock = threading.Lock()` near the other route locks in `gui_endpoints.py`.
- In `post_self_update`, acquire it non-blocking; return `409` with a clear status event if another update is active.
- Split ref policy:
  - Default production policy: tags matching `vMAJOR.MINOR.PATCH` or full 40-character SHA only.
  - Optional dev override: `SEEKDEEP_SELF_UPDATE_ALLOW_MAIN=on`.
  - Fix the current mismatch where 7-character SHAs are accepted but the error says 40-character SHA.
- Add a capped `_fetch(url, timeout=20, max_bytes=...)` reader similar in spirit to `seekdeepFetchWithLimits`, with a hard ceiling for file and API responses.
- Prefer GitHub API downloads with `GITHUB_TOKEN` when present so rate-limit failures do not look like product failures.
- For a stronger release channel, publish a release manifest with SHA-256s and a signature; verify that manifest before replacing files.

`Tests`:

- Add in-process GUI smoke tests for no token, invalid ref, disabled flag, `main` refused by default, `main` allowed only with dev override, concurrent second request returns `409`, and oversized `_fetch` returns a bounded failure.
- Add a mocked happy-path self-update test that stages files into a temp repo root and verifies no live file changes happen before all staged hashes pass.
- Keep live update execution out of default CI unless fully mocked; do not make CI mutate a real checkout from GitHub.

`Risk`:

Medium. Tightening refs can surprise users who rely on "update from main". The rollback is an env override plus restoring the old ref policy, but the lock and byte cap should remain.

### AUD-002 - User URL fetches lack a private-network SSRF policy

- `ID`: AUD-002
- `severity`: P1
- `status`: verified

`Evidence`:

- `index.js:1336-1341` defines `SEEKDEEP_FETCH_DEFAULT_MAX_BYTES` and `seekdeepFetchWithLimits(url, options)`.
- `index.js:1037-1041` redacts local/private URLs for Discord-facing text, but that is output hygiene, not fetch prevention.
- `index.js:15339-15410` resolves user image input and calls `seekdeepFetchWithLimits` for URL-backed images, then validates MIME/magic bytes.
- `index.js:15590`, `index.js:15634`, `index.js:15671`, and `index.js:15706` feed fetched image base64 into img2img/upscale/pix2pix/inpaint paths.
- `local_ai_server.py:1865-1888` and `local_ai_server.py:1942` cap decoded image bytes and pixels after the bot fetches and forwards data.

`Broken because`:

The fetch helper protects against slow responses, large bodies, and wrong file types. It does not reject `localhost`, loopback, RFC1918, link-local, multicast, unique-local IPv6, DNS names resolving to private addresses, or redirects that land on those addresses. For Discord-originated URLs, that is the wrong boundary: the bot host is being asked to make an outbound request on behalf of an untrusted user.

`Bad because`:

A user can potentially make the bot contact local services, LAN admin panels, the local AI server, SearXNG, Docker-adjacent services, or cloud metadata endpoints if the host has them. Even when image decoding blocks the final response, the request itself can cause side effects, reveal timing/error information, or hit services not intended for Discord users.

`Fix`:

- Add a `seekdeepValidateFetchTarget(url, options)` helper in `index.js`.
- Allow only `http` and `https`.
- Resolve hostnames before fetch; reject loopback, unspecified, private RFC1918, link-local, multicast, carrier-grade NAT, and IPv6 unique-local/link-local ranges.
- Re-run the same validation for every redirect target, or disable automatic redirects and follow manually after validation.
- Keep internal service calls separate: local AI and SearXNG calls should use explicit internal helpers or `allowPrivate: true`, not the user URL helper.
- Add `SEEKDEEP_FETCH_ALLOW_PRIVATE=off` as the default, with a loud opt-in for single-user LAN image workflows.

`Tests`:

- Expose the validator in `globalThis.__seekdeepTest`.
- Add smoke tests for `127.0.0.1`, `localhost`, `0.0.0.0`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `[::1]`, `fc00::1`, and a public URL.
- Add a mocked redirect test: public URL -> private URL must fail before body download.
- Add one integration-style test around `seekdeepResolveImageInput` proving the policy is applied before MIME probing.

`Risk`:

Medium. Some legitimate users may paste LAN-hosted images. That should become an explicit env opt-in, not the default behavior for a Discord bot.

### AUD-003 - Tauri bridge and CSP are too broad for the GUI's XSS blast radius

- `ID`: AUD-003
- `severity`: P2
- `status`: verified

`Evidence`:

- `src-tauri/tauri.conf.json:13` sets `"withGlobalTauri": true`.
- `src-tauri/tauri.conf.json:30` allows `'unsafe-inline'`, `'unsafe-eval'`, `data:`, `blob:`, broad `https:`, and localhost websocket/http sources.
- `src-tauri/tauri.conf.json:31` disables Tauri asset CSP modification for script and style.
- `src-tauri/src/lib.rs:124-128` exposes `open_external(app, url)` and opens the caller-supplied URL without scheme or host validation.
- `src-tauri/src/lib.rs:326` registers `open_external` as an invoke command.

`Broken because`:

The WebView is intentionally permissive, and the Rust bridge exposes a URL opener that trusts frontend input. No current XSS was verified, but if one lands in the GUI, the attacker gets a richer bridge and can open arbitrary URLs or local protocol handlers through the desktop app.

`Bad because`:

This turns frontend bugs into desktop-shell bugs. The app already has high-authority local endpoints guarded by the GUI token; a broad WebView policy and global bridge increase the value of any injection or compromised remote content.

`Fix`:

- In `open_external`, parse the URL and allow only `https://` plus a small host allowlist used by the product, such as GitHub releases/docs and official dependency download pages.
- Reject `file:`, `javascript:`, `data:`, custom protocols, and plain `http:` except loopback URLs that are explicitly needed.
- Gradually remove `unsafe-eval`; audit whether it is required by a dependency or only by inline scripts.
- Move inline scripts toward bundled JS modules so CSP can drop `'unsafe-inline'` later.
- Consider disabling `withGlobalTauri` once pages use explicit imports/invokes.

`Tests`:

- Add Rust unit tests or command-level tests for `open_external` allow/deny cases.
- Add Playwright checks that expected external links still work through the GUI action path.
- Add a CSP regression note to release testing before tightening, because this may break older inline pages.

`Risk`:

Medium. CSP tightening can break GUI pages. The URL allowlist is lower risk and should happen first.

### AUD-004 - Self-update is not covered by the automated smoke/e2e suite

- `ID`: AUD-004
- `severity`: P2
- `status`: verified

`Evidence`:

- `scripts/preflight.mjs:10-17` describes JS, inline HTML JS, Python compile, Node smoke, GUI smoke, Rust, and docs stages.
- `scripts/smoke_gui_endpoints.py:386-455` covers token gating for sensitive `/data` files and traversal.
- `scripts/dev/verify_e2e.py:78-167` covers live `/health`, `/gpu`, logs, config, stats, data, react rules, bot launcher, `/chat`, and `/chart`.
- `e2e/control-center.spec.mjs:34-259` covers 11 GUI scenarios.
- `rg -n "self-update|system/self-update|post_self_update" scripts/smoke_gui_endpoints.py e2e/control-center.spec.mjs scripts/dev/verify_e2e.py` returned no matches.

`Broken because`:

The most security-sensitive GUI route has no direct automated test for auth, disabled mode, ref validation, staging failure, hash mismatch, concurrency, or bounded network reads.

`Bad because`:

Self-update can regress while the full preflight remains green. That is exactly the class of feature where "not covered but probably fine" ages badly.

`Fix`:

- Factor the update planner/stager into testable helpers in `gui_endpoints.py`.
- Use temp directories and mocked fetch responses in `scripts/smoke_gui_endpoints.py`.
- Add tests for invalid refs, disabled flag, hash mismatch, missing file, oversized response, lock contention, and no live-tree mutation before successful staging.
- Keep real GitHub network update tests manual or nightly-only.

`Tests`:

- `python scripts/smoke_gui_endpoints.py` should include the mocked self-update cases.
- `npm run preflight` should run them by default.
- A future optional workflow can run a non-mutating GitHub API manifest probe.

`Risk`:

Low to medium. Refactoring update code creates some risk, but mocked tests will reduce it immediately.

### AUD-005 - Canonical docs still contradict current auth and feature defaults

- `ID`: AUD-005
- `severity`: P2
- `status`: verified

`Evidence`:

- `SECURITY.md:55` says `SEEKDEEP_FEATURE_IMG2IMG` is on by default since v10.25.
- `.env.default:208-212` says optional features are all off by default and sets `SEEKDEEP_FEATURE_IMG2IMG=off`.
- `README.md:601` correctly says `SEEKDEEP_FEATURE_IMG2IMG` defaults off.
- `CODEX_REPO_BRIEF.md:412` and `CODEX_REPO_BRIEF.md:595` repeat the stale claim that `.env.default` has img2img on.
- `INTEGRATION.md:74` says only three write endpoints require `X-SeekDeep-Token` and read endpoints `/data/*` and `/logs/*` stay open.
- Current code token-gates logs at `gui_endpoints.py:1704` and `gui_endpoints.py:1719-1739`, and token-gates sensitive data at `gui_endpoints.py:3751-3777`.
- `INTEGRATION.md:517`, `INTEGRATION.md:535`, `INTEGRATION.md:542`, `INTEGRATION.md:548`, `INTEGRATION.md:642`, and `INTEGRATION.md:650` refer to `archive-snapshots.json` plural.
- Current code and GUI use `archive-snapshot.json` singular at `gui_endpoints.py:1499-1523`, `gui_endpoints.py:3757`, and `gui/app.html:2432-2703`.
- `MAINTAINER.md:22` and `MAINTAINER.md:87-89` still describe a "three write routes" token model and open `/data/*`/`/logs/*`.

`Broken because`:

Docs that are supposed to orient maintainers and agents are teaching an obsolete security model and stale filenames. The code is safer than the docs, but stale docs are how safer code gets "simplified" back into unsafe code.

`Bad because`:

Future maintainers will waste time debugging non-existent open read endpoints, write GUI code against the wrong archive snapshot filename, or copy the wrong feature default into release notes. Worse, a future security patch could be based on old assumptions and remove current protections.

`Fix`:

- Update `SECURITY.md` to say img2img is off by default and requires explicit opt-in.
- Update `INTEGRATION.md` with the current token model:
  - `/token` is loopback/browser-origin guarded.
  - GUI writes are tokened.
  - `/logs/tail`, `/logs/stream`, and sensitive `/data/*.json` are tokened.
  - EventSource uses `?token=` only because it cannot send headers.
- Replace all `archive-snapshots.json` mentions with `archive-snapshot.json`.
- Refresh `MAINTAINER.md` and `CODEX_REPO_BRIEF.md`, or mark `CODEX_REPO_BRIEF.md` as a historical snapshot with a current pointer.
- Extend `scripts/preflight.mjs` docs checks to fail on the stale phrases above.

`Tests`:

- `npm run preflight` docs stage should include grep-style guards for:
  - no doc claims `SEEKDEEP_FEATURE_IMG2IMG` is on by default;
  - no doc claims `/logs/*` or sensitive `/data/*` are open;
  - no tracked doc references `archive-snapshots.json`.

`Risk`:

Low. This is documentation and docs-check work. The main risk is over-tightening a wording guard and making benign prose fail preflight.

### AUD-006 - GUI endpoint-to-page contract is too implicit

- `ID`: AUD-006
- `severity`: P2
- `status`: verified

`Evidence`:

- Route counts: `gui_endpoints.py` has 66 decorators; `local_ai_server.py` has 23.
- `gui/nav.js:97-207` monkey-patches `window.fetch` to inject `X-SeekDeep-Token` for writes and selected sensitive reads.
- `gui/nav.js:206-218` uses `SENSITIVE_READ_RE` and `needsToken` to decide when to attach the token.
- `gui/nav.js:227-242` retries any same-server `401` with a refreshed token.
- `e2e/control-center.spec.mjs:34-259` covers 11 browser scenarios, which is useful but not a complete route/page matrix.
- `scripts/smoke_gui_endpoints.py` covers many backend routes in-process, but does not prove every GUI page still points to the correct route with the expected auth mode.

`Broken because`:

The GUI/backend contract lives across route decorators, many HTML inline scripts, shared JS modules, the token monkey-patch, smoke tests, and Playwright tests. There is no generated map that says "this page uses this endpoint, with this method, and this auth expectation."

`Bad because`:

Endpoint renames, auth changes, or page moves can silently break a page while backend smoke still passes. The current code has already needed comments around `/logs/tail`, `/logs/stream`, and tokened data reads because the implicit contract was easy to miss.

`Fix`:

- Add a script that extracts FastAPI route decorators from `gui_endpoints.py` and `local_ai_server.py`.
- Extract literal GUI fetch/EventSource targets from `gui/*.html` and `gui/*.js`.
- Generate `docs/audits/ENDPOINT_COVERAGE.md` or `docs/ENDPOINT_COVERAGE.md` with method, path, auth mode, first GUI caller, and test coverage.
- Add a docs/preflight guard that flags routes with no owner/test annotation and GUI fetches to unknown paths.

`Tests`:

- Add the generated endpoint map check to `npm run preflight`.
- Keep Playwright focused on user-visible behavior; use the generated map for coverage drift.

`Risk`:

Low. The extraction script may need hand-maintained exceptions for dynamic endpoints.

### AUD-007 - Non-Windows ML dependency versions can drift under users

- `ID`: AUD-007
- `severity`: P2
- `status`: verified

`Evidence`:

- `requirements-ml.txt:36-37` pins Windows `torch==2.11.0+cu128` and `torchvision==0.26.0+cu128`.
- `requirements-ml.txt:38-39` leaves non-Windows `torch` and `torchvision` unpinned.
- `requirements-ml.txt:46-50` bounds accelerate, bitsandbytes, transformers, diffusers, and safetensors.
- `.github/workflows/e2e.yml:49` states CI installs the same minimal set as preflight, not full ML libraries.

`Broken because`:

Linux/macOS users installing ML dependencies can receive whatever torch/torchvision versions the package index currently serves. Those packages are large, platform-sensitive, and frequently breaking. CI does not catch this because it avoids full ML installs.

`Bad because`:

The first failure will be a user's local environment, not a CI signal. The bug report will look like "model loading broke" even though the code did not change.

`Fix`:

- Add bounded non-Windows ranges, for example a known-compatible torch major/minor line, or split platform-specific constraints files.
- If unpinned non-Windows torch is intentional, document it as "platform-managed" and add a warning in setup docs.
- Consider a scheduled lightweight dependency-resolution workflow that installs ML deps without downloading model weights.

`Tests`:

- Add a CI job or manual script that creates a clean venv and resolves `requirements-ml.txt` on Linux without loading models.
- Record `pip freeze` in an artifact for future bisects.

`Risk`:

Medium. Over-pinning torch can hurt users on unsupported CUDA/CPU platforms. Prefer bounded ranges plus clear override instructions.

### AUD-008 - The bot monolith remains a correctness risk

- `ID`: AUD-008
- `severity`: DEBT
- `status`: verified

`Evidence`:

- `index.js` is 24,065 lines.
- `rg --count-matches "^function " index.js` returned 564.
- `rg --count-matches "^async function " index.js` returned 176.
- `index.js:18107` registers `messageReactionAdd`.
- `index.js:19079` registers `messageCreate`.
- `index.js:22147`, `index.js:23573`, `index.js:23600`, `index.js:24027`, and `index.js:24052` register multiple `interactionCreate` listeners.
- `AGENTS.md` correctly calls out that the Node side is a single-file bot with many hoisted helpers.

`Broken because`:

This is not a single bug, and the multiple interaction listeners were not proven to collide in this audit. The breakage is maintainability: routing, persistence, image workflows, archive logic, GUI-adjacent state, and command handling share one enormous file and top-level state. Any edit has a large search and regression surface.

`Bad because`:

Small features require whole-file reasoning. Listener-family changes can create accidental duplicate handling. Test-mode exports are the only practical way to unit test pure helpers, so unexported logic tends to stay under-tested.

`Fix`:

- Do not do a grand rewrite.
- Extract only leaf modules that already have clean boundaries:
  - URL fetch policy;
  - image reply intent classification;
  - archive thread naming/count helpers;
  - prompt template parsing;
  - auto-reaction pattern compilation.
- Keep `index.js` as the event orchestration root until extracted modules are smoke-tested.
- Add extracted helpers to `globalThis.__seekdeepTest` or direct module tests.

`Tests`:

- Every extraction must preserve current smoke tests.
- Add tests before moving a helper if it is not already covered.

`Risk`:

Medium if done as a refactor project; low if done one leaf helper at a time.

## Verified Healthy Areas / Do Not Reopen Without New Evidence

### HIST-001 - Wildcard CORS is fixed

- `ID`: HIST-001
- `severity`: false positive historical claim
- `status`: already fixed

`Evidence`:

- `local_ai_server.py:717-731` imports `CORSMiddleware` and uses `allow_origins=list(_TRUSTED_ORIGINS)`.
- The server still binds to loopback at `local_ai_server.py:5706`.

`Broken because`:

The old audit claim described a wildcard/open browser surface. Current code uses a trusted origin allowlist for browser callers.

`Bad because`:

Reopening this as "CORS wildcard" wastes time and obscures the real remaining local attack surface.

`Fix`:

No fix needed unless the allowlist changes.

`Tests`:

Keep GUI token and origin tests in `scripts/smoke_gui_endpoints.py`.

`Risk`:

Low.

### HIST-002 - Heavy local AI endpoints are token-gated

- `ID`: HIST-002
- `severity`: false positive historical claim
- `status`: already fixed

`Evidence`:

- `local_ai_server.py:881-925` imports/registers `require_gui_token` or fails closed unless explicitly opened in test/dev.
- Destructive/heavy posts are gated, including `/unload` at `local_ai_server.py:2910`, `/model/install` at `local_ai_server.py:3182`, `/model/uninstall` at `local_ai_server.py:3411`, warmups at `local_ai_server.py:3597-3617`, `/chat` at `local_ai_server.py:4304`, `/vision` at `local_ai_server.py:4587`, `/image` at `local_ai_server.py:4733`, `/img2img` at `local_ai_server.py:4807`, `/upscale` at `local_ai_server.py:4913`, `/instruct-pix2pix` at `local_ai_server.py:5245`, `/inpaint` at `local_ai_server.py:5510`, `/inpaint_mask_preview` at `local_ai_server.py:5577`, and `/chart` at `local_ai_server.py:5637`.

`Broken because`:

The historical claim is stale.

`Bad because`:

The current concern is not "no token on heavy endpoints"; it is the strength of the local token/update/fetch trust boundaries.

`Fix`:

No immediate fix. Preserve fail-closed behavior if `gui_endpoints` import fails.

`Tests`:

Keep GUI endpoint smoke tests and add negative token checks for any newly added heavy endpoint.

`Risk`:

Low.

### HIST-003 - Logs and sensitive data are no longer open reads

- `ID`: HIST-003
- `severity`: false positive historical claim
- `status`: already fixed

`Evidence`:

- `/logs/tail` is token-gated at `gui_endpoints.py:1704`.
- `/logs/stream` is token-gated manually at `gui_endpoints.py:1719-1739`.
- Sensitive data files are listed at `gui_endpoints.py:3751-3763` and checked at `gui_endpoints.py:3776-3777`.
- Path traversal is blocked at `gui_endpoints.py:3770-3772`.
- Non-JSON data files are blocked at `gui_endpoints.py:3801-3803`.
- `scripts/smoke_gui_endpoints.py:386-455` tests no-token `401` for sensitive data and traversal failure for `/data/..%2F.env`.

`Broken because`:

The old docs and old audit language are stale. Current code protects these reads.

`Bad because`:

Docs still saying these are open reads can cause a future regression.

`Fix`:

Fix docs under AUD-005.

`Tests`:

Keep existing smoke checks; extend docs drift checks.

`Risk`:

Low.

### HIST-004 - Image/base64/pixel caps exist server-side

- `ID`: HIST-004
- `severity`: false positive historical claim
- `status`: already fixed

`Evidence`:

- `local_ai_server.py:1865` sets `LOCAL_AI_MAX_IMAGE_BYTES`.
- `local_ai_server.py:1868` sets `LOCAL_AI_MAX_IMAGE_PIXELS`.
- `local_ai_server.py:1871-1888` checks pixel budget before loading/converting PIL images.
- `local_ai_server.py:1942` decodes base64 images through capped helpers.
- `local_ai_server.py:2259-2267` defines message/base64 caps for request models.
- `local_ai_server.py:2297-2349` applies max base64 length fields across vision/image-edit request models.

`Broken because`:

The historical "uncapped image/base64" claim is stale for the Python server.

`Bad because`:

The remaining issue is pre-fetch network target policy in the Node bot, not Python decode caps.

`Fix`:

Address AUD-002. Keep server caps.

`Tests`:

Continue compile and smoke checks; add explicit oversized request tests if future endpoint refactors touch request models.

`Risk`:

Low.

### HIST-005 - Self-update sentinel is consumed by the sidecar

- `ID`: HIST-005
- `severity`: false positive historical claim
- `status`: already fixed

`Evidence`:

- `gui_endpoints.py:2937-2939` writes `.self-updated`.
- `src-tauri/src/sidecar.rs` contains the self-updated skip-list and bundle-supersedes handling for that sentinel.

`Broken because`:

The old claim that the sentinel is not consumed is not current.

`Bad because`:

The real self-update issues are trust/concurrency/bounded fetch, not sentinel handling.

`Fix`:

No fix for sentinel consumption. Address AUD-001.

`Tests`:

Add self-update tests under AUD-004 that also assert sentinel behavior.

`Risk`:

Low.

### HIST-006 - Multiple interaction listeners are debt, not a verified duplicate-handler bug

- `ID`: HIST-006
- `severity`: false positive unless collision is reproduced
- `status`: verified as debt only

`Evidence`:

- Multiple `interactionCreate` listeners exist at `index.js:22147`, `index.js:23573`, `index.js:23600`, `index.js:24027`, and `index.js:24052`.
- This audit did not reproduce a double-response or listener collision.

`Broken because`:

The architecture is harder to reason about, but "multiple listeners" alone is not proof of a current behavioral bug.

`Bad because`:

Treating this as a confirmed duplicate-handler issue will send future fixes in circles. Treat it as monolith/listener-family debt unless a specific custom ID or interaction type double-fires.

`Fix`:

When adding a new interaction family, add a smoke test or explicit prefix guard. Longer-term, centralize interaction routing.

`Tests`:

Add targeted tests for any suspected colliding `customId`.

`Risk`:

Low.

## Fix Queue

Recommended order:

1. AUD-002: Add private-network/redirect-aware fetch policy in `index.js`.
2. AUD-001 and AUD-004 together: harden self-update and add mocked tests.
3. AUD-005: repair docs and add docs drift guards.
4. AUD-003: constrain `open_external`, then plan CSP tightening.
5. AUD-006: generate endpoint coverage map.
6. AUD-007: constrain or explicitly document non-Windows ML dependency resolution.
7. AUD-008: extract one leaf helper at a time, only with tests.

## Acceptance Criteria For Closing This Audit

- `npm run preflight` remains green.
- `python scripts/dev/verify_e2e.py` remains green against a temporary local server.
- `npm run test:e2e` remains green.
- `scripts/smoke_gui_endpoints.py` includes direct self-update negative and mocked positive tests.
- User URL fetching rejects private/loopback/link-local targets and redirect landings by default.
- Docs no longer claim img2img is on by default, logs/data are open reads, or `archive-snapshots.json` is current.
- Tauri `open_external` rejects non-HTTPS and unapproved hosts.

## Closeout — 2026-06-02

> Additive log of how each finding was resolved. The Findings text above is left
> as written; this section records the fix, evidence, tests, and residual risk.
> Every claim was re-verified against current code before the fix (the audit's
> "66 gui routes" was found to be 67 by direct decorator grep — see AUD-006).

**Verification (whole queue, after all fixes landed):**

- `npm run preflight` → 8 ok · 0 fail (js, html-js, py, smoke=612, gui-smoke, rust, docs, coverage). `gui-smoke` self-skips in this worktree (no `.venv`); run directly with the main checkout's `.venv` python it is **223 ok, 0 fail** (incl. 23 new self-update checks).
- `node smoke_test.mjs` → **pass=612 fail=0** (incl. 38 new SSRF checks).
- `cargo test --manifest-path src-tauri/Cargo.toml open_external` → **5 passed**.
- Temporary local server (main `.venv` python on the worktree tree) → `/health` 200; `python scripts/dev/verify_e2e.py` → **19/19 pass**; `npm run test:e2e` → **11 passed**. Server stopped, port 7865 released. (`/chat` returned a well-formed 503 — local Llama is a gated HF repo with no creds in this env — matching the original audit's baseline; not a code regression.)

| ID | Status | Fix evidence | Tests | Residual risk |
|---|---|---|---|---|
| AUD-002 | Closed | `lib/url-fetch-policy.js` `seekdeepValidateFetchTarget`/`seekdeepClassifyBlockedIp`; `seekdeepFetchWithLimits` validates + follows redirects manually (re-validating each hop); default-deny via `SEEKDEEP_FETCH_ALLOW_PRIVATE=off`. Commit `ce8de7d` (extracted in `d40b19a`). | 38 smoke checks (classifier, validator accept/reject, allowPrivate opt-in, redirect re-validation). | DNS-rebinding between this lookup and the kernel's connect-time lookup is not fully closed (would need IP-pinned connections — node-fetch/undici differ); documented in SECURITY.md. Stops the realistic URL→localhost / URL→metadata cases. |
| AUD-001 | Closed | `gui_endpoints.py`: `_SELF_UPDATE_LOCK` (409 on contention), `_self_update_ref_is_allowed` (strict tag/SHA policy), bounded `_fetch(max_bytes=…)`, corrected error text, route split into `_post_self_update_locked`. Commit `00dfab3`. | Mocked self-update suite in `scripts/smoke_gui_endpoints.py` (ref matrix, 401/403/400/409, integrity-mismatch 409 + live-tree-untouched, oversized cap, happy-path commit into temp root). | Integrity gate proves bytes match GitHub's published tree for the ref; it does **not** defend a compromised repo (needs code signing). Ref allowlist + HTTPS + token gate remain the mitigations. Strict ref policy may surprise "update from main" users → `SEEKDEEP_SELF_UPDATE_ALLOW_MAIN=on`. |
| AUD-004 | Closed | `_self_update_checks()` added to `scripts/smoke_gui_endpoints.py`, wired into `npm run preflight`. Commit `00dfab3`. | Runs in gui-smoke (223 ok). Hermetic: temp repo root + mocked `urllib`, never touches the real tree. | Live GitHub-network update execution remains intentionally manual/out-of-CI. |
| AUD-005 | Closed | `SECURITY.md`, `INTEGRATION.md`, `MAINTAINER.md`, `CODEX_REPO_BRIEF.md`, `gui/app.html` corrected (img2img off-by-default; real token model; `archive-snapshot.json` singular). Drift guards added to `scripts/preflight.mjs` docs stage. Commit `82d9f94`. | preflight `docs` stage; verified guards fire on the old phrasings and pass on the corrected text. | Guards are scoped to canonical docs (`docs/audits/*` excluded since they quote stale phrases). Over-tight wording guards could false-positive future prose — patterns are anchored to filename/`on by default` co-occurrence to minimize that. |
| AUD-003 | Closed (open_external); CSP planned | `src-tauri/src/lib.rs` `open_external_url_allowed` (https host allowlist + first-party `discord:`; rejects http/file/javascript/data/custom). `docs/audits/CSP_TIGHTENING_PLAN.md` sequences the CSP rollout. Commit `cdb72cc`. | `cargo test open_external` → 5 (allow/deny incl. look-alike + suffix-append hosts). `npm run test:e2e` 11/11 confirms GUI external links still work. | CSP stays permissive (`unsafe-inline`/`unsafe-eval`/`withGlobalTauri`) until the staged page-by-page rollout; tracked in the plan doc. Host allowlist is deliberately narrow — expand per real link. |
| AUD-006 | Closed | `scripts/audit_endpoint_coverage.mjs` → `docs/ENDPOINT_COVERAGE.md`; preflight `coverage` stage fails on drift. Commit `1970f12`. | preflight `coverage` (`--check`); live counts 67 gui + 23 local = 90 routes. | Dynamic GUI fetch targets (template strings) match loosely; 36 routes show no test reference (surfaced, not hidden) — some are tray-only/future-facing. The map is a drift signal, not a security spec; `/data/{file}` is labeled `token*` (conditional per-file gate). |
| AUD-007 | Closed | `requirements-ml.txt`: non-Windows `torch>=2.4,<2.12` / `torchvision>=0.19,<0.27` + override guidance; Windows pins unchanged. Commit `7934209`. | All 18 requirement lines parse via `packaging.Requirement`. | Bounds can't be resolution-tested on Linux from this Windows box — recommend the audit's optional scheduled `pip install --dry-run` job on Linux. An unusual CUDA/CPU platform may need the documented `--index-url` override. |
| AUD-008 | First leaf done | URL fetch policy extracted to `lib/url-fetch-policy.js`; index.js imports + re-exports on `__seekdeepTest`. Commit `d40b19a`. | `node smoke_test.mjs` → pass=612 (identical to pre-extraction); both files `node --check` clean; added to preflight `js` stage. | Debt remains: index.js is still ~24k lines. Next leaves (image-reply intent, archive naming/count, template parsing, auto-reaction compile) should follow the same one-at-a-time-with-tests pattern. |

**Not reopened:** HIST-001…HIST-006 were re-verified as still-healthy and left unchanged.

