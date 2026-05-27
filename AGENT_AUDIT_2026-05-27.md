# SeekDeep Repo Audit · Agent Task List · 2026-05-27

**Author:** Claude (Opus 4.7), session `c33cbb0b-fc38-4f56-a9f8-985386a2b92b`
**Repo SHA at audit time:** `5ac6ca7` (origin/main, in sync)
**Scope:** Whole repo — `index.js` (Discord bot, 22 464 LOC), `local_ai_server.py` (FastAPI, 4 860 LOC), `gui_endpoints.py` (3 854 LOC, 55 endpoints), `gui/*.html` (22 files), `src-tauri/src/*.rs` (1 702 LOC), CI, docs, requirements.
**Audience:** Subsequent agents. Each finding is a self-contained task. Pick by ID; check off when done.

---

## Reading instructions for agents

1. **Treat every claim here as a hypothesis you must re-verify.** I cited file:line for everything. Open the file, re-read the cited range, decide for yourself. The repo moves fast — by the time you read this, lines may have shifted.
2. **Two prior audits (Codex + antigravity) shipped findings that were already-fixed or simply wrong** — antigravity batting average was 2 false-critical-positives out of 3 critical-marked items. Distrust the description; trust the diff.
3. **Most "fixes" carry hidden cost.** A "high-risk refactor with no observable bug" is a regression generator. The bar for action is *observable bug* + *user-visible fix* — not "the code is ugly."
4. **The user runs solo.** Never propose work items that imply credential rotation, repo splits, framework migrations, or anything requiring a second contributor. Memory has standing instructions on this.
5. **If you complete an item, append a `**RESOLVED `<your-sha>` · `<short-rationale>`**` line under it.** Don't delete items — leave the trail.

---

## Severity legend

- **P0 (block ship)** — actively losing data, leaking secrets, or producing wrong answers to users.
- **P1 (fix before next release)** — degraded UX, observable but recoverable.
- **P2 (next sprint)** — papercuts, latency, log noise.
- **DEBT** — architectural smell with no current bug.
- **VERIFY-ONLY** — agent should re-verify and either move to P1/P2 or close.
- **DO-NOT-FIX** — flagged here so future agents don't re-open. Includes reasoning.

---

## §1 Antigravity audit re-verification (2026-05-26 report)

Each item from the antigravity report, re-verified against current `5ac6ca7` HEAD.

### AUD-001 · Active secrets in `.env` / `keys.txt`
**Severity:** DO-NOT-FIX
**Evidence:** `.env` line 5 (DISCORD_TOKEN), `keys.txt` (mirror of `.env`).
**Status:** User memory file `feedback_no_credential_rotation.md` explicitly directs agents *not* to mask, mention, or warn about these tokens. Both files are `.gitignore`-covered. User handles rotation on their own schedule.
**Action for agents:** Do not edit `.env` or `keys.txt`. Do not warn about secret exposure. Do not propose `.env.example` migrations of values. If you see this in a future audit, leave it closed.

### AUD-002 · `client.once('clientReady', …)` never fires
**Severity:** DO-NOT-FIX (false positive)
**Evidence:** `index.js:8982` uses `clientReady`; `node_modules/discord.js/typings/index.d.ts:6305` shows `ClientReady = 'clientReady'`; `discord.js/src/util/Events.js:111` exports `ClientReady: 'clientReady'`.
**Verification:** E2E run on 2026-05-27 launched the bot via `/launcher/bot/start`, observed `state: running`, then the log tail showed the bot's startup banner `"Ready. Use: /ask, /refine, /image, /vision, /status, /help, /regen, /recent, /changelog"` — which is the *content of the clientReady handler*. The handler fires. The audit was written against discord.js v13 conventions or an older codebase snapshot.
**Action for agents:** Do not migrate `clientReady` → `ready`. The v14.18+ event name is `clientReady`.

### AUD-003 · "show me how to bake a cake" → SDXL pipeline
**Severity:** DO-NOT-FIX (already fixed)
**Evidence:** `index.js:9712` short-circuits on `/\b(?:how\s+(?:to|do|does|can|should|would|might)|tips\s+(?:for|on)|ways?\s+to|explain|difference\s+between)\b/i` *before* the explicit-image-request return. Comment block at lines 9705-9711 literally describes the prior fix. Lines 9715-9718 add a wider exclusion list for "instructions", "tutorial", "guide", "walkthrough", "steps", "procedure", "step by step".
**Verification:** Read the actual regex; trace the boolean.
**Action for agents:** Do not re-add a how-to exclusion. If you observe a real misroute, capture the *exact* prompt and add a smoke test before touching the regex.

