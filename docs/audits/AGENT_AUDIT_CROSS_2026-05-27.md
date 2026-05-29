> **SUPERSEDED 2026-05-29 — historical snapshot, not current.**
> Archived from the repo root (audit DOC-4). Figures here (endpoint
> counts, LOC, "unverified" flags) reflect the date in the filename
> and contradict the live code. Kept for provenance only; do not cite
> as current state.

# SeekDeep · Cross-Audit Consolidation · 2026-05-27

**Author:** Claude (Opus 4.7), session `c33cbb0b-fc38-4f56-a9f8-985386a2b92b`
**Repo SHA after this session:** `bcfa46a` (origin/main, in sync)
**Predecessor:** `AGENT_AUDIT_2026-05-27.md` (snapshot at `5ac6ca7`, before P0 security fixes)

This document consolidates **four independent audit reports** — Antigravity, Codex (OpenAI), OpenCode (FreeRouter), and my own Claude prior pass — against the actual code state. The audits ran from roughly the same base in parallel without knowing about each other, so claims often overlap but never quite agree on severity, location, or whether the bug is real.

The pattern that emerged: **claims that show up in 2+ audits independently are almost always real**. Claims unique to one audit are 50/50 — half real, half over-eager pattern-match.

---

## §1 Convergence map (claim × audit)

