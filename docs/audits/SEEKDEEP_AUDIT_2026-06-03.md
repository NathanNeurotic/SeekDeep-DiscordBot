# SeekDeep — Extensive Codebase Audit (2026-06-03)

**Scope:** whole repo at `main` @ v10.38.2, after the deep-audit remediation
(PERSIST, PYS-1, BOT-1, GUI-1, CI-3, BOT-2/PYS-4, 2 DOM-XSS, COUP-1, DUP-1/DUP-3).
**Method:** 7 parallel read-only domain auditors (index.js, local_ai_server.py,
gui_endpoints.py, gui/, src-tauri/, CI/release, docs/tests), each instructed to
verify-before-flag and to check whether the recent fixes hold + what they missed.
Findings below were re-verified by the synthesizer; **2 agent findings were
rejected as false positives** (see end).

---

## Executive summary

**The codebase is in genuinely strong shape.** Zero P0, zero P1 *security*
findings. The two most security-sensitive subsystems — the GUI control-plane
(`gui_endpoints.py`) and the AI server (`local_ai_server.py`) — came back clean:
every mutating route is token-gated, there is no command-injection vector, PYS-1
model-id validation is unbypassable, input caps are enforced before allocation,
and the COUP-1 cross-process lock is **correctly implemented and wired at all ~44
sites** (independently verified in both languages). No new exploitable DOM-XSS.

What the audit *did* surface is a coherent **"round-2" backlog** of P2
hardening + cleanup, notably: two unbounded in-memory leaks in the bot, a Tauri
Windows-hardening cluster, **two real bugs in the DUP-1/DUP-3 guards shipped last
session**, and a genuine **test-coverage gap on COUP-1's cross-process contract**
(its whole reason for existing). None are on fire; all are worth a focused pass.

| Severity | Count | Theme |
|---|---|---|
| P0 | 0 | — |
| P1 | 1 | COUP-1 cross-process mutual-exclusion **untested** (test gap, not a live vuln) |
| P2 | 12 | memory leaks · Tauri hardening · guard bugs · CI perms · onerror sink · test/doc gaps |
| P3 | ~16 | escaping consistency · perf · pinning · doc staleness |
| P4 | 2 | minor robustness (`/chart` 400-vs-500, path in error detail) |

---

## P1 — highest priority

### [TEST-1] COUP-1 cross-process mutual exclusion is untested
`smoke_test.mjs:2264+` tests `seekdeepMutateJson` round-trip + stale-steal **within
one Node process**; the Python `_seekdeep_file_lock` (`gui_endpoints.py:5339`) has
**zero** test coverage, and neither side tests the fail-open timeout. COUP-1's
entire purpose — Node and Python not clobbering each other — is the one path with
no test. **Fix:** a two-process test (holder takes `<path>.lock`; assert the other
side waits then proceeds) + a gui-smoke unit test of the Python lock
acquire/stale-steal/timeout. *(Test gap — the lock itself was verified correct by
the index.js + gui_endpoints auditors.)*

---

## P2 — round-2 backlog

**Memory / resource (index.js)**
- **[BOT-1] `index.js:19016`** — conversation-memory store (`...COMPAT_STORE_V13` Map) trims each key's array but **never deletes whole keys**; every distinct (channel,user) is a permanent ~50-msg/36 KB entry. Largest growth vector. Fix: LRU/TTL whole-key eviction (mirror the 200-cap siblings).
- **[BOT-2] `index.js:11097`** — `SEEKDEEP_RECENT_IMAGE_SUBJECTS` grows unbounded; its two siblings cap at 200, this one was missed. Fix: same cap, or delete on the stale-read branch (`:11270`).
- **[PYS-6] `local_ai_server.py:4590-4611`** (P3) — video temp file leaks on the decode-error path (`unlink` is inside `try` after the frame loop; a corrupt upload jumps to `except` and re-raises without cleanup; only the 72 h age-sweep reclaims it). Fix: `try/finally` around the decode.