### AUD-004 · Programmatic `.env` mutation in `/token` generation
**Severity:** VERIFY-ONLY
**Evidence:** `gui_endpoints.py:295-327` referenced in antigravity report; not re-read in this audit.
**Why it might matter:** Token write-back to `.env` could be a footgun if multiple processes hold the file.
**Verification task:** Re-read the cited range. Confirm whether the write is atomic (tempfile + replace) and gated by a lock. If it's a one-shot append-if-missing, it's fine. If it's a rewrite of the whole file, it can race with the user editing `.env` manually.
**Action:** Convert to P1 if non-atomic; close as DO-NOT-FIX if atomic.

### AUD-005 · 5× `interactionCreate` listeners
**Severity:** DEBT (not a bug)
**Evidence:** `index.js:20805, 21972, 21999, 22426, 22451`. Read all 5 in this session.
**Skeptical check:** Each filters on a unique `customId` prefix and bails *before* any `deferReply`/`reply` if it doesn't match:
- `20805` — handles `seekdeep:fr:*` (force-react picker) + legacy `seekdeep:force-react:*` modals + the main router
- `21972` — only proceeds when `customId.startsWith('seekdeep:prompt:')`
- `21999` — only `SEEKDEEP_PROMPTS_IMPORT_BUTTON_PREFIX` / `SEEKDEEP_PROMPTS_COPY_BUTTON_PREFIX`
- `22426` — only `seekdeepEmergencyIsGeneratedImageActionCustomId(customId)`
- `22451` — only `seekdeep:archivedelete:*`
**Verification:** `grep -nE "customId\.startsWith" index.js` confirms each prefix is disjoint. No "interaction already acknowledged" log entries seen in E2E sweeps.
**Action for agents:** Do NOT consolidate without first reproducing an actual collision. Comment at `index.js:20800-20803` already documents the smell and gives guidance for future button families. If you do consolidate, the failure mode is hard-to-reproduce production-only Discord 40060 errors — the test that catches this would have to be a Discord integration test, which we don't have.

### AUD-006 · `docs/uploads/` and `gui/uploads/` tracked in git
**Severity:** **RESOLVED 2026-05-27 · commit `5ac6ca7`**
29 binaries untracked with `git rm --cached`; `.gitignore` updated. History not rewritten (separate concern).
**Follow-up task (P2):** If publishing publicly, run `git filter-repo --path docs/uploads --path gui/uploads --invert-paths` to scrub from history. Coordinate with user — destructive op rewrites SHAs.

### AUD-007 · Swallowed errors in vision attachment fetches
**Severity:** DO-NOT-FIX (false positive in cited form)
**Evidence:** Cited `index.js:1228` is a blank line inside a streamed-body reader (`readCappedBody`), no `catch` nearby. Repo-wide search shows 3 `catch (_) {}` patterns at `index.js:275, 11930, 11936` — all silent fallbacks on `message.channel.messages.fetch` / `message.fetchReference`, which throw on deleted messages. Pattern-correct. The other 169 empty `catch {}` (no binding) are intentional fire-and-forget.
**Action:** Do not add `console.debug` calls to these sites — would create log spam without diagnostic value. If a real diagnostic gap appears, instrument the *specific* path with `console.warn` + the operation context, not a blanket sweep.

---

## §2 Critical / actionable findings (new — not in antigravity)

### A1 · `index.js` is a 22 464-line monolith with 707 functions
**Severity:** DEBT
**Evidence:** `wc -l index.js` → 22 464. `grep -cE "^(async )?function" index.js` → 707.
**Skeptical check:** This is large enough that any non-trivial edit risks confusing the AST cache. Maintainability is degraded; merge conflicts are common; the file already has emergency-block markers (`SEEKDEEP_PROMPT_CHOICE_EMERGENCY_END` at 21995, `SEEKDEEP_IMAGE_ACTION_EMERGENCY_END` at 22449) implying past rescue surgeries.
**Why it matters:** Cold-load time on Node 20 for a 22k-LOC ES module is ~600ms. Edit confidence drops as line count grows.
**Verification:** Run `node --prof index.js --version-check`, time the import; eyeball top-level branches with `grep -nE "^(client|module\.exports|globalThis)" index.js`.
**Suggested action (DEBT — schedule a dedicated sprint):**
1. Identify natural seams: `archive*`, `prompts*`, `forceReact*`, `route*`, `intent*` regex helpers.
2. Extract each into `lib/<seam>.js`, re-export via named exports, leave `index.js` as the orchestrator.
3. Run `smoke_test.mjs` after each extraction. Each function moved should be verifiable by an existing assert.
**Risk:** **HIGH** — `smoke_test.mjs:14-25` exposes helpers via `SEEKDEEP_TEST_MODE` + `globalThis.__seekdeepTest`. Moving symbols out of `index.js` without re-binding to `globalThis.__seekdeepTest` will silently drop tests from coverage. Verify by checking smoke test count delta (currently 565); any drop is a regression.
**Effort:** 3-5 sessions.

