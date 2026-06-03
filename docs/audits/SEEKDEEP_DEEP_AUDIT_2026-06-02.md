# SeekDeep Deep Audit — 2026-06-02 (whole-codebase, critical pass)

> **⚠️ SUPERSEDED (2026-06-03) — most findings REMEDIATED.** Current state:
> [SEEKDEEP_AUDIT_2026-06-03.md](SEEKDEEP_AUDIT_2026-06-03.md). PERSIST-2/3, PYS-1,
> BOT-1, COUP-1, DUP-1/DUP-3 and the GUI XSS/auth items are fixed, and CSP dropped
> `unsafe-eval`, since this was written. Treat as a point-in-time record — verify
> against code before acting on any item.

> Comprehensive critical audit of `NathanNeurotic/SeekDeep-DiscordBot` at **v10.36.0**
> (commit after PR #4 merged the AUD-001…008 security work). This is a *new, from-scratch*
> critical pass — not a recycle of `SEEKDEEP_AUDIT_2026-06-02.md` (the earlier, narrower
> security audit, now closed). It exists to feed a remediation plan.

## Method

Seven independent critical sub-audits ran in parallel, each owning a slice and instructed to
verify every finding against actual code (no speculation): **Python servers**, **Node bot
(`index.js`)**, **Tauri/Rust shell**, **GUI frontend**, **architecture/tech-debt**,
**tests/CI/release/deps**, and **documentation**. Their findings were then **re-verified and
de-duplicated** by the lead before inclusion here. Where a sub-audit's claim was contradicted by
observed reality, it was downgraded or rejected (see Verification notes).

Severity key: `P0` exploitable/critical · `P1` high (security/data-loss/availability) ·
`P2` meaningful risk or correctness · `P3` low/polish · `DEBT` architectural drag.

## Verification notes (corrections to the raw passes)

- **CI-1 (claimed P0 "`npm ci` is dead from lockfile drift") — REJECTED / downgraded to P3.**
  A sub-audit asserted `package-lock.json` being at `10.35.28` while `package.json` is `10.36.0`
  breaks `npm ci` in every CI job. **Contradicted by reality:** the post-merge `main` runs of
  `preflight`, `e2e`, and `tauri-release` (which all run `npm ci`) **passed** at v10.36.0
  (verified via `gh run list`). `npm ci` tolerates a root-`version`-only mismatch. The lockfile
  drift is real **hygiene** (DEP-6 below), not a pipeline outage. The rolling release built fine.
- **DEP-1 / PYS-1 (`trust_remote_code=on` default) — CONFIRMED** (`.env.default:113`,
  `local_ai_server.py:332`). Real, kept at **P1** (authenticated, loopback-token-gated — not the
  P0 one pass proposed).
- **BOT-1 (ReDoS) — CONFIRMED, the sub-audit empirically reproduced** a 32.5 s event-loop freeze
  from a 7-char user pattern (`(a|a)*$`) that bypasses the existing shape-based detector. **P1.**
- **TST-5 (CSP harness "passes by construction") — PARTIALLY CONFIRMED.** The shipped CSP keeps
  `'unsafe-inline'`, so `e2e/csp.spec.mjs` cannot catch a newly-added inline `<script>` XSS. It
  *can* still catch a re-introduced `eval()` (since `'unsafe-eval'` was dropped) and cross-origin
  script loads. So it's a *weak* guard, not a useless one — labelled accordingly.

## Executive summary

The codebase is **materially healthier than its size suggests** and the recent AUD-001…008 work
landed well: SSRF policy + DNS pinning, signed-update machinery, tightened CSP, token-gated
endpoints, atomic-ish JSON writes, and good e2e/gui-smoke layers all verified solid. There is **no
unauthenticated remote P0**.

The real risks cluster in five places:

1. **Authenticated RCE by default** — `trust_remote_code=on` + an unrestricted `/model/install`
   means a loopback-token holder (or any GUI XSS that grabs the token) can run arbitrary code in
   the model server. *(PYS-1/DEP-1)*
2. **Self-inflicted total DoS** — a privileged user's auto-react regex runs on every message with
   an inadequate ReDoS guard; one 7-char pattern hangs the bot until restart. *(BOT-1)*
3. **Silent user-data loss** — two processes read-modify-write the same `data/*.json` with no
   cross-process lock (lost updates), and every reader silently treats a corrupt/partial file as
   empty then overwrites it (permanent wipe, no log, no backup). *(COUP-1 + PERSIST-2/3)*
4. **The `index.js` monolith** — 23,978 lines, 739 functions, ~200 globals, 5 parallel
   `interactionCreate` listeners whose correctness depends on hand-maintained ordering, and ~200
   silent `catch {}` blocks. Not a bug per se; the reason bugs here are expensive. *(ARCH-*)*
5. **Distribution trust** — release signing ships **inert** (no pinned key) and installers are
   **unsigned** (incl. tagged stable), so the self-update RCE surface's headline mitigation isn't
   actually active. *(REL-1/REL-2)*

Everything else is P2/P3/DEBT hardening and a sizeable documentation-drift backlog (notably
`docs/slash-parity.md`, which is confidently wrong about ~10 commands, and `REQUIREMENTS.md`'s env
block, which ships values that re-introduce a documented GPU-lockup).

## Top priorities (do these first)

| Rank | ID | Sev | One-liner |
|---|---|---|---|
| 1 | PERSIST-2 + PERSIST-3 | P1 | Corrupt/partial `data/*.json` → silent wipe on next write; add fsync. Cheapest huge risk-reduction. |
| 2 | COUP-1 | P1 | Two processes write the same `data/*.json` with no cross-process lock → lost updates. |
| 3 | PYS-1/DEP-1 | P1 | Default `trust_remote_code` **off**; allowlist/confirm `/model/install` repos. |
| 4 | BOT-1 | P1 | Auto-react regex ReDoS: move to `re2` / timeout / literal-only; shape-detector is bypassable. |
| 5 | REL-1 + REL-2 | P1 | Turn release signing on (pin key, require sig); sign stable installers. |
| 6 | CI-3 | P1 | No security scanning anywhere (npm/pip/cargo audit, secret scan, Dependabot/CodeQL). |
| 7 | TST-1/TST-2 | P1 | 36/90 routes + all image/vision endpoints + 0 interaction dispatchers untested. |

---

## Findings — Python servers (`gui_endpoints.py`, `local_ai_server.py`, `release_signing.py`)

- **PYS-1 · P1 · `local_ai_server.py:332,3852,4004,3131,3182`** — `trust_remote_code` defaults ON; `/model/install` accepts an arbitrary `model_id` with no allowlist → authenticated (loopback-token) RCE: install malicious HF repo → bind to a chat role → load → its Python runs in-process. **Fix:** default off; validate `model_id` (`^[\w.-]+/[\w.-]+$`), per-model opt-in for remote code, install-time confirmation.
- **PYS-3 · P2 · `local_ai_server.py:4274`** — chat tokenization has no `truncation`/`max_length`; `messages` (200 × 20k chars ≈ 4 MB) tokenized in one shot → CPU/RAM spike. **Fix:** `truncation=True, max_length=<ctx>`; aggregate payload-byte cap.
- **PYS-4 · P2 · `local_ai_server.py:314,4793,4857,5053,5170,5282,5563,5615`** — every image endpoint writes a PNG to `outputs/` that is never cleaned up (and is redundant with the base64 response) → unbounded disk growth. **Fix:** LRU/size/age cap on `outputs/`+`temp/`, or gate writes behind a debug flag.
- **PYS-5 · P2 · `local_ai_server.py:5629`** — `/chart` accepts unbounded `day_buckets` + unbounded `title`/`guild_name`, and is **not** in the singleflight set → concurrent matplotlib renders. **Fix:** cap bucket count + string lengths; serialize.
- **PYS-7 · P2 · `gui_endpoints.py:2955`** — self-update accepts semver **tags**, which are mutable on GitHub; the git-SHA gate verifies against whatever the tag currently points to, so a moved tag passes. The signature gate that would defend this is off by default (see REL-1). **Fix:** prefer full-SHA pins; ship + require signing.
- **PYS-9 · P3 · `local_ai_server.py:1600,1683,1810,3210`** — remote-backend `base_url`/`api_url` (openai-compat/anthropic/gemini) fetched with no host/scheme allowlist → authenticated SSRF primitive (read internal/metadata bodies back). **Fix:** reject private/loopback resolutions (reuse the AUD-002 policy), require `https://`.
- **PYS-10 · P3 · `gui_endpoints.py:3185,3278,3492`** — `shell=True` on Windows for `node`/`ollama`/`npm` spawns. No injection today (static argv) but a latent footgun. **Fix:** drop `shell=True` for the non-npm cases; resolve executables explicitly.
- **PYS-11 · P3 · `gui_endpoints.py:3216`** — `/system/warmup` forwards `--role` flags that `warmup_local_cache.py` doesn't accept → role-scoped warmup always exits non-zero (functional bug, not security). **Fix:** add the arg or stop forwarding it.
- **PYS-12 · P3 · `gui_endpoints.py:4138`** — unauthenticated `GET /config` returns the full non-secret env map (admin IDs, bot CWD, model IDs, routing IDs); redaction is key-name-based, so a secret in a non-secret-named key would leak. **Fix:** token-gate or narrow it; add value-shape redaction.
- **PYS-14 · P3 · `local_ai_server.py:2382`** — singleflight lock held across the entire request (full generation), incl. `/unload`; no acquire timeout → can't reclaim VRAM mid-generation; a wedged CUDA call wedges the lock forever. **Fix:** lock-acquire timeout → 503; finer lock for `/unload`.
- **PYS-16 · P3 · `gui_endpoints.py:5676`** — auto-react `pattern` stored unvalidated (length-capped only) then compiled to regex by the bot → stored ReDoS write-path (pairs with BOT-1). **Fix:** validate/timeout on the bot side.
- **PYS-2 / PYS-6 / PYS-13 / PYS-15 / PYS-17 · DEBT** — silent remote-code execution (no log when a load triggers it); unbounded `/events` subscribers; open `/route/debug`+`/models/installed` expose topology; benign model-state data races; persona/template/fact text rendered by GUI (XSS depends on front-end escaping — see GUI section).

**Verified clean (Python):** exhaustive auth-gating (no missing token deps on mutating/sensitive routes); no command injection (hardcoded argv, whitelisted service/variant values); path-traversal sinks `.resolve()`+`_is_inside`-checked; `/token` loopback+origin guarded; `.env` write rejects `\r`/`\n` injection; image byte/pixel/decompression-bomb caps; `release_signing.py` is a correct RFC-8032 impl with non-canonical-S guard + per-file + completeness checks.

## Findings — Discord bot (`index.js`, `lib/url-fetch-policy.js`)

- **BOT-1 · P1 · `index.js:16559,16612`** — **ReDoS DoS (reproduced: 32.5 s freeze on 28 bytes).** `reactrule add … /<regex>/` lets a Manage-Messages user store a regex `.test()`'d against every guild message on the event loop; the shape-based `seekdeepReactPatternRedosRisk` guard only catches nested-quantifier forms and misses alternation-overlap (`(a|a)*$`). One rule + one message = bot hang until restart. **Fix:** `re2` (linear), or match under a worker-thread timeout, or restrict patterns to literal substrings.
- **BOT-2 · P2 · `index.js:4313,4321,4824`** — image queue `pending` is unbounded and the default cooldown is `0` (no rate limit out of the box); emergency buttons pass `skipCooldown:true`. **Fix:** `MAX_PENDING` cap + per-user in-flight cap; small non-zero default cooldown.
- **BOT-3 · P2 · `index.js:17235`** — emoji-vault import has no decompressed-size/entry-count cap (zip-bomb): 32 MB compressed → GBs decompressed; the JSON branch `JSON.parse`s up to 32 MB. Gated by Manage-Messages. **Fix:** cap cumulative decompressed bytes + entry count + `parsed.emojis.length`.
- **BOT-5/BOT-6 · P3** — `SEEKDEEP_RECENT_IMAGE_SUBJECTS` (`index.js:10883`) and the cooldown maps (`4322/16088`) grow one entry per (channel,user) forever — no eviction, unlike sibling 200-cap LRUs. Slow leak. **Fix:** add the same LRU eviction.
- **BOT-7 · DEBT · `index.js:13651,13685`** — persona slug `__proto__`/`constructor` matches the slug regex; not prototype pollution (verified) but silently no-ops while reporting success. **Fix:** add to reserved set / `Object.create(null)`.
- **BOT-8 · DEBT · `index.js:4014,23626`** — temp-image-state id flows into `path.join` unsanitized; **not reachable** today (component IDs only come from the bot's own messages). Defense-in-depth: validate `^[a-z0-9_]+$`.
- **BOT-9 · DEBT · `index.js:22051,23486,23513,23940,23965`** — five `interactionCreate` listeners; correctness currently holds (disjoint prefixes or `seekdeepClaimEventOnce`) but depends on a hand-maintained invariant + overlapping `.includes('shared')&&.includes('archive')` predicates. One careless prefix = double-reply. **Fix:** one ordered dispatcher (see ARCH-2).
- **BOT-10 · DEBT · `index.js:92`** — file log redacts tokens/keys (good) but writes full prompt/message content + user IDs verbatim → plaintext PII store if ever multi-tenant. Document the single-user assumption.

**Verified clean (bot):** all user-URL fetches route through `seekdeepFetchWithLimits` (SSRF policy genuinely robust — scheme allowlist, private-range default-deny v4/v6, per-hop redirect re-validation, DNS-pinned agents); only `execFile('git',[…])` with a clamped numeric arg, no shell; atomic JSON persistence; global rejection handlers; AI circuit breaker; permission-gated persona/template writes; leading-address regexes load-tested non-catastrophic.

## Findings — Tauri/Rust shell (`src-tauri/`)

- **TAU-5 · P2 (one pass said P1) · `tauri.conf.json:30`** — CSP keeps `script-src 'unsafe-inline'` and `connect-src https:`/`img-src https:`, so an injected inline script executes **and** can exfiltrate to any HTTPS origin, bypassing the `open_external` allowlist for data egress. (Deferred per `CSP_TIGHTENING_PLAN.md`; no known XSS — hence P2 here, but it's the highest-leverage shell hardening.) **Fix:** drop `'unsafe-inline'` (nonce/hash migration), tighten `connect-src`/`img-src` off bare `https:`.
- **TAU-1 · P2 · `lib.rs:44-112,256`** — `install_python_deps`/`install_ml_deps`/`install_torch_variant`/`restart_sidecar` are invokable by any webview JS with no token/gesture check (`withGlobalTauri:true`); an XSS can downgrade torch to CPU or wedge a kill→pip→respawn loop. Args are validated (no injection). **Fix:** token-gate these commands like `/system/self-update`.
- **TAU-7/TAU-8 · P2 · `sidecar.rs:1271,1417,1478` + `lib.rs:256,45`** — process-supervision races: `kill_child` doesn't bump `watchdog_generation` (intentional-kill flag can be consumed by the wrong observer → a real crash gets respawn-suppressed); restart/install kill+respawn run outside the `boot_in_progress` guard (rapid Restart can kill a freshly-spawned child). Manifest as UX wedges under adversarial clicking. **Fix:** single serialized kill→spawn entry; pair every intentional-kill with a generation/epoch bump.
- **TAU-9 · P2 · `sidecar.rs:216+ / lib.rs:291+`** — system binaries (`netstat`/`taskkill`/`powershell`/`curl`/`docker`/`cmd`) spawned by bare name → Windows PATH-hijack if a writable PATH dir precedes System32. **Fix:** absolute paths for the canonical Windows tools.
- **TAU-13 · P2 · `sidecar.rs:462 ↔ gui_endpoints.py:3060`** — the `.self-updated` skip-list is an unsanitized path list that suppresses bundle re-extraction for same-version restarts; whoever can write it can **pin/freeze arbitrary runtime files** across every same-version reinstall — i.e. freeze a security fix, which is exactly the rolling-nightly path. **Fix:** validate entries against the bundled-file allowlist; bound age/size; key skips on content hash.
- **TAU-17 · P2 · `tauri.conf.json:65,82`** — installers unsigned (Windows + macOS), including **tagged stable** (`tauri-release.yml` uses the same null signing for `v*` and nightly). **Fix:** Authenticode-sign stable (or free Sigstore/Azure trusted signing).
- **TAU-2/TAU-3/TAU-6/TAU-10/TAU-11/TAU-12/TAU-14/TAU-16 · P3** — unauthenticated `try_start_docker_desktop`/`view_logs`; `withGlobalTauri` widens reach; cmdline-substring kill can nuke unrelated `node index.js`/`local_ai_server.py` processes; Job-Object best-effort with a post-spawn assign window + silent degrade; poisoned-mutex paths fail-open (skip shutdown/recovery); mtime-based "bundle is newer" decision is spoofable/fragile; `check_for_update` trusts GitHub JSON (contained by `open_external`).
- **TAU-4/TAU-15/TAU-19/TAU-20 · DEBT** — `open_external` `discord:` tail unvalidated + broad `*.huggingface.co`/`*.github.com`; `.seekdeep-tmp` orphans (non-unique name); tray self-update inlines a 30-line JS blob via `eval`; `default_window_icon().unwrap()` can panic at setup.

**Verified clean (Tauri):** tiny IPC surface (9 commands, no shell/fs/process plugins); `open_external` allowlist well-built + unit-tested (suffix-boundary correct); child teardown belt-and-suspenders (Job Object + cmdline sweeps + multiple exit paths); crate versions current (tauri 2.11.2), no known criticals.

## Findings — GUI frontend (`gui/`)

- **GUI-1 · P2 · `nav.js:170`** — `isOurServer` uses a string-prefix check, so `http://127.0.0.1:7865.evil.com/memory` is classified "ours" and gets `X-SeekDeep-Token` attached → token exfil. Reachable via `image-ab.html`'s user-pasted source URL (`srcToB64`). **Fix:** compare `new URL(url).origin === base` exactly.
- **GUI-12 · P2 · `app.html:4819`, `setup-wizard.html:214`** — server-supplied `fa.navigate` assigned straight to `location.href` (no scheme/allowlist) → `javascript:`/open-redirect if the local server is compromised (e.g. via the self-update path). **Fix:** allowlist relative `*.html` targets.
- **GUI-5 · P2 · `image-ab.html:350`** — user URL injected into an `src` attribute + inline `onerror` via `innerHTML` (self-XSS, but a true sink; feeds GUI-1). **Fix:** set `img.src` on a created element; drop inline `onerror`.
- **GUI-6/GUI-7/GUI-8/GUI-9/GUI-10 · P3** — user `model_id` / server `image_b64` / schema `f.key` interpolated into `innerHTML` unescaped (low-risk/self-XSS/trusted-server, but unvalidated sinks); inconsistent error-escaping in `image-ab.html`; two divergent `escapeHtml` impls in `app.html` (2364 full vs 5161 partial). **Fix:** `textContent`/validate; consolidate the escaper.
- **GUI-14/GUI-15 · P3** — `/system/verify` toast renders literal `<br>` (missing `html:true`); auto-react pane `loaded` latch blocks refresh after first success. **Fix:** trivial.
- **GUI-2/GUI-3/GUI-16 · DEBT** — token in `?token=` for WS/SSE (loopback-bounded); `SENSITIVE_READ_RE` is a maintenance-trap allowlist; ~150 empty `catch {}` (partly compensated by the global error toast).

**Verified clean (GUI):** no `eval`/`new Function`/`document.write`/`insertAdjacentHTML` anywhere; the genuinely-untrusted surfaces (Discord-authored memory facts, #prompts templates, persona tones, react rules, chat replies, log lines, leaderboard names, web-source URLs) are consistently escaped or `textContent`'d; 26 inline handlers are all static literals; server-down/boot/reconnect states are handled deliberately.

## Findings — Architecture & tech debt

- **ARCH-1 · P2 · `index.js`** — 23,978-line single-scope monolith (739 functions, ~200 globals, 106 comment-marker "modules" enforced by nothing). Whole-file blast radius for any change. **Fix:** extract leaf modules behind imports, one at a time (roadmap below).
- **ARCH-2 · P2 · `index.js:22051,23486,23513,23940,23965`** — 5 parallel `interactionCreate` listeners (3 named "Emergency"); precedence depends on registration order. **Fix:** one ordered dispatcher table — highest-value structural fix.
- **ARCH-3 · P2 · `index.js:9546,9638`** — 2 `shardDisconnect` listeners split disconnect behavior across two sites. **Fix:** merge.
- **COUP-1 · P1 · `index.js` ↔ `gui_endpoints.py` writers** — both processes read-modify-write the same `data/*.json` (user-facts, prompt-templates, auto-reactions, persona-overrides, custom-personas, archive-config, server-stats) with **no cross-process lock** (only in-process locks exist) → lost updates, last-writer-wins, silent. **Fix:** cross-process advisory lock (lockfile/`fcntl`) or single-writer-per-file via endpoints.
- **PERSIST-2 · P1 · `index.js` readers (e.g. `14192`, +8 sites)** — corrupt/partial JSON is silently caught → returned as empty default → **next write overwrites it** (permanent data loss, no log, no backup). **Fix:** on parse failure, rename to `*.corrupt-<ts>` + log loudly; never silently overwrite.
- **PERSIST-3 · P2 · `index.js:1343`, `gui_endpoints.py:5315`** — atomic writers `rename` without `fsync` → power-loss can leave a zero-length/stale file (which then trips PERSIST-2). **Fix:** `fsync(fd)` + `fsync(dir)` before/after rename.
- **PERSIST-1 · P1 · all `data/*.json`** — no `schema_version`/migration; Python `_normalize_*` runs on read-for-serve only (not on write, no Node equivalent) → the two processes hold divergent shape notions. **Fix:** `schema_version` + shared migration on load + normalize-on-write.
- **DUP-1 · P2 · 4 sites** — the runtime file-set is hand-enumerated in `gui_endpoints.py:2820`, `release_signing.py:52`, `tauri.conf.json:50`, `sidecar.rs:486` with no drift guard; mismatch silently breaks self-update/signing/bundling. **Fix:** single `release-files.json` SoT + preflight assertion.
- **DUP-2 · P2 · `local_ai_server.py:719`** — `TRUSTED_BROWSER_ORIGINS` falls back to a hand-copied literal on import failure → a stale CORS policy could apply silently. **Fix:** shared module; fail closed.
- **DUP-3 · P2 · env templates** — **103 of 222** code-referenced env keys (46%) are documented in neither `.env.default` nor `.env.example` (incl. `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GITHUB_TOKEN`, `LOCAL_AI_MAX_*`). Preflight only enforces `.default ⊆ .example`, not `code ⊆ templates`. **Fix:** add a `code ⊆ templates` guard (with an ignore-list).
- **DUP-4 · DEBT · `index.js`** — ~12 parallel dedup/cooldown mechanisms, each its own Map+TTL+sweep (copy-paste, off-by-one source). **Fix:** one `TtlMap` primitive.
- **DUP-5/DUP-6/DUP-7 · DEBT** — atomic-JSON writer reimplemented per language (Python one trapped in a route closure); dual command surface (mention parser vs slash, tracked manually in `docs/slash-parity.md`); `tweaks-panel.compiled.js` is a committed build artifact that can drift from the `.jsx`.
- **DEAD-1 · DEBT · `index.js:~16180`** — `TTS_VOICE` + `NSFW_GATE` feature flags gate UI/routing with **no backend** (`local_ai_server.py:5232` sets `safety_checker=None` — opposite of an NSFW gate); the settings page advertises a dead TTS toggle. **Fix:** delete until a backend exists.
- **DEAD-2/DEAD-3 · DEBT** — 15 `HOTFIX/EMERGENCY/PATCH/BYPASS`-named regions with likely-superseded overlapping pairs (5 regenerate-cooldown regions, duplicate reply-translate routes); wired-but-dormant image pipelines rot untested.
- **COUP-2/3/4/5/6 · P2** — bot↔server contract is bare path strings (rename → runtime 404, no build failure); event-type names duplicated across 4 files (typo → silently dropped); `nav.js PAGES[]` is a hidden surface registry; the designer-zip merge is a manual silently-failing overlay; triple overlapping process supervision coordinates via cmdline string-matching.
- **CONS-1/2/3 · P2/DEBT** — 202 silent `catch {}` in `index.js` (dominant diagnosis cost); ad-hoc inline env parsing everywhere (no config module); mixed ESM `import` + mid-file `require()`.

**Refactor roadmap (sequenced, low-risk first):** see "Proposed remediation plan" below.

## Findings — Tests, CI, release, dependencies

- **CI-3 · P1 · `.github/workflows/`** — **no security scanning at all** (no npm/pip/cargo audit, no secret scan, no Dependabot/CodeQL) for a project that ships self-updating installers + pip-installs torch on user machines. **Fix:** add `npm audit`/`pip-audit`/`cargo audit`/`gitleaks` job; enable Dependabot + CodeQL (free on public repos).
- **TST-1 · P1 · `smoke_test.mjs`** — 2,206 lines test pure helpers only; **0** of 5 interaction dispatchers and **0** HTTP handlers are tested. **Fix:** extract handlers into testable units; mocked-interaction dispatch tests.
- **TST-2 · P1 · `docs/ENDPOINT_COVERAGE.md`** — 36/90 routes untested, including the entire image/vision/inpaint/upscale surface (the most VRAM-/RCE-sensitive). **Fix:** TestClient contract tests (400/401/503 + ML_DEPS_MISSING) — no GPU needed.
- **REL-1 · P1 · `release_signing.py:47`** — signing ships **inert** (`RELEASE_SIGNING_PUBKEY_HEX=""`); the self-update repo-compromise defense isn't active in any build. **Fix:** generate offline key, pin it, sign releases, set `…REQUIRE_SIGNATURE=on`.
- **REL-2 · P1 · `tauri-release.yml:212`** — all installers unsigned incl. tagged stable (= TAU-17).
- **CI-2 · P2 · `preflight.mjs:320`** — version-sync guard checks `package.json`/`Cargo.toml`/`Cargo.lock` but **not** `package-lock.json` (the file that drifted). **Fix:** add it to the equality block.
- **CI-4/CI-5/CI-6 · P2** — `tauri-release.yml` duplicates `releaseBody` in two places (drift-by-comment) + no artifact-count verification; degraded e2e + silent self-skips can yield an all-green local run that tested almost nothing; `ml-deps-resolution` resolves Linux only — the Windows `+cu128` pins users actually install are never tested (add a `windows-latest` dry-run leg).
- **TST-3/TST-4/TST-5/TST-6 · P2/P3** — `/model/install` test blesses the permissive (PYS-1) behavior; `control-center.spec` hardcodes `v10.35.6` + magic counts; `csp.spec.mjs` is a weak guard while `'unsafe-inline'` stands (see Verification notes); `verify_e2e.py` (only real chat/launcher coverage) isn't in CI + mutates state.
- **DEP-1 · P1 ·** = PYS-1.
- **DEP-2 · P2 · `requirements-ml.txt:27`** — cu128 torch via `--extra-index-url` (permissive; comment claims it forces pytorch.org but the directive doesn't); no `--hash` pinning anywhere. **Fix:** `--index-url` for torch lines; consider `--require-hashes` for boot deps.
- **DEP-3/DEP-4/DEP-5 · P2/P3** — boot deps are floor-only `>=` (unreproducible fresh installs); CI pip-installs a hand-typed dep mirror that drifts from `requirements-local.txt`; loose carets + no `overrides`; `diffusers` pinned to a `.dev` build.
- **DEP-6 · P3 (was the false CI-1) · `package-lock.json`** — root `version` lags at `10.35.28` vs `package.json` 10.36.0. `npm ci` tolerates it (CI verified green) but it's stale. **Fix:** `npm install` to regenerate; add to the CI-2 guard.

## Findings — Documentation

- **DOC (P1) · `docs/slash-parity.md`** — confidently wrong about ~10 commands: claims `/status`, `/gpu`, `/template`, `/queue`, `/reactrule`, `/emoji`, `/archive setup` are "Mention-Only / not built" and even *recommends building* commands that already exist (`index.js:9024-9236`). **Fix:** delete or fully rewrite against `COMMANDS.md`.
- **DOC (P1) · `REQUIREMENTS.md:101,122-125`** — its env block ships **dangerous stale values**: `LOCAL_CHAT_QUANT_FULL_ROLES=default_chat,fallback_chat` (the exact value the v10.15 fix emptied because it locks up a 24 GB GPU) and memory caps `40/24000/30/20000` vs canonical `50/36000/40/28000`. A maintainer copying these reintroduces a documented crash. **Fix:** delete the block (point at `.env.default`) or regenerate it; add `REQUIREMENTS.md` to the preflight docs guard.
- **DOC (P1) · `CODEX_REPO_BRIEF.md:366,600`** — claims data writes use "direct `fs.writeFileSync` … verify before relying on atomic semantics" — the opposite of the truth (`writeJsonAtomic`, `index.js:1343`), contradicting AGENTS.md. Actively tells maintainers the code is less safe than it is. **Fix:** correct `CODEX_REPO_BRIEF.md` to describe the actual atomic-write semantics (`writeJsonAtomic`: temp-file write + `fsync` + atomic rename), matching AGENTS.md.
- **DOC (P2) · preflight description wrong in 6 docs** — README ("five stages"), MAINTAINER ("three stages"), CODEX, REQUIREMENTS, CONTRIBUTING, SMOKE_TEST (asserts `3 ok · 0 fail`, now prints up to `8 ok`). Actual = 8 stages (`js,html-js,py,smoke,gui-smoke,rust,docs,coverage`). **Fix:** state it once; have the others point at `preflight.mjs`'s stage comment.
- **DOC (P2/P3) · misc** — CODEX version `10.35.0` (actual 10.36.0) + omits `Archive (SeekDeep)` context menu + internal archive-config tracking contradiction; INTEGRATION "16 HTML files" (actual 24) + over-narrow "only 3 open reads" list (27 are open); README tunable `…REFINE_CACHE_TTL_MS` shows code default 3600000 while `.env.default` ships 600000; PLANNED has stale checkboxes (inpaint mask preview shipped; basic remember/forget shipped).

**Verified clean (docs):** SECURITY.md, RELEASE_SIGNING.md, DISCORD_SETUP.md, CSP_TIGHTENING_PLAN.md, ENDPOINT_COVERAGE.md, COMMANDS.md, AGENTS.md (post-reconciliation) all check out against code.

---

## Cross-cutting themes (the same root causes, many symptoms)

1. **Hand-maintained parallel lists that drift silently** — runtime file-set (×4), env templates vs code (103 missing), CORS origins, sensitive-files list, event names, route strings, the preflight description (×6 docs), `PAGES[]`, `releaseBody` (×2). *Every one of these wants a single source of truth + a preflight guard.* The repo already has the pattern (the docs/version/coverage guards); extend it.
2. **Silent failure as a habit** — ~200 empty `catch {}` in `index.js`, read-side defaulting that wipes data, swallowed normalize-on-serve. Bugs become invisible; this is the dominant reason diagnosis is expensive.
3. **Two processes, shared mutable files, no coordination** — the COUP-1/PERSIST cluster. The single biggest latent data-loss risk.
4. **Secure machinery shipped but switched off** — signing (inert key), CSP (`unsafe-inline` retained), `trust_remote_code` (default on). The hard part is built; the defaults/rollout aren't finished.
5. **The monolith multiplies everything** — every other theme is worse because it lives in one 24k-line file.

## Proposed remediation plan (phased)

**Phase 0 — cheap guardrails (days, little/no behavior change, highest risk-reduction/line):**
1. PERSIST-2 + PERSIST-3 — stop silent data-wipe + add `fsync` in both atomic writers. *(top priority)*
2. PYS-1/DEP-1 — flip `trust_remote_code` default off + validate `/model/install` model_id.
3. CI-3 — add audit/secret-scan job + Dependabot + CodeQL.
4. DEP-6 + CI-2 — regenerate `package-lock.json`; add it to the version-sync guard.
5. DUP-1 + DUP-3 — `release-files.json` SoT + `code ⊆ env-templates` preflight guard.
6. DOC P1s — delete/rewrite `slash-parity.md`; fix `REQUIREMENTS.md` env block (+ guard it); fix the `CODEX_REPO_BRIEF` atomic-write lie; fix the preflight description once.

**Phase 1 — close the active-risk gaps:**
7. BOT-1 — ReDoS: `re2`/timeout/literal-only for auto-react patterns.
8. COUP-1 — cross-process lock (or single-writer rule) for shared `data/*.json`.
9. REL-1 + REL-2/TAU-17 — turn signing on; sign stable installers.
10. TST-2 — contract tests for the image/vision/model routes (no GPU needed).
11. BOT-2/BOT-3 + PYS-3/4/5 — resource caps (image queue, zip-bomb, tokenizer truncation, outputs cleanup, /chart bounds).

**Phase 2 — structural de-risking (the monolith, leaf-first):**
12. Extract pure leaf modules from `index.js` in order: `json-store` → `text-redact` → `dedup-cache` (DUP-4) → `image-prompt` + character table → `model-router`.
13. ARCH-2/ARCH-3 — unify the 5 `interactionCreate` + 2 `shardDisconnect` listeners into ordered dispatchers (after 12).
14. DEAD-1/DEAD-2 — delete TTS/NSFW scaffolds + superseded hotfix layers.
15. CONS-1 — lint-ban empty `catch`; add minimal logging.

**Phase 3 — contracts, schema, CSP:**
16. COUP-2/3 — shared route-map + event-type constants with smoke assertions.
17. PERSIST-1/PERSIST-4 — `schema_version` + shared migration + one persisted-file registry.
18. TAU-5 + CSP plan — externalize inline scripts → drop `'unsafe-inline'` → tighten `connect-src`; then the CSP harness becomes a real guard.
19. TAU-1 — token-gate the install/restart Tauri commands.

**Phase 4 — big handlers & dual surface (highest effort, last):**
20. ARCH-4 — decompose `messageCreate`/`interactionCreate` into testable `route*` units.
21. DUP-6 — route mention + slash through one shared intent→handler layer.

## Verified healthy / do-not-reopen without new evidence

- AUD-001…008 (the prior security set) all verified still-effective: SSRF policy + DNS pin, signed-update *machinery*, tightened CSP (minus the deferred `unsafe-inline`), `open_external` allowlist, endpoint coverage map, bounded ML deps, env superset guard.
- No unauthenticated remote P0. No command injection. No path traversal. No `eval`/dangerous-DOM-sink in the GUI. Auth gating complete on the Python servers. Crate versions current.
- **Rejected:** CI-1 ("npm ci dead") — false (CI green at 10.36.0). The lockfile issue is hygiene (DEP-6), not an outage.

---

*Generated by 7 parallel critical sub-audits + lead verification. Every cited `file:line` was checked against the v10.36.0 tree. Findings are leads for a plan; re-confirm a finding against current code before acting on it.*