**Tauri shell (Windows hardening + correctness)**
- **[TAU-9] `sidecar.rs:216,225,277,329` / `lib.rs:291,354,363,383`** — system tools (`netstat`/`taskkill`/`powershell`/`curl`/`docker`) spawned by **bare name** → PATH-hijack with app privileges. Fix: absolute `%SystemRoot%\System32\…` paths.
- **[TAU-1] `lib.rs:28-112,256-274`** — privileged IPC (`install_*`, `restart_sidecar`) is **ungated** and `withGlobalTauri` exposes `invoke` to every page; an injected inline script (allowed by `unsafe-inline`) could downgrade the GPU / wedge the sidecar. Abuse/DoS, not injection. Fix: token or user-gesture gate.
- **[TAU-5] `tauri.conf.json:30`** — CSP `connect-src`/`img-src` still allow bare `https:` → an injected script could **exfiltrate the GUI token** to any origin (opener is locked, data-egress isn't). Part of the deferred CSP work; the load-bearing half AUD-003 left open.
- **[TAU-N1] `sidecar.rs:626-649`** (NEW) — the **Rust shell never loads `.env`** (only OS env), yet docs call `SEEKDEEP_PYTHON` / `SEEKDEEP_TAURI_*` / `SEEKDEEP_CLOSE_HIDES_TO_TRAY` ".env" knobs → they silently do nothing in the shell. Fix: load `<runtime>/.env` in Rust before `find_python`/exit handlers, or correct the docs to say "real env var".

**Guard bugs (the DUP-1/DUP-3 work shipped last session)**
- **[CI-4] `scripts/check-env-coverage.mjs:30-49`** — env-coverage guard **never scans Rust**, so 3 Rust-read `SEEKDEEP_*` knobs (incl. security-relevant `SEEKDEEP_PYTHON`) are undocumented *and the guard passes green*. Fix: add a `std::env::var` scan over `src-tauri/src/*.rs`; document the 3 (or ignore-list internal ones).
- **[CI-5] `scripts/check-release-files.mjs:20-32`** — `extractArray` takes the *first* `]` after `[`, so a `]` inside a comment/string truncates the list (reproduced 3 ways); case A can **mask** drift. Fix: strip `//`/`#` comments + quoted strings before locating the close bracket.

**CI / supply-chain**
- **[CI-6] `ci.yml`, `e2e.yml`, `ml-deps-resolution.yml`** — no top-level `permissions:` → inherit the broad default `GITHUB_TOKEN` scope. Fix: `permissions: { contents: read }`.

**Frontend**
- **[FE-2] `gui/image-ab.html:350`** — builds `<img src="${url}" onerror="…">` from the operator-typed URL field via `innerHTML`; `x" onerror="…` breaks out (self-XSS, but a real sink). Fix: `createElement` + `img.src`, drop the inline `onerror`.

**Tests / docs**
- **[TEST-4] `scripts/smoke_gui_endpoints.py`** — the generation endpoints (`/image /vision /img2img /upscale /instruct-pix2pix /inpaint /chart`) have **no no-GPU contract test** (400 bad-payload / 401 / 503 ML_DEPS_MISSING). These don't need torch. Fix: TestClient assertions on `local_ai_server.app`.
- **[DOC-6] `docs/audits/SEEKDEEP_AUDIT_2026-06-02.md` + `SEEKDEEP_DEEP_AUDIT_2026-06-02.md`** — both presented as "current-state" but now **stale and understating safety** (list `unsafe-eval` as present [dropped], AUD-001/COUP-1 as unimplemented [done]). A future agent treating them as ground truth would "re-fix" fixed items. Fix: add a SUPERSEDED/remediation banner to both (this doc is the current state).

---

## P3 — polish (abridged)

- **Frontend escaping consistency** (low-risk, server/operator data, *not* attacker passthrough): `[FE-1]` app.html:6372 catalog `tier`/`size_gb`; `[FE-3]` api.html:1035/1056 url + error; `[FE-4]` api.html role fields + app.html `escapeHtml` missing `"`/`'`; `[FE-5]` settings.html:221 config `f.key`. Route through the existing `esc()`/`escapeHtml`.
- **Frontend CSP enumeration `[FE-6]`** — inventory of what blocks a strict CSP (inline `<script>` per page, injected `<style>`, inline `style=`, the one runtime `onerror`). Scoping doc for the deferred CSP work.
- **index.js `[BOT-3]`** per-message sync `fs` read + regex recompile when auto-react is *on* (cache + invalidate on writes); `[BOT-4]` two cooldown Maps never shed expired keys; `[BOT-5]` (P4-ish) `archive-optout.json` RMW is the lone shared-namespace file not routed through `seekdeepMutateJson` — but Python only reads it, so no lost-update today (defensive uniformity only).
- **Tauri `[TAU-N2]`** bare-name Python fallback + `current_dir` hijack; `[TAU-N3]` the CSP e2e harness swallows nav errors / no interactions (a gap in our own AUD-003 harness); `[TAU-13/10/11]` `.self-updated` skip-list unvalidated + cmdline-substring process kills (can kill an unrelated user `node index.js`/`python …`).
- **CI `[CI-7]`** 3rd-party actions pinned to mutable tags (`@stable`, `@v0`) not SHAs (sharpest on the write-capable release job); `[CI-8]` env-guard blind to dynamic `os.getenv(DICT[role])` keys; `[CI-9]` CI's hand-maintained pydeps list is unguarded drift.
- **Docs staleness:** `[DOC-1]` CODEX_REPO_BRIEF version 10.36→10.38.2; `[DOC-2]` `.env.example` VRAM_PRESSURE_MODE says "strict" — code is `warn|force-evict`; `[DOC-3]` `.env.example` GUI_AUTH_ALLOW_OPEN mislabeled (gates the AI-server token check, value `=1`); `[DOC-4]` REQUIREMENTS.md dotenv ^16→^17; `[DOC-5]` README vs .env.default refine-cache TTL mismatch; `[DOC-7]` AGENTS.md version stamp (qualified, fine).
- **gui_endpoints `[GUI-1]`** `/system/use-venv` persists an operator-supplied interpreter path (within token=operator threat model; optional basename allowlist).

## P4
- **[PYS-7] `local_ai_server.py:5743`** `/chart` 500s instead of 400 on a malformed `day_buckets` payload (token-gated robustness).
- **[PYS-8] `local_ai_server.py:2488`** global exception handler can echo absolute filesystem paths in `detail`, bypassing the `LOCAL_AI_DEBUG_PATHS` gate (minor info-leak to an already-trusted caller).

---

## Rejected (false positives — held to the no-FP bar)
- **TEST-2** ("`(a|a)*$` ReDoS bypass untested") — the test **exists** at `smoke_test.mjs:156`.
- **TEST-3** ("BOT-2 queue admission untested") — **6** `queue admission` assertions exist in `smoke_test.mjs`.

---

## Suggested remediation order
1. **Cheap + mine to fix now** (introduced last session): CI-4, CI-5 (guard bugs), DOC-2, DOC-3 (my `.env.example` errors), DOC-6 (audit banners).
2. **Real resource leaks:** BOT-1, BOT-2, PYS-6.
3. **Tauri hardening pass (own PR):** TAU-9, TAU-1, TAU-N1 (TAU-5 folds into the deferred CSP work).
4. **CI hardening:** CI-6 (perms), CI-7 (SHA pins).
5. **Test gaps:** TEST-1 (COUP-1 cross-process), TEST-4 (generation contracts).
6. **Frontend cleanup:** FE-2, then the FE-1/3/4/5 escaping-consistency sweep.
7. P3/P4 doc + polish as convenient.