### A2 · `gui_endpoints.py` houses 55 endpoints in 3 854 lines
**Severity:** DEBT
**Evidence:** `grep -c "@app\\.(get\\|post\\|patch\\|delete)" gui_endpoints.py` → 55.
**Why it matters:** Adding a new endpoint near a similarly-named one (e.g., `/memory/user/{user_id}/fact/{n}`) risks `replace_all=false` Edit collisions. Function discovery is slow.
**Suggested action (DEBT):** Group into sub-modules (`endpoints/memory.py`, `endpoints/reacts.py`, `endpoints/system.py`, etc.) registered against the shared FastAPI `app` via a `register(app)` function per module. Pattern matches what `gui_endpoints.register_gui_endpoints(app)` already does. **Don't change behavior — just rehome.**
**Risk:** Medium. Tests cover endpoint contracts but not import paths. Update `gui_endpoints.py:1` re-exports if any module imports specific functions.
**Effort:** 1-2 sessions.

### A3 · `requirements-ml.txt` uses unbounded upper bounds on heavy ML libs
**Severity:** P1
**Evidence:** `requirements-ml.txt` lines 7-10 — `accelerate>=1.2.0`, `bitsandbytes>=0.45.0`, `transformers>=4.51.0`, `diffusers>=0.33.0` all `>=` only. No `<` cap.
**Why it matters:** Transformers and diffusers both ship breaking changes in minor versions (e.g., HF removed `from_single_file` signature in diffusers 0.30→0.31). User reports that "things just stop working after a fresh install a few weeks later" are usually upstream breakage absorbed silently. The unbundled torch+CUDA pin (`torch==2.5.1+cu128`) is already proof you know the risk; the rest of the file doesn't follow the pattern.
**Verification:**
```bash
pip index versions transformers | head -5
pip index versions diffusers | head -5
```
Capture installed versions on a known-good machine (run `pip freeze | grep -E "^(transformers|diffusers|accelerate|bitsandbytes)="` and write to a `requirements-ml.lock`).
**Action:**
1. Generate a `requirements-ml.lock` from the user's working venv.
2. Either ship the lock as the install target, or add upper bounds: `transformers>=4.51.0,<5.0`, `diffusers>=0.33.0,<0.40`, etc.
3. Add a smoke test that asserts the installed version range matches the manifest (e.g., `assert transformers.__version__.startswith('4.')`).
**Risk:** Low. Locking only constrains future installs; existing installs unaffected.
**Effort:** 30 min.

### A4 · CORS is wide-open (`allow_origins=["*"]`) on the AI server
**Severity:** VERIFY-ONLY
**Evidence:** `local_ai_server.py:562-567` — `CORSMiddleware` with `allow_origins=["*"]`, `allow_credentials=False`, `allow_methods=["*"]`.
**Skeptical check:** Comment at `local_ai_server.py:556-561` says it's safe because (1) server binds 127.0.0.1 only, (2) every write requires `X-SeekDeep-Token`, (3) `GET /token` is loopback-only. Verify each:
- **Loopback bind:** `grep -n "host=" local_ai_server.py` → should show `host="127.0.0.1"`. **VERIFY THIS.** If `0.0.0.0` slips in, CORS=`*` becomes a real hole.
- **Token gate on every write:** `grep -c "Depends(_require_gui_token)\|Depends(require_gui_token)" gui_endpoints.py local_ai_server.py` → should equal count of write endpoints (`@app.post + @app.patch + @app.delete`). Audit any gaps.
- **`/token` loopback-only:** `grep -B2 -A10 'def get_token' gui_endpoints.py` — check the `request.client.host` allowlist.
**Action:** Run the three verifications above. If all green, close as DO-NOT-FIX. If any gap, P0.

### A5 · Self-update staging dir creates `.self-update-staging-<pid>` directly in repo root
**Severity:** P2
**Evidence:** `gui_endpoints.py:1764-1768` (post-refactor in commit `baca14f`).
**Skeptical check:** What if two `/system/self-update` calls fire simultaneously? They'd each use a different PID, so dirs don't collide — BUT both could be mid-Phase-1 when Phase-2's `src.replace(target)` from one fights the other's still-in-flight download. End state could be a mix of two refs.
**Verification:** Two concurrent `curl -X POST .../system/self-update -d '{"ref":"main"}'` calls back-to-back; inspect resulting sentinel + check files match same ref.
**Action:**
1. Add an in-process lock (`threading.Lock()` at module scope) around `post_self_update` so only one runs at a time. Return 409 Conflict if a second arrives.
2. Document the lock in the endpoint docstring.
**Risk:** Low — adds 4 lines.
**Effort:** 20 min.