| Claim | Antigravity | Codex | OpenCode | Claude (prior) | Real? | Status after `bcfa46a` |
|---|---|---|---|---|---|---|
| **CORS=\* enables browser drive-by exfil of /token** | AUD-001 P0 | P0 #1 | (implied via "Token leakage if .env exposed") | S1 VERIFY-ONLY (under-rated) | **YES** | **RESOLVED** |
| **/chat, /vision, /image etc lack token gate** | AUD-005 High | P0 #2 | — | A4 VERIFY-ONLY (under-rated) | **YES** | **RESOLVED** |
| **/logs/tail + /logs/stream unauthenticated** | — | P0 #3 | — | — | **YES** | **RESOLVED** |
| **auto-reactions.json unauthenticated leaks IDs** | — | P1 #1 | — | — | **YES** | **RESOLVED** |
| **/config newline-injection via _merge_env** | AUD-004 High | — | — | — | **YES** | **RESOLVED** |
| **5x interactionCreate listeners** | AUD-006 Medium | P2 #2 | — | §1/AUD-005 DO-NOT-FIX | **smell, not bug** | DOCUMENTED (verified disjoint customIds) |
| **clientReady event never fires** | AUD-002 Critical | — | — | §1/AUD-002 DO-NOT-FIX | **NO** (false positive — discord.js v14.18+ uses this name) | DOCUMENTED |
| **"show me how cakes are baked" → SDXL** | AUD-003 High | — | — | §1/AUD-003 DO-NOT-FIX | **NO** (already fixed at index.js:9712) | DOCUMENTED |
| **Uploads tracked in git** | AUD-008 Low | (mentioned in Hygiene) | — | AUD-006 RESOLVED | YES | RESOLVED `5ac6ca7` |
| **Self-update fetches mutable main, no signature** | — | P1 #2 | — | A6 + A7 VERIFY-ONLY | **partial** (allowlist OK, no signature) | OPEN |
| **SSRF / private-IP policy in fetch helpers** | — | P1 #3 | — | — | **YES** | OPEN |
| **base64/text models uncapped (Inpaint/Pix2Pix/Upscale)** | — | P1 #4 | — | S4 VERIFY-ONLY | **YES** | OPEN |
| **PIL decompression-bomb defenses missing** | — | P1 #5 | — | — | **YES** (PIL.MAX_IMAGE_PIXELS default is 178M but bypassed by `.load()` after `convert()`) | OPEN |
| **CUDA version lock unverified at install** | AUD-007 Medium | — | — | A3 P1 | **YES** | OPEN |
| **Tauri CSP null + withGlobalTauri** | — | P2 #1 | — | — | **VERIFY** | OPEN |
| **Stale doc claims index.js ~16k LOC** | — | P2 #3 | — | A1 DEBT | **YES** | **RESOLVED** (AGENTS.md + README.md) |
| **No security CI** | — | P2 #4 | — | T2/T3 P1 | **YES** | OPEN |
| **Feature flag doc reconcile (SECURITY.md)** | — | P2 #5 | — | — | needs reading | OPEN |
| **index.js 22k-line monolith** | — | — | (suggested refactor) | A1 DEBT | YES (smell) | DOCUMENTED |
| **VRAM headroom alerts** | — | — | (Performance Bottlenecks) | — | needs verify | OPEN |
| **OCR mode timeout on /vision** | — | — | (Refactor Tasks #4) | — | needs verify | OPEN |

**Reading this table:**
- Items where 2+ audits agreed and verification confirmed → fixed this session (or fixed earlier).
- Items where audits agreed but verification showed false → DOCUMENTED so future audits stop re-flagging.
- Items only one audit raised, but verification confirmed real → OPEN with severity.
- The Claude prior pass under-rated the CORS/auth chain (had it as VERIFY-ONLY). Codex + Antigravity were correct to escalate.

---

## §2 What this session fixed (commit `bcfa46a`)

### CORS hardening
- `local_ai_server.py:566` — `allow_origins=["*"]` → `list(_TRUSTED_ORIGINS)` where the trusted list lives in `gui_endpoints.py` (with mirror fallback in `local_ai_server.py` if the import fails during init).
- Trusted origins: `http://127.0.0.1:7865`, `http://localhost:7865`, `http://tauri.localhost`, `tauri://localhost`, `https://tauri.localhost`.
- **Verified:** CORS preflight from `Origin: https://evil.com` returns `400 Disallowed CORS origin` (FastAPI's CORSMiddleware enforces).

### /token defense-in-depth
- `gui_endpoints.py:1044-1067` — added Origin allowlist + Sec-Fetch-Site cross-site rejection.
- **Verified:**
  - `curl -H "Origin: https://evil.com" /token` → 403 with enumerated allowed list
  - `curl -H "Sec-Fetch-Site: cross-site" /token` → 403
  - `curl -H "Origin: http://tauri.localhost" /token` → 200
  - `curl /token` (no Origin, server-to-server) → 200

### Token gate on 9 inference + 2 logs + 1 data endpoint
- `local_ai_server.py` — `@app.post(..., dependencies=[Depends(require_gui_token)])` added to: `/chat`, `/vision`, `/image`, `/img2img`, `/upscale`, `/instruct-pix2pix`, `/inpaint`, `/inpaint_mask_preview`, `/chart`.
- `gui_endpoints.py` — same added to `/logs/tail`, `/logs/stream`.
- `gui_endpoints.py:2582-2591` — `auto-reactions.json` added to `_DATA_TOKEN_REQUIRED` (now 8 files token-gated; was 7).
- **Verified:** Each endpoint returns 401 with recovery instructions when token absent.

### Bot postLocal token attachment
- `index.js:2054-2080` — reads `process.env.SEEKDEEP_GUI_TOKEN` and attaches as `X-SeekDeep-Token` on every POST to the local AI server. Empty token → header omitted so the 401 error message explains how to set it.

### Env-injection lock (antigravity AUD-004)
- `gui_endpoints.py:340-360` — added `_ENV_KEY_RE` (`^[A-Z_][A-Z0-9_]*$`) and value-newline rejection before merge.
- **Verified:**
  - `POST /config {"updates":{"FOO":"x\nSEEKDEEP_GUI_TOKEN_DISABLED=1"}}` → 400 `"env value for 'FOO' contains newline; refusing to write"`
  - `POST /config {"updates":{"foo; rm -rf /":"x"}}` → 400 `"invalid env key 'foo; rm -rf /': must match ^[A-Z_][A-Z0-9_]*$"`

### Doc drift
- `AGENTS.md:10` — `~16k+ lines after v10.0–v10.29` → `~22.5k lines as of v10.35.6`.
- `README.md:49` — ASCII diagram `~16k lines ESM` → `~22k lines ESM`.

### Test updates
- `scripts/smoke_gui_endpoints.py:363-375` — `/data/auto-reactions.json` test now sends token (expects 200) AND probes no-token case (expects 401). Gui-smoke count bumped 175 → 176.
- `scripts/verify_e2e.py:34` — attaches token on EVERY request (not just writes) since `/logs/tail` is now gated.

### Final verification
- Preflight `5/5 · 565 unit · 176 GUI` — all green.
- E2E sweep `18/18 pass` — all 18 endpoints work for authenticated callers; bot launches + stops cleanly; `/chat` returns real LLM text via granite-3.3-8b-instruct.
- 10 active security probes (curl): all return expected status codes.

---

## §3 Still open — task list for next agent

Tasks are ordered by severity. Each has evidence, a verification step, and a suggested patch outline.

### OPEN-P1-A · Self-update has no signature verification
**Severity:** P1
**Evidence:** `gui_endpoints.py:1744-1875` (post-`bcfa46a` line numbers). Accepts `main` / `v*` tag / 7-40 char SHA. Fetches via `urllib.request` from `raw.githubusercontent.com`. No GPG signature check, no SHA256 manifest verification.
**Threat:** Mutable `main` ref means any push to the upstream repo (including a maintainer mistake or a compromised CI key) propagates instantly. Codex P1 #2.
**Verification:**
```bash
grep -n "ref ==.*main\|signature\|gpg\|hashlib" gui_endpoints.py | head -10
```
**Suggested patch:**
1. Default ref to latest stable release tag, not `main`.
2. Fetch a `SHA256SUMS.txt` from the release artifacts; verify each downloaded file matches.
3. Optional: GPG-sign the release tags and verify signature before applying.
**Risk:** Medium — requires release pipeline coordination. User decides whether to ship signed releases.
**Effort:** 3-4 hours code + 1 hour CI workflow.

### OPEN-P1-B · seekdeepFetchWithLimits lacks private-IP / SSRF policy
**Severity:** P1
**Evidence:** `index.js:1215` for the helper; `index.js:10742` link previews; `index.js:14586` URL image inputs. Codex P1 #3.
**Threat:** A Discord user can paste a URL pointing at `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS metadata) or `http://127.0.0.1:7865/data/user-facts.json` (loopback exfiltration of OUR OWN data via OUR OWN fetch helper). The current helper caps size + timeout, but does not validate the target host.
**Verification:**
```bash
grep -nB2 -A10 "function seekdeepFetchWithLimits" index.js | head -30
```
**Suggested patch:**
1. Parse URL, reject schemes other than `http:` / `https:`.
2. Resolve hostname; reject if it resolves to:
   - `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1/128`, `fc00::/7`, `fe80::/10`
   - Multicast / link-local
3. Reject redirects that resolve to the above.
4. Smoke test with each IP range.
**Risk:** Medium — DNS rebinding attacks (resolve to public IP, then to private on retry) need pinning the resolved IP across the connection.
**Effort:** 3-5 hours.

### OPEN-P1-C · base64/text request models uncapped
**Severity:** P1
**Evidence:** `local_ai_server.py` `InpaintMaskPreviewRequest` (~line 2044), `InstructPix2PixRequest`, `UpscaleRequest` (~line 2061). Codex P1 #4.
**Threat:** A 100MB base64 prompt locks the FastAPI worker decoding it before any size check runs. With auth now in place (this session's fix), threat reduced to authenticated insider, but still a footgun.
**Verification:**
```bash
grep -nB1 -A15 "class InpaintMaskPreviewRequest\|class InstructPix2PixRequest\|class UpscaleRequest" local_ai_server.py
```
**Suggested patch:** Add `Field(max_length=...)` matching the decode caps that already exist deeper in the pipeline (`local_ai_server.py:1635`).
**Risk:** Low.
**Effort:** 30 min.

### OPEN-P1-D · PIL decompression-bomb defenses (pixel-count cap before .load())
**Severity:** P1
**Evidence:** `local_ai_server.py:1681` `open_image_b64()`, `:3849` media frames, `:4264` upscale loads. Codex P1 #5.
**Threat:** A 100×100 PNG can decompress to a multi-gigapixel raster ("zip bomb" equivalent for images). PIL's default `MAX_IMAGE_PIXELS` is ~178M but bypassed by `.load()` after `.convert()`.
**Verification:**
```bash
grep -n "MAX_IMAGE_PIXELS\|DecompressionBomb\|Image\.open\|\.load()" local_ai_server.py | head -10
```
**Suggested patch:**
```python
from PIL import Image
img = Image.open(...)
# Hard cap regardless of PIL's defaults
if img.width * img.height > 25_000_000:  # 25 megapixels
    raise HTTPException(400, f"image too large: {img.width}x{img.height} > 25Mpix")
img.load()  # only after the check
```
Apply at all 3 sites.
**Risk:** Low.
**Effort:** 45 min.

### OPEN-P2-E · Tauri CSP null + withGlobalTauri enabled
**Severity:** P2
**Evidence:** `src-tauri/tauri.conf.json:30` (csp), `src-tauri/tauri.conf.json:13` (withGlobalTauri). Codex P2 #1.
**Threat:** XSS in any GUI HTML page can use `window.__TAURI__` to invoke commands like `open_external(url)` at `src-tauri/src/lib.rs:124` — which Codex notes accepts caller-supplied URLs. Combined with the now-resolved CORS hole, this was a chained attack path. With CORS fixed, severity drops but the Tauri side is still a sharp edge.
**Verification:**
```bash
cat src-tauri/tauri.conf.json | grep -A2 "csp\|withGlobalTauri"
grep -nB1 -A10 "open_external" src-tauri/src/lib.rs
```
**Suggested patch:**
1. Set `csp` to a strict policy:
   ```
   "default-src 'self' http://127.0.0.1:7865 ws://127.0.0.1:7865; img-src 'self' data: http://127.0.0.1:7865; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
   ```
   (Inline scripts/styles are used heavily — see Claude prior audit §4 F3 noting 29 inline JS blocks. Killing `unsafe-inline` is a bigger refactor.)
2. Audit `open_external(url)` — restrict to https URLs, deny `javascript:` / `file:` / `data:` schemes.
3. Consider disabling `withGlobalTauri` after verifying no inline JS uses `window.__TAURI__` (some does — nav.js detects it for base-URL routing).
**Risk:** Medium — CSP changes break GUI in subtle ways; needs visual verification in live Tauri.
**Effort:** 2-3 hours.

### OPEN-P2-F · Verify CUDA driver compat at install time
**Severity:** P2
**Evidence:** `requirements-ml.txt:27-30` pins `torch==2.5.1+cu128` (CUDA 12.8). `setup_local.ps1:95-99` installs requirements but does not check `nvidia-smi` for compute capability. Antigravity AUD-007.
**Threat:** Users on older drivers (CUDA 11.x or 12.4) silently fall back to CPU after install completes "successfully" — slow and confusing.
**Suggested patch:** Add a check in `setup_local.ps1` that runs `nvidia-smi --query-gpu=driver_version --format=csv,noheader`, parses the major version, and warns if < 535 (the minimum for cu128). Same check should exist in `scripts/doctor.mjs` for the Installer's System-check step.
**Effort:** 1 hour.

### OPEN-P2-G · No security-focused CI
**Severity:** P2
**Evidence:** `.github/workflows/ci.yml:78` runs preflight only. Codex P2 #4.
**Suggested patch:**
1. Add a scheduled (weekly) job: `npm audit --omit=dev`, `pip-audit`, `cargo audit --manifest-path src-tauri/Cargo.toml`.
2. Non-blocking initially; promote individual checks to gates after triage.
3. Optional: GitHub CodeQL or Semgrep with a SeekDeep-tuned ruleset.
**Effort:** 2-3 hours.

### OPEN-P2-H · Reconcile feature-flag docs
**Severity:** P2 (doc-only)
**Evidence:** Codex P2 #5 — SECURITY.md:51 says `SEEKDEEP_FEATURE_*` flags default OFF, but SECURITY.md:55 says img2img is ON by default.
**Action:** Read SECURITY.md, audit each flag's actual default in `index.js`, fix the doc. No code change needed if defaults are intentional — just document the exceptions.
**Effort:** 30 min.

### OPEN-VERIFY-I · OpenCode-suggested items (low signal — verify before acting)
- **VRAM headroom alerts** (Performance Bottlenecks) — check if `LOCAL_CHAT_QUANT_FULL_ROLES` default is sensible; add VRAM alerts at chat+vision+image co-residence.
- **OCR mode timeout on /vision** — check if `/vision` has a per-mode timeout. If unbounded, add 60s default.
- **Centralize feature-flag dispatch** — refactor candidate; high risk for unclear gain. Verify there's actually dead-code from gating mismatches before touching.
- **Audit ArchiveKey duplicate suppression** — needs an actual bug repro, not speculative.
- **Modularize data/ persistence into dedicated service** — same as Claude §2 A1 DEBT. Multi-session refactor; not urgent.

### CARRY-OVER from `AGENT_AUDIT_2026-05-27.md` (pre-CORS-fix)
The prior audit's §5 security tasks S1-S5 are partly subsumed by this session's fixes:
- **S1 Token provenance** — re-verify after this session's changes. Token is `_current_token()` reading from `.env`; rotation behavior unchanged but the gate is now actually used.
- **S2 Path traversal /data/{file}** — still UNVERIFIED. Run the two `curl ../etc/passwd` probes from S2 against the running server.
- **S3 ref validation** — still open (`gui_endpoints.py:1751` accepts 7-40 char hex; ranges from `0000000` to a real SHA both pass).
- **S4 chat body size** — partially addressed by token gate (only authed callers can spam). Add `Field(max_length=8000)` as defense-in-depth.
- **S5 GitHub fetch size cap** — still open (no cap on `r.read()` in self-update).

Tests T1-T5 from the prior audit are still mostly open. T2 (verify_e2e.py not in CI) is the most actionable.

---

## §4 Audit-report-quality scorecard

(So future audits can be triaged faster.)

### Antigravity (`SeekDeep Agentic Repository Audit & Task List`)
- **Format:** Best (8 IDs, cited file:line for everything, severity-tagged, has remediation checklist)
- **Accuracy:** Mixed
  - AUD-001 (CORS exfil) — **correct + escalated correctly**
  - AUD-002 (clientReady) — wrong (v14.18+ uses it natively)
  - AUD-003 (intent routing) — wrong (already fixed)
  - AUD-004 (env injection) — **correct + uncovered alone**
  - AUD-005 (token-less inference endpoints) — **correct + escalated correctly**
  - AUD-006 (5 listeners) — smell, not bug (but flagging is defensible)
  - AUD-007 (CUDA lock) — correct but lower severity
  - AUD-008 (uploads) — correct
- **Unique value:** Caught AUD-004 (env injection) that nobody else caught.

### Codex (`Audit report for follow-on agents`)
- **Format:** Sparse — paragraph form with P0/P1/P2 tags. No structured table.
- **Accuracy:** Highest of all four
  - P0 #1 (CORS exfil) — correct
  - P0 #2 (heavy endpoints lack auth) — correct + actionable (mentioned postLocal needs updating, which was the key follow-on)
  - P0 #3 (token-gate log reads) — **correct + uncovered alone**
  - P1 #1 (auto-reactions exposure) — **correct + uncovered alone**
  - P1 #2 (self-update unsigned) — correct
  - P1 #3 (SSRF in fetch helpers) — **correct + uncovered alone**
  - P1 #4 (base64 caps) — correct
  - P1 #5 (PIL decompression bomb) — **correct + uncovered alone**
  - P2 #1 (Tauri CSP) — correct
  - P2 #2 (5 listeners) — same smell as Antigravity
  - P2 #3 (doc drift) — correct
  - P2 #4 (security CI) — correct
  - P2 #5 (feature flag docs) — needs verify
- **Unique value:** Caught P0 #3 (logs), P1 #1 (auto-reactions), P1 #3 (SSRF), P1 #5 (PIL bomb) that nobody else caught.
- **Weakness:** No structured table; harder to triage at a glance.

### OpenCode (FreeRouter)
- **Format:** Loosest — bullet list across topics, no severity tags, no file:line citations.
- **Accuracy:** Low signal-to-noise
  - Architecture overview: correct but trivially restates docs
  - Security: vague ("token leakage if .env exposed" — true but unactionable)
  - Test gaps: vague ("ensure any added helper is covered" — without specifics)
  - Documentation gaps: cites missing CODEX_REPO_BRIEF.md docs for specific commands — could be useful if true; needs verify
  - Performance: VRAM concern is real but unspecific
  - Refactor tasks: 5 items, none with file:line, ranging from useful (feature-flag dispatch) to debatable (typed schema replacement)
  - Verification items: useful checklist (`npm run preflight`, `curl /health`, lock script env vars)
- **Unique value:** The verification checklist is concrete + reproducible. The rest needs human triage before becoming work items.

### Claude (prior, `AGENT_AUDIT_2026-05-27.md`)
- **Format:** Best by metric volume (491 lines, 13 sections, severity legend, evidence/verification/action/risk/effort per item)
- **Accuracy:** Mixed
  - Got AUD-005 (5 listeners) correctly DOCUMENTED-not-fixed
  - Got AUD-002 (clientReady) correctly false-positive
  - Got AUD-003 (intent routing) correctly already-fixed
  - **Under-rated CORS/auth chain as VERIFY-ONLY** — this was the worst miss. Antigravity + Codex caught what I rated as "maybe check later".
  - 10 new findings (A1-A10) some of which were real and actionable
- **Unique value:** The DO-NOT-RAISE list (§11) prevents future audits from re-opening user-position items.
- **Weakness:** Under-aggression on security severity. The lesson: when CORS=\* meets unauth endpoints, that's P0 not VERIFY.

---

## §5 Suggested execution order for the next agent

After this session, do this in order:

1. **Verify the CORS / token gate fixes hold in actual Tauri shell** — run `cargo tauri dev`, exercise chat / model picker / launcher. Confirm GUI still works through the tightened CORS allowlist. (15 min)
2. **OPEN-P1-D PIL decompression bomb** — 45 min, low risk, real exploit (image bombs are common in user uploads).
3. **OPEN-P1-C base64 request caps** — 30 min, trivial.
4. **OPEN-S2 /data/{file} traversal probes** — 15 min verification only.
5. **OPEN-S5 GitHub fetch size cap** — 10 min.
6. **OPEN-P1-A self-update signature** — 3-4 hours, requires user input on release pipeline.
7. **OPEN-P1-B SSRF defense** — 3-5 hours, careful work.
8. **OPEN-P2-E Tauri CSP** — 2-3 hours, needs visual verification.
9. **OPEN-P2-G security CI** — 2-3 hours.
10. **Doc + DEBT work** — as bandwidth allows.

---

## §6 What an agent should NOT do (carried from prior audit §11, validated this session)

- Don't propose credential rotation / secret masking. User handles `.env` + `keys.txt` themselves.
- Don't repo-split or framework-migrate.
- Don't re-open AUD-002 (`clientReady`) — it's the correct v14.18+ event name.
- Don't re-open AUD-003 (intent routing) — already guarded at `index.js:9712`.
- Don't refactor the 5 interactionCreate listeners into 1 dispatcher — they filter on disjoint customIds; refactor is high-risk for no observable bug.
- Don't write multi-paragraph comment blocks / docstrings — project convention is single-paragraph.
- Don't add features beyond the explicit ask.

---

## §7 Final state

- Local `main` HEAD = `bcfa46a` = `origin/main` HEAD
- Preflight `5/5 · 565 unit · 176 GUI` green
- E2E `18/18 pass` (against auth-hardened server)
- 10 active security probes pass
- Background AI server running for further interactive verification

Commits in this session (most recent first):

| SHA | Subject |
|---|---|
| `bcfa46a` | P0 security: close browser drive-by exfiltration + lock env injection |
| `b6bbc55` | docs: agentic audit report (2026-05-27) — task list for next agents |
| `5ac6ca7` | Untrack stale uploads + ignore audit scratch / runtime state |
| `baca14f` | GUI polish: branded contextmenu + atomic self-update + dialog sweep |