### A6 · Self-update sentinel uses paths but sidecar.rs may not consume it
**Severity:** VERIFY-ONLY
**Evidence:** `gui_endpoints.py:1849-1856` writes `.self-updated` listing committed paths. Comment at line 1846 says "sidecar.rs reads this on next Tauri boot and skips re-extracting files we just patched."
**Skeptical check:** Is the consumer actually wired?
**Verification:**
```bash
grep -n "self-updated\|self_updated" src-tauri/src/*.rs
```
If grep returns nothing, the sentinel is write-only — sidecar will clobber the self-update on next launch (regression of completed task #93).
**Action:** If wiring missing, P1. Implement the read in `sidecar.rs` before extracting any bundled resource — if path is in sentinel, skip extraction.
**Effort:** ~1 hour Rust.

### A7 · Self-update `Accept: application/vnd.github.raw` may rate-limit
**Severity:** P2
**Evidence:** `gui_endpoints.py:1781-1784` — fetches GitHub raw via `urllib.request` with no auth header.
**Skeptical check:** GitHub unauthenticated rate limit is 60 req/hour per IP. Self-update downloads `len(single_files) + len(gui_dir) + len(scripts_dir)` files — last count was ~25 files. Three updates/hour hits the cap; the 4th will 403.
**Verification:** Run self-update 4 times in an hour, inspect `errors` array.
**Action:**
1. If `HF_TOKEN` or `GITHUB_TOKEN` is set in env, add `Authorization: token <T>` header. 5000 req/hour authenticated.
2. Surface 403 with explicit "GitHub API rate limit — wait 1 hour or set GITHUB_TOKEN" message in the response.
**Risk:** Low.
**Effort:** 20 min.

### A8 · Worktree-vs-main-repo index drift bit me twice today
**Severity:** VERIFY-ONLY (workflow doc)
**Evidence:** This session's git operations bounced between worktree CWD and main repo. `git rm --cached` from worktree CWD modified the worktree's index, leaving the main repo's index untouched — first push missed the deletions.
**Why it matters:** A future agent in a worktree will hit the same trap.
**Action:** Add a note to `MAINTAINER.md` (or wherever workflow doc lives) — when working from a `.claude/worktrees/*` worktree, prefer `cd` to repo root before git ops, OR use `--git-dir` / `--work-tree` flags explicitly.
**Effort:** 5 min.

### A9 · `data/auto-reactions.json` was un-ignored at git status time
**Severity:** **RESOLVED 2026-05-27 · commit `5ac6ca7`**
Added to `.gitignore` alongside other `data/*.json`. Next agent: if you see new `data/*.json` files in `git status`, check whether they're runtime state and add to the same block.

### A10 · `patches/backups/` directory exists in repo
**Severity:** VERIFY-ONLY
**Evidence:** `ls patches/` → `backups`.
**Skeptical check:** Antigravity report mentioned `patches/patch_anti_loop_v10.3.py`; is `backups/` the remainder of that, or live tooling?
**Action:**
```bash
git log --all -- patches/ | head -20
ls -la patches/backups/
```
If contents are stale (last modified > 60 days, no recent commits touching them), `git rm -r patches/` and document removal in commit message. Else document purpose in `patches/README.md`.
**Effort:** 15 min.

---

## §3 Test coverage gaps

### T1 · No integration test for `/system/self-update` end-to-end
**Severity:** P1
**Evidence:** `smoke_test.mjs` is mock-only (Discord interactions, no HTTP). `scripts/smoke_gui_endpoints.py` per its name covers endpoint contracts but I haven't read it to confirm — VERIFY.
**Why it matters:** The two-phase staging atomicity I just shipped (`baca14f`) is unverified end-to-end. A network-failure simulation isn't covered.
**Action:**
1. Read `scripts/smoke_gui_endpoints.py` to confirm what's tested.
2. If self-update isn't covered, add a test that:
   - Mocks GitHub responses (use a tiny local HTTP server returning known content)
   - Asserts staging dir creation, Phase-1 success, Phase-2 commit, sentinel content
   - Asserts staging dir is wiped after success
   - Asserts staging dir is wiped after Phase-1-empty failure
   - Asserts live tree is untouched when Phase 1 returns zero files
**Effort:** 2-3 hours.

### T2 · `scripts/verify_e2e.py` not invoked by CI
**Severity:** P1
**Evidence:** `.github/workflows/ci.yml` — VERIFY content.
**Why it matters:** Locally green doesn't mean green for the next user. The 18/18 E2E I just ran is not gated by CI.
**Action:**
1. Add a CI job that boots `local_ai_server.py` against a stub env (no real Discord/HF tokens), waits for /health, runs `verify_e2e.py`, fails on non-zero exit.
2. Use `services:` block with `python:3.14` and a 7865-bound port mapping.
3. Skip the `/chat` and `/launcher/bot/start` steps in CI (they require GPU + Discord token); add a `--ci` flag to `verify_e2e.py` that drops those.
**Effort:** 1-2 hours.

### T3 · Smoke tests don't assert Tauri Rust compiles
**Severity:** P1
**Evidence:** `preflight.mjs` runs js + html-js + py + smoke + gui-smoke. No `cargo check`.
**Action:** Add a `cargo check --manifest-path src-tauri/Cargo.toml` step to `preflight.mjs` AND CI. Should run conditionally (skip if `cargo` not installed; warn don't fail). Fails fast on Rust syntax errors before user tries `tauri build`.
**Effort:** 30 min.

### T4 · No test asserts `/chat 503` contract has `detail` field (fix #87)
**Severity:** P2
**Evidence:** `scripts/verify_e2e.py:120-127` checks if `/chat` returns 503 and has `detail` field, BUT the script's `chat_resp` check only fires when `/chat` returns 503. Today's run returned 200 so the contract was never asserted.
**Action:** Add a smoke test path that *forces* 503 (e.g., unload the model first, then immediately call `/chat`) and asserts `detail` field presence.
**Effort:** 45 min.

### T5 · `smoke_gui_endpoints.py` reach is not surveyed
**Severity:** VERIFY-ONLY
**Evidence:** `grep -cE "method == |path == |/[a-z]" scripts/smoke_gui_endpoints.py` → 259 references but I haven't validated they map 1:1 to the 78 endpoints.
**Verification task:** Cross-reference. For each `@app.(get|post|...)` in `local_ai_server.py` + `gui_endpoints.py`, confirm a corresponding test path in `smoke_gui_endpoints.py`. List uncovered endpoints. Convert to T6 if gap > 10%.
**Effort:** 1 hour.

---

## §4 Frontend ↔ Backend contract drift

### F1 · 22 HTML files, no endpoint-to-page coverage map
**Severity:** VERIFY-ONLY
**Evidence:** `ls gui/*.html | wc -l` → 22. 78 endpoints. Mapping exists only in the developer's head.
**Action:** Generate a coverage map. For each endpoint, list which HTML files / JS modules `fetch()` it. Conversely, for each HTML, list which endpoints it touches. Output as `docs/endpoint-coverage.md`.
**Why it matters:** When endpoint X gets renamed, you should know which UIs to update. Today this is grep-and-pray.
**Tool:**
```bash
for ep in $(grep -hoE '"/[a-z][^"]*"' gui_endpoints.py local_ai_server.py | sort -u); do
  hits=$(grep -lE "fetch\(.*${ep}|${ep}'\\)|${ep}\")" gui/*.html gui/*.js 2>/dev/null | tr '\n' ' ')
  echo "$ep → $hits"
done
```
**Effort:** 2 hours.

### F2 · `app.html` ships static model IDs that diverge from real cache
**Severity:** **RESOLVED in `5e57c09`** (commit message references "Model Manager Remove can detach the wrong live role (#1)"). Re-verify next time you touch the Model Manager.

### F3 · 29 inline JS blocks across 22 HTML files
**Severity:** DEBT
**Evidence:** `preflight.mjs` reports `html-js  ...  29 inline blocks across 22 html files`.
**Why it matters:** Inline blocks bypass module loading, have no source maps, and duplicate logic that could be shared via `gui/*.js`. CSP (if ever added) breaks them.
**Action:** Inventory each inline block. Convert any > 50 lines to external `gui/<page>.js`. Smaller ones acceptable as page-specific glue.
**Effort:** 2-4 hours depending on inventory.

### F4 · Notify.js toast API not consumer-documented
**Severity:** P2
**Evidence:** `gui/notify.js:503` defines `toast(opts)` accepting `{ tone, title, body, ttl, icon }`. I learned this by reading the impl, not docs. Today's batch added 12 toast call sites; the next contributor will guess.
**Action:** Add a top-of-file JSDoc block documenting the public API: `toast`, `confirm`, `modal`, `banner` signatures and tone enum.
**Effort:** 20 min.

---

## §5 Security surface

### S1 · `SEEKDEEP_GUI_TOKEN` provenance and rotation
**Severity:** VERIFY-ONLY
**Evidence:** Referenced in `verify_e2e.py:18-24`, used by `/require_gui_token` decorator in both Python files.
**Verification tasks:**
1. **Generation:** Where is the token first created? Search: `grep -n "SEEKDEEP_GUI_TOKEN" gui_endpoints.py local_ai_server.py`. Is it auto-generated on first boot, read from env, or shipped in `.env.default`?
2. **Strength:** If auto-generated, what entropy? `secrets.token_urlsafe(32)` minimum.
3. **Storage:** Stored in `.env`? In memory only? Persistent across restarts?
4. **Rotation:** Does any code path delete + regenerate it? What happens to in-flight GUI sessions if rotated mid-flight?
5. **Logging:** Is it ever logged? `grep -n "TOKEN" logs/` — if present in logs, P0.
**Action:** Write findings as `docs/SECURITY_NOTES_TOKEN.md`. Don't change behavior in this task.
**Effort:** 1 hour.

### S2 · Path traversal in `/data/{file}` endpoint
**Severity:** VERIFY-ONLY
**Evidence:** `gui_endpoints.py:2593` (per worktree-mangled grep output earlier) defines `@app.get("/data/{file}")`. Verify the impl validates `file` against a basename allowlist and doesn't accept `..` segments.
**Verification:**
```bash
curl -s "http://127.0.0.1:7865/data/..%2F..%2Fetc%2Fpasswd"
curl -s "http://127.0.0.1:7865/data/../local_ai_server.py"
```
If either returns content other than the documented data file shape, P0.
**Action:** Add tests for the traversal cases in `smoke_gui_endpoints.py`. Harden the impl if gap found.
**Effort:** 45 min.

### S3 · Self-update `ref` validation accepts any 7+ char hex string
**Severity:** P2
**Evidence:** `gui_endpoints.py:1751` — `len(ref) >= 7 and all(c in "0123456789abcdef" for c in ref)`. A user-supplied 7-char hex like `abc1234` matches the regex but isn't a real commit SHA; GitHub returns 404 and we ignore. No security risk, just user-confusing.
**Action:** Reject refs that don't look like SHAs (len 7-40) or tags (start with `v`). Currently a 30-char hex passes. Bound:
```python
if len(ref) >= 7 and len(ref) <= 40 and all(c in "0123456789abcdef" for c in ref):
```
**Risk:** Trivial.
**Effort:** 5 min.

### S4 · No request size limit on `/chat` body
**Severity:** VERIFY-ONLY
**Evidence:** `local_ai_server.py:3712` (`/chat` route).
**Skeptical check:** A malicious local script could POST a 10 MB prompt and tie up the tokenizer. Loopback-only mitigates, but a user-installed browser extension could abuse.
**Verification:** Check pydantic model definition for `/chat`. Confirm `prompt: str = Field(max_length=...)` or similar.
**Action:** If unbounded, add `max_length=8000` or similar — matches typical context window.
**Effort:** 15 min.

### S5 · GitHub raw fetches in self-update have no content length cap
**Severity:** P2
**Evidence:** `gui_endpoints.py` `_fetch` helper reads `r.read()` with no max size.
**Skeptical check:** A compromised GitHub mirror or MITM could serve a 10GB response, OOMing the server.
**Action:** Cap each download at 10MB (the largest legitimate file is `index.js` at ~870KB; 10MB is 10x headroom). Pattern:
```python
content = r.read(10 * 1024 * 1024)
if len(content) >= 10 * 1024 * 1024:
    raise ValueError(f"{url}: response exceeded 10MB cap")
```
**Effort:** 10 min.

---

## §6 Concurrency / race conditions

### C1 · Model loading singleton race
**Severity:** VERIFY-ONLY
**Evidence:** `local_ai_server.py` somewhere maintains a single loaded model (per `/health` response showing `loaded_task`, `loaded_chat_role`, `loaded_chat_model_id`).
**Skeptical check:** Two simultaneous `/chat` requests with different roles → both call `_ensure_model_loaded(role)` → both might race to swap the GPU resident model → one returns mid-swap, returns weights from the wrong model.
**Verification:** Find `_ensure_model_loaded` (or equivalent). Check for `threading.Lock` around the load+swap critical section.
**Action:** If unguarded, add an `asyncio.Lock` (FastAPI is async). Document the lock contract.
**Effort:** 1 hour.

### C2 · `data/*.json` writes are not file-locked
**Severity:** VERIFY-ONLY
**Evidence:** Multiple endpoints write `data/user-facts.json`, `data/auto-reactions.json`, etc. Two simultaneous writers can corrupt JSON.
**Verification:** `grep -nE "json\\.dump\\(|write_text\\(" gui_endpoints.py` — confirm uses pattern `tmp.write + tmp.replace(target)` (atomic) vs raw `open().write()` (not atomic).
**Action:** If non-atomic writes found, convert to tempfile+replace pattern. Optionally add `fcntl.flock` on POSIX (Windows uses `msvcrt.locking`).
**Effort:** 1-2 hours.

### C3 · Restart-window flag (`window.__seekdeepRestartingUntil`) is per-tab
**Severity:** P2
**Evidence:** Per the session summary, this is a global-but-per-tab flag suppressing errors during AI server restart.
**Skeptical check:** Multiple GUI tabs open: tab A triggers restart, sets its own flag. Tab B doesn't know — sees errors, shows red banners. Confusing.
**Verification:** Open two GUI tabs simultaneously, restart AI server from tab A, observe tab B.
**Action:** Use `BroadcastChannel("seekdeep-app")` to broadcast restart-window start/end across tabs. Pattern already used elsewhere in nav.js per session summary.
**Effort:** 30 min.

---

## §7 Documentation drift

### D1 · `MAINTAINER.md`, `AGENTS.md`, `INTEGRATION.md`, `CODEX_REPO_BRIEF.md`, `CONTRIBUTING.md` all exist; coverage unknown
**Severity:** VERIFY-ONLY
**Evidence:** Files present in repo root.
**Why it matters:** When 5 docs exist, the actual operational doc is the one most-recently-touched. Stale docs confuse new agents.
**Action:** For each, run `git log -1 --format="%ai %s" -- <file>` and note last modification. Pick the canonical doc (per project memory: MAINTAINER.md is referenced). Demote the others to "historical" or merge.
**Effort:** 2 hours.

### D2 · `docs/slash-parity.md` exists but parity not auto-checked
**Severity:** VERIFY-ONLY
**Evidence:** `ls docs/` → includes `slash-parity.md`.
**Action:** Read the file. If it lists Discord slash commands vs Web GUI controls, add a smoke test that asserts every documented slash command has both a bot handler and a playground equivalent.
**Effort:** 1-2 hours depending on doc size.

### D3 · `INTEGRATION.md` last refreshed during task #38 (completed)
**Severity:** VERIFY-ONLY
**Evidence:** Task list line 38 "INTEGRATION.md sweep" marked completed; ~50 tasks have happened since.
**Action:** Re-sweep. For each new endpoint added in tasks #38→#118, confirm it's documented or noted as internal.
**Effort:** 1 hour.

---

## §8 Performance & observability

### P1 · `/system/firstrun` is 2.4s blocking
**Severity:** P2
**Evidence:** `verify_e2e.py` output showed `GET /system/firstrun → status=200, 2376ms`.
**Why it matters:** Runs synchronously during GUI boot. User stares at loading page longer than necessary.
**Action:** Audit the checks. Parallelize independent ones (env_file + discord_token + python check + cuda check + HF cache check + Ollama check). Most are I/O-bound.
**Effort:** 1-2 hours.

### P2 · `verify_e2e.py` /chat cold-load is 13s, warm is 3s
**Severity:** P2 (cosmetic)
**Evidence:** Today's two E2E runs: first /chat 13235ms, second 3111ms. Difference is model weight load.
**Why it matters:** First-message latency for users. Could pre-warm during /health.
**Action:** Add an opt-in `pre_warm_default_chat` setting; if true, kick off `_ensure_model_loaded(default_chat)` in a background thread during FastAPI startup.
**Risk:** Eats VRAM on boot even if user never chats. Make opt-in.
**Effort:** 45 min.

### P3 · No structured logs (everything is `[INFO] message`)
**Severity:** DEBT
**Evidence:** `/logs/tail` output shows `[2026-05-27T03:55:03] [INFO] message` — plain text. No JSON shape.
**Why it matters:** Future tooling (Grafana, Loki, etc.) needs structured logs. Easier to debug a user's bug report if they can dump a JSON log line.
**Action:** Optional `LOG_FORMAT=json` env. When set, emit `{"ts":"...","level":"INFO","msg":"...","extra":{...}}` per line.
**Effort:** 2-3 hours.

---

## §9 Dead code / cleanup candidates

### K1 · Legacy `seekdeep:force-react:*` modal handler (lines 20826-20840)
**Severity:** P2
**Evidence:** `index.js:20826-20840` comment says "kept for any in-flight `seekdeep:force-react:*` modals dispatched before v10.4.1's picker rewrite landed."
**Skeptical check:** v10.4.1 shipped how long ago? If > 30 days, no in-flight modals could survive (Discord modals expire on user navigation).
**Verification:** `git log --grep="force-react" --oneline -10` to find when v10.4.1 shipped.
**Action:** If > 30 days, remove the block. Less code, less surface.
**Effort:** 15 min.

### K2 · `gui/uploads/` and `docs/uploads/` directories still exist on disk (just untracked)
**Severity:** VERIFY-ONLY
**Action for future agents:** If user confirms no longer needed, `rm -rf docs/uploads gui/uploads` to free ~10MB local. Don't commit this — `.gitignore` already prevents re-tracking.
**Effort:** 1 min (after user confirms).

### K3 · Multiple `_EmptyScanInfo` / `_StubRepo` / `_manual_hf_cache_scan` fallbacks
**Severity:** VERIFY-ONLY
**Evidence:** Session summary references these as part of WinError 448 workaround in `_safe_scan_hf_cache()`.
**Action:** Confirm only ONE codepath uses these stubs (the HF cache scanner). If any other code reads them, document.
**Effort:** 20 min.

---

## §10 Build / release / installer

### B1 · Tauri sidecar uses `_up_/` resource extraction (pre-Tauri-2.5 pattern)
**Severity:** VERIFY-ONLY
**Evidence:** Task #71 "Fix Tauri 2 _up_/ resource extraction" marked completed. Worth re-checking after Tauri minor bumps.
**Action:** `grep -rn "_up_" src-tauri/src/` — if pattern persists in current Tauri version, may need migration. Check Tauri 2.x release notes.
**Effort:** 30 min audit; fix only if pattern is now wrong.

### B2 · MSI / NSIS / DMG / AppImage builds — only WiX path verified by user
**Severity:** VERIFY-ONLY
**Evidence:** Task #47 verified macOS DMG rerun; tasks 102-104 cover WiX. Linux AppImage / deb / rpm appear in CI but no live verification.
**Action:** Download a fresh nightly from GitHub releases of each format on a clean VM. Install, launch, run E2E. Catch packaging regressions before users do.
**Effort:** 4-8 hours including VM setup.

### B3 · `ci.yml` content not surveyed in this audit
**Severity:** VERIFY-ONLY
**Action:** Read `.github/workflows/ci.yml`. Document what it runs vs `tauri-release.yml`. Identify whether `preflight.mjs` and `smoke_test.mjs` both run, and whether the matrix covers Windows + macOS + Linux.
**Effort:** 30 min.

---

## §11 Items the user has standing instructions on (DO-NOT-RAISE)

Future agents: do **not** open audit findings for any of these. The user has explicit standing positions.

- **Credential rotation / secret masking.** User handles `.env` and `keys.txt` rotation themselves. Don't propose, warn, or mask.
- **Repo splits.** Solo dev, no second contributor — repo splits / monorepo migrations / package extractions are out of scope.
- **`AUDIT*.md` / `REPO_AUDIT*.md` scratch files.** Gitignored intentionally. Don't propose tracking.
- **License changes.** GPL-2.0 is final (task #36).
- **Tauri tray menu items.** Already expanded (task #103).
- **Multi-paragraph comment blocks / docstrings.** Project convention is single-paragraph; respect it.
- **Adding new features beyond explicit ask.** Project memory says "don't add features, refactor, or introduce abstractions beyond what the task requires."

---

## §12 Suggested execution order for the next agent

If you take this whole list, work in this order to minimize blast radius:

1. **§5 security verifications first** (S1, S2, S3, S4, S5). Anything turning up P0 needs immediate fix.
2. **§3 test gaps** (T1, T2, T3). Once tests exist, refactors are safer.
3. **§2 P1 items** (A3 ml deps lock, A6 sentinel consumer wiring).
4. **§6 concurrency verifications** (C1 model loading, C2 file locks).
5. **§4 contract drift** (F1 coverage map — informs everything else).
6. **§7 documentation** (D1 canonical doc selection).
7. **§9 dead code** — easy wins after the rest.
8. **§2 DEBT items** (A1 monolith split, A2 endpoint module split) — only after T1-T3 land. These are multi-session efforts.

---

## §13 What I shipped in this session (for the next agent to verify)

- **`baca14f`** — GUI polish: branded contextmenu (`gui/nav.js`), atomic self-update (`gui_endpoints.py` two-phase staging), dialog sweep (chat.html, installer.html, memory.html, image-ab.html), prompts marketplace wiring (`gui/prompts.html`).
- **`5ac6ca7`** — Untrack 29 upload binaries, expand `.gitignore` for AUDIT scratch + runtime state, document AUD-005 + AUD-007 as DO-NOT-FIX.

Each commit has a multi-paragraph body explaining what changed and why. Re-verify by reading the actual diff (`git show baca14f`, `git show 5ac6ca7`), not just the commit message.

Specific things to spot-check:
1. **Contextmenu** (`gui/nav.js:1305+`) — does the menu render correctly in Tauri? Tested via E2E endpoint sweep, not browser pixels. **Visual verification still owed.**
2. **Self-update atomicity** — never actually fired against a real network (verified parse + boot + endpoint shape only). The race condition test (A5) and rate-limit test (A7) are unwritten.
3. **Toast migrations** — never observed the toasts pop in a live GUI session. Tone choices (warn/bad/info) are inferred from the prior alert messages, not user-validated.

If you find any of these regressed, my commits are the suspect.
