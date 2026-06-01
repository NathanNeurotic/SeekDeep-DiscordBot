# Planned Work & Deferred Improvements

This file tracks everything that's been discussed, scoped, or partially scaffolded but not yet shipped. Items here are not commitments — they're a parking lot for "next time we sit down with this codebase, here's what's on deck."

Last full audit: 2026-05-24 (GUI + backend stack)

---

## ✅ DONE — unified the two config renderers (completed 2026-06-01)

**Decision (Nathan):** Control Center is the canonical config home; All Settings is its full-key subpage. Build shipped first; this consolidation is the next dedicated pass with fresh context + a real verification plan.

**STATUS: complete.** Every schema-backed SELECT + TOGGLE in the Control Center now renders through the shared `config-render.js`, so it can't drift from All Settings; curated controls intentionally preserved. See the step list below for the commit trail.

**The problem.** Two config UIs render the same keys from two different code paths:
- `gui/app.html` "Bot config" pane — **hand-coded** config rows (offline panel, toggles, text inputs) + rich tools (live model picker, token fields w/ validators, feature cards). Its own save/dirty/validation/hydration (`window.markDirty`, `CFG_VALIDATORS`, `#cfg-save`, restart prompts).
- `gui/settings.html` "All Settings" — **schema-driven** render from `GET /config/schema` (all 143 keys), its own save + `↻ Restart bot` + search + `#KEY` deep-link.

Both POST the same `/config`, so values can't *conflict* — but the hand-coded rows can **drift** from the schema (e.g. a new enum value won't appear in app.html's static `<select>`). That's the remaining duplication.

**Target architecture.** One shared `gui/config-render.js` (extract from settings.html: `buildRow`, `boolVocab`, `isOn`, kind handling, hydrate, dirty). Both pages consume it — Control Center renders a *curated slice*, All Settings renders *all*. Each key is defined once; neither can drift. Keep the Control Center's genuinely-rich sections (model picker, token entry, feature management) as special sections above the shared rows. Retire the plain hand-coded duplicate panels (e.g. the 3-key offline panel).

**The catch / why it's its own pass.** Must reconcile **two mature save/validation/hydration systems** + the live model-picker, and the GUI is token-gated (no full auto-verify). Plan, step-by-step (commit per step):
- ✅ **(1) DONE (eb0cec3)** — extracted `gui/config-render.js` (makeControl + isOn + boolVocab); settings.html adopts it, behavior-preserving. Verified 18/18 Node DOM-stub + preflight; e2e added (control-center.spec, "shared config-render module").
- ✅ **(2) DONE (fa414ab save, 8c8498f hydrate)** — app.html's save reads each row via `_sdRead` and hydrate fills via `_sdHydrate`, both vocab-aware, so a converted row round-trips through app.html's own `#cfg-save`/`markDirty` without the old fixed-on/off serializer.
- ✅ **(3) DONE (29b80f7 selects, abd172b toggles)** — `reconcileConfigControlsFromSchema()` routes Control Center SELECT + TOGGLE rows through `makeControl` on pane-load. Selects get schema options (CHAT_PROVIDER → `ollama`, which the hand-coded list lacked); toggles get the schema's boolean vocabulary + a value label (MODEL_AUTO_FALLBACK → `true/false`, not `on/off`). **Strict kind-match preserves curated controls:** the offline flags are schema kind 'toggle' but a labeled `<select>` (no `.toggle`) → skipped; inputs keep their hand-written placeholders (`(empty · comma-separated)`); secrets untouched.
- ✅ **(4) DONE** — verified against the **repo** gui/ via a throwaway static+stub server serving the real `/config/schema` (the running server serves the *installed* build, not repo edits, so e2e on :7865 can't see them). The committed `control-center.spec` 2c/2d tests **skip** on a pre-merge served build and **run** on a repo/CI build. Shipped in **10.35.44** (selects + 2a/2b); **toggles (2d) pending the next build**.

App.html still keeps its genuinely-rich sections (live model picker, token fields w/ validators, feature cards) bespoke — those aren't plain schema rows. The "retire duplicate panels" idea is moot: the reconcile makes the inline rows authoritative-from-schema, so there's nothing to drift.

**Done already (this session, shipped in 10.35.42):** All Settings covers all 143 keys (merged `.env.example`, bundled), every key documented, in-place ↻ Restart, deep-links, Control Center→All-Settings subpage framing, offline-flag labels/toggles, EMIT_LOG_LINES surfaced + pill deep-link, GIF→🖼️ fix, and the deferred slash parity (`/archive clean`, `/reactrule|/emoji import`).

---

## QA Feedback — GLP-2 Roooo session (2026-05-31)

Live QA + ideation session with collaborator **GLP-2 Roooo** (credit their GitHub for the QA role). The raw chat was dictation-heavy; distilled below. Nothing here is a commitment — parking lot.

**Validated (working well — recorded, no action):** auto-react fires cleanly on **links + forwarded** messages with good built-in emoji choices; the reaction-toggle menu "beats the tester's own bot"; GUI praised overall.

### Concrete / near-term

- ✅ **Reaction-toggle menu — loading GIF restart FIXED (78c03e5).** Not a timer as the report assumed — it was per button-click: the embed set its thumbnail to `attachment://loading.gif`, and every `interaction.update` re-sent that embed, so the client re-rendered the thumbnail and the GIF restarted. Fix (Option B): the buttons already convey state (green = on, gray = off) and the dropdown shows each emoji, so the embed's per-key on/off + emoji text was redundant — made the embed STATIC and both update sites (toggle/all + emoji modal) call `interaction.update({ components })` only, never re-sending the embed, so its GIF is untouched and never restarts. Verified: smoke +3 (565→568) — embed JSON identical across an on/off flip; button components DO change with state. Visual smoothness is mechanism-guaranteed; GLP to confirm live in Discord post-build.
- ✅ **Add `seek deep` + `sick deep` address prefixes — DONE.** Centralized address detection (`SEEKDEEP_NAME_SPOKEN` start-only prefixes for voice/dictation users) recognizes the spaced "seek deep" and phonetic "sick deep" alongside the solid forms.
- **GUI is "nice but over-complex" for new users.** Continue the simplification arc (reactrule-form examples panel + the All Settings page were steps). Audit for over-complexity; add progressive disclosure / inline guidance. Pairs with the new-user friction already seen on the reactrule form.

### Asset hosting — move off GitHub onto the SeekDeep domain (Cloudflare)

- **Host web + bot art assets on the domain, not GitHub.** Put emoji/expression art, animation frames, and site images in a domain `/resources` folder via Cloudflare Pages/Workers (`*.pages.dev` / a SeekDeep domain). Rationale (GLP): GitHub is public + messy, and a *private* repo needs an API key just to fetch an image; a domain folder is clean, stable, "legit attached to SeekDeep as a company," and trivial to manage (drop files in a deploy; remove by excluding + pruning old deployments).
  - **Scope clarified with Nathan:** GitHub stays the **installer/source distribution** only; the AI API is **localized** (no change there). This is about the **website + Discord-side visual assets** so the chatbot UI "has all its resources right there and doesn't fetch anything." Prefer bundling assets **locally in the app** where possible (no runtime internet dependency); use the domain for the marketing site + any Discord emoji/GIF hosting.
  - Sub-idea: upload custom emojis directly to the **bot's Discord application** (application emojis) rather than GitHub.

### Creative / branding — medium-term

- **Animated SeekDeep mascot that emotes.** SeekDeep already has many animation frames. (1) **Website:** a chat avatar whose **expression changes as it types / responds**, keyed to the sentiment/content of the output (cycles emotions while generating). (2) Landing: "three rotating SeekDeeps." (3) **Discord:** during long generations (image gen ~40s), cycle the "preparing/generating" art through expressions instead of one static GIF.
- **Named expression library → auto-suggest personas / reaction-rules / bios.** Isolate + name every expression emoji, then feed the named set to a suggester so the bot proposes personas / reaction rules / bios to pick from (mirrors GLP's naming experience: name them, then the bot generates options to choose).

### Aspirational — north-star, not near-term

- **Own / fine-tuned model + paid tier + Neurotic branding.** Eventually train/own a model (heavy infra: multi-TB storage, worker nodes off domain storage) and monetize; brand it **Neuralotics / Neural-cotics**. Reality check (Nathan): today it's a high-quality **wrapper** over existing models; real training is weeks+ of intense work. The internet-access design means the wrapper "never goes stale," so this stays a north-star.

### Marketing / community

- **Credit GLP-2 Roooo's GitHub** (QA role) in the project. Address the discoverability gap ("really nice features, zero marketing") — "premium recommendation" positioning.

---

## GUI / Backend Stack — Post-`5cd770b` Queue (2026-05-24)

The "GUI shipped + backend wired" arc landed across ~40 commits ending at `5cd770b`. Token auth, WebSocket bridge, 7 live event topics, CI, version SoT, VRAM hardening, **all 5 chat backends (hf / ollama / openai-compat / anthropic / gemini)**, `POST /model/install`, telemetry disclaimer, etc. — all live.

What's left, split by who owns it.

### Claude Code queue (backend / repo work)

Sorted by readiness to start.

#### Audit fixes shipped 2026-05-25

Both external audits (ChatGPT PR [#3](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/pull/3) and Jules PR [#2](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/pull/2)) reviewed; good findings cherry-picked:

- ✅ **CI gui-smoke green again** (`eb14758`). The `gui-smoke` stage was failing on `No module named 'dotenv'` because CI only installs the lightweight `fastapi/httpx/pydantic` subset. Guarded the import in `local_ai_server.py` and `warmup_local_cache.py` with a try/except fallback, AND added `python-dotenv>=1.0.0` to the CI workflow so we still exercise the real launcher path.
- ✅ **`scripts/doctor.mjs` overhaul** (`8c13e82`). `DISCORD_CLIENT_ID` is now WARN (not FAIL); it's only needed for slash-command registration diagnostics, not basic replies. `.env.default` is now detected as the first-run template (was checking only `.env.example`, conflicting with what `setup_local.ps1` actually copies from). Doctor warns on non-loopback `LOCAL_AI_BASE_URL` / `SEARXNG_BASE_URL` (privacy posture matches README). Distinct "completed with warnings" exit message. Kept the strict `WEB_AUTO_SEARCH === 'true'` semantics to match `index.js`.
- ✅ **`.env.default` adds `DISCORD_CLIENT_ID=`** (`8c13e82`). Was missing from the template even though the doctor expected it.
- ✅ **`.gitignore` consolidated** (`8c13e82`) from ~200 lines of duplicated publish-safety rules into ~140 lines organized by category. Preserved all the recent additions (`data/user-facts.json`, `data/memory-presets.json`, `data/prompt-templates.json`, the `!data/.gitkeep` allowlist).
- ✅ **`_hf_uninstall` handles `CacheNotFound`** (`8c13e82`). Was 500-ing on a fresh install with no HF models ever downloaded; now returns the same idempotent `{ok:True, freed_bytes:0, note:"cache directory not found"}` shape as the "model not in cache" path.

Skipped from the audits:
- Index.js split (Nathan previously deferred — needs go-ahead).
- `package-lock.json` (worth doing separately).
- Linux/macOS launcher (out of scope — Windows-only is intentional).
- The `envFlag` loosening for `WEB_AUTO_SEARCH` (would have diverged from bot's actual strict `=== 'true'` check; kept the bot-matching semantics).
- Both audit markdown reports (`docs/AUDIT_2026-05-25.md`, `JULES_REPO_AUDIT_REPORT.md`) — they belong on the PRs, not main.
- Jules's `test_hf.py` debug script.

#### Can ship anytime (no blockers)

All four "ready anytime" items shipped 2026-05-25 in commits `3e4a0fa`, `3878ba4`, `7a3368d`:

- ✅ **`GET /route/debug?role=...`** — read-only diagnostic at `local_ai_server.py:2098`. Returns `{ok, prompt_preview, role_requested, role_resolved, backend, model_id, endpoint, fallback_chain, auto_fallback_enabled, note}`. The bot's regex-based role selector still lives in `seekdeepSelectChatModelRole` (index.js); the endpoint is honest about that boundary in its `note` field. Pass the role the bot WOULD pick (or what the user requested) as the `role` query param.
- ✅ **Memory recall: write-side** — bot-side `@SeekDeep remember <fact>` / `recall` / `forget #N | <substring> | all` commands, persisted to `data/user-facts.json` (gitignored, atomic writes), injected into the chat system prompt via new `seekdeepComposeUserSystemBlock` helper. Caps: 25 facts/user, 500 chars/fact. Both chat call sites updated.
- ✅ **`POST /model/uninstall`** — counterpart to `/model/install` at `local_ai_server.py:2031`. HF cache delete via `huggingface_hub.scan_cache_dir().delete_revisions()`, Ollama `DELETE /api/delete`, no-op for remote backends. Optional `role` param blanks per-role `LOCAL_CHAT_<ROLE>_*` env keys via `_seekdeep_merge_env`.
- ✅ **Extended `gui-smoke`** — 20 new checks in `scripts/smoke_gui_endpoints.py` covering `/route/debug` (response shape, default role, bogus-role fallback, prompt-preview truncation), `/model/install` (auth + Pydantic validation), `/model/uninstall` (auth + hf-absent idempotency + remote no-op + unknown-role 400 with env_patched=False). `gui-smoke` is now 52 checks (was 32). Bot smoke is 501 checks (was 493).

#### Post-designer cycle — all three items shipped 2026-05-25

After designer zip 31 landed, Claude Code knocked out all three queued backend items in sequence. Each was committed independently for clean rollback:

- ✅ **Item C — `/memory/*` endpoints** ([95948f4](https://github.com/NathanNeurotic/seekdeep-DiscordBot/commit/95948f4)). Nine routes in `gui_endpoints.py` over the existing `data/user-facts.json` + `data/memory-presets.json` files: GET /memory/users, GET/POST/PATCH/DELETE /memory/user/{id}[/fact/{n}], GET /memory/user/{id}/export, GET/POST /memory/presets/{id}. Write endpoints token-guarded; caps mirror `SEEKDEEP_USER_FACTS_MAX` + `SEEKDEEP_USER_FACT_MAX_CHARS`. gui-smoke 52 → 73.
- ✅ **Item B — Universal Archive surface** ([e697f95](https://github.com/NathanNeurotic/seekdeep-DiscordBot/commit/e697f95)). Two trigger paths share the existing `seekdeepArchiveImageStateToDiscordThread` flow: (1) right-click → Apps → `Archive (SeekDeep)` context menu command, and (2) reply to a message with `archive` / `archive this` / `archive please` / `@SeekDeep archive`. Image extractor handles both attachments + embed images, content-type missing fallback to extension. Bot smoke 504 → 528.
- ✅ **Item A — Prompts marketplace** ([560ecbf](https://github.com/NathanNeurotic/seekdeep-DiscordBot/commit/560ecbf)). Per-server `#prompts` channel — admin sets it with `@SeekDeep prompts channel here`, users post their saved templates with `@SeekDeep template share <name>` as formatted embeds with Import + Copy buttons. Import handler dedupes name collisions with `-imported-<short-hex>` suffix. Embed footer counter bumps via `message.edit` on each import. Reuses `data/archive-guild-config.json` for the channel-id config. Bot smoke 528 → 544.

Final preflight: 4 ok / 0 fail · bot smoke 544 · gui-smoke 73.

Both v1 follow-ups shipped 2026-05-25 in [02127b9](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/commit/02127b9):

- ✅ **Universal Archive author-notify** — bot adds 📥 reaction on the source message when someone archives a user-posted image. Skip rules: target is bot, target author == requester, archive was duplicates-only, permission denied. Configurable via `SEEKDEEP_UNIVERSAL_ARCHIVE_NOTIFY=on|off` (default on) and `SEEKDEEP_UNIVERSAL_ARCHIVE_NOTIFY_EMOJI` (default 📥).
- ✅ **Prompts marketplace edit-in-place + tombstone** — templates now carry a `sharedAs` pointer at their share embed. `template save <existing>: <new>` auto-pushes to the share. `template share <existing>` updates the existing post instead of duplicating. `template delete <existing>` tombstones the share (strikethrough title + gray color + footer date + buttons dropped). Both mention + slash command paths wired symmetrically. Tombstone builder is idempotent.

Final smoke: bot 555, gui-smoke 73.

#### Designer zip 33+34+35 backend asks — all shipped 2026-05-25

All three queued items landed in sequence; each committed independently:

- ✅ **D — `/archive/config` + multi-mode notify + opt-out** ([308feda](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/commit/308feda)). FastAPI gains `GET/POST /archive/config` (POST token-guarded, persists to `data/archive-config.json`). Bot's `seekdeepUniversalArchiveDispatch` now resolves mode via per-channel override → global config → env-flag fallback. New `dm` / `reply` branches added alongside the existing `react` path. `notify_self` toggle, `sent_24h` counter, `@SeekDeep archive opt-out` / `opt-in` / `opt-out status` user commands (persisted to `data/archive-optout.json`). Backward-compat: v1 installs without a config file fall back to the env flag exactly as before. gui-smoke 73 → 85.
- ✅ **E — `@SeekDeep template edit <name>` + 14-day reshare logic** ([cac2d74](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/commit/cac2d74)). New command saves the new body locally + applies age-aware policy. If share age ≤ `SEEKDEEP_PROMPTS_RESHARE_MAX_AGE_DAYS` (default 14d, clamped [1, 365]), edit-in-place via `message.edit()`. Past threshold: tombstone the old (strikethrough + "superseded by" footer) + post fresh + increment `edit_count`. `sharedAs` schema extended with `posted_at`, `edit_count`, `last_edited_at`, `prior_msg_id`. Backward-compat: rows without `posted_at` fall back to `sharedAt` for age calc. bot smoke 559 → 565.
- ✅ **F — `GET /config` redacted env map** ([f2b7e9a](https://github.com/NathanNeurotic/SeekDeep-DiscordBot/commit/f2b7e9a)). FastAPI gains read-only `GET /config` (open, no token) returning `{ ok, env: { ... } }` with secret-tagged keys redacted to `*****`. Word-boundary regex matches `TOKEN` / `KEY` / `PASSWORD` / `SECRET` / `PASS` / `PRIVATE_KEY` so config knobs like `MAX_OUTPUT_TOKENS` (substring 'TOKEN') stay readable. Named allowlist covers Discord/HF/Anthropic/OpenAI/Google/Gemini/Groq/DeepSeek/OpenRouter/xAI/SEEKDEEP_GUI_TOKEN. Closes designer's dynamic-facts IIFE loop. gui-smoke 85 (already counted).

Final smoke: bot 565, gui-smoke 85.

#### Queued from designer audit 2026-05-25 ([AUDIT_DESIGNER_2026-05-25.md](AUDIT_DESIGNER_2026-05-25.md))

Designer ran a deep audit on chat.html + the rest of the GUI. Most findings are real, several were based on a stale local copy and need no action (see audit doc § D + § H for the "lessons learned"). All four new items shipped 2026-05-25 in the same pass:

- ✅ **G — `POST /persona` endpoint** (`gui_endpoints.py`). GET (open) returns `{ok, valid_personas, env_default, global, effective_global, channels_count, guilds_count}`. POST (token) accepts `{scope, persona}` or `{scope, action:'reset'}`; scopes are `global` / `channel` (+ `channel_id`) / `server`+`guild` alias (+ `guild_id`). Schema adds a new `global` key to `data/persona-overrides.json`; `seekdeepGetEffectivePersona` in index.js extended to check it after channels+guilds but before env default. Smoke tests cover happy path, validation failures, alias, and reset.
- ✅ **H — Version reconciliation**. `package.json` bumped `10.0.0-fresh-rebuild` → `10.35.0`. `local_ai_server.py:_read_pkg_version()` already sources from package.json so `/health.version`, FastAPI's `version=`, and every `version.js`-rewritten `[data-version]` cell now match release tags. `src-tauri/tauri.conf.json` switched to `"version": "../package.json"` so installer metadata follows.
- ✅ **I — PWA scope** (`gui/sw.js`). Kept `start_url: chat.html` (the playground is the daily-use surface). Cache expanded to include `events.js` + `version.js` + `playground.js` + `manifest.json` so offline chat.html keeps its event bus + version rewriter + composer wiring. CACHE_VERSION bumped to `v10.35.0-2`. Added explicit comment about the relative-paths-to-worker-URL convention (audit item #12).
- ✅ **J — `GET /stats/counts` endpoint** (`gui_endpoints.py`). Open GET returns `{ok, smoke_tests, gui_smoke_tests, releases, commands, surfaces, generated_at, sources}`. Source matrix: `smoke_test.mjs check()` count, `scripts/smoke_gui_endpoints.py check()` count, `git tag --list`, `COMMANDS.md` `^\| \`` row count, `gui/nav.js` `PAGES` array length. Each degrades to `null` if its source is missing. Designer Phase 4 still needs to add `data-stat-<key>` attributes to the relevant cells + wire a tiny consumer (extend `version.js` or new `stats.js`) — see `INTEGRATION.md § 3.8`.

Final smoke (this pass): bot 565, gui-smoke 107 (was 85, +22 new checks for /persona and /stats/counts).

Also fixed in the same pass (audit items resolvable without designer):
- ✅ **C5 license mismatch** — `gui/landing.html` (lines 196 + 399) and `gui/pitch.html` (lines 328 + 340) all said "MIT" while `LICENSE` is GPL-2.0. Now all four say `GPL-2.0` / `GPL-2.0 licensed`.
- ✅ **E13 cBotVram placeholder** (`gui/chat.html` `cLIVE.apply()`) — added `else { set('cBotVram', 'cpu · no gpu'); }` so the static "14.2 / 24 GB" placeholder is overwritten when `/health.gpu` is absent (CPU-only mode). Was lying to the user about VRAM that doesn't exist.
- ✅ **E12 sw.js relative-paths comment** — added a path-convention note to the file header so anyone moving sw.js knows to adjust SHELL entries.

#### Tauri sidecar v2 — shipped 2026-05-25 (commit `06ad685`)

Auto-spawn `local_ai_server.py` on .exe launch. The user double-clicks the installer, then double-clicks SeekDeep, and the playground comes up — no `setup_local.ps1` ritual, no "open install dir" anywhere in the UI. Architecture:

- **Bundled in the installer** (resources): `local_ai_server.py`, `gui_endpoints.py`, `warmup_local_cache.py`, `package.json`, `requirements-local.txt`, `.env.default`, `gui/**/*`. Our code only — no Python runtime, no pre-installed deps.
- **System dependency** (user installs once, surfaced in-app via the loading page): Python 3.11+. If missing, "Get Python 3.11+ ↗" button on the loading overlay opens python.org.
- **In-app pip install**: "Install Python deps" button on the loading overlay runs `python -m pip install --user -r requirements-local.txt` via a Tauri command. No terminal, no manual filesystem ops.
- **First-run extraction**: on every version change, Rust copies bundled resources to `%APPDATA%/SeekDeep/app/` (POSIX equivalent on mac/linux). User-mutable `data/` + `outputs/` subdirs are preserved across updates via file-by-file copy (not recursive blat).
- **Spawn**: `python local_ai_server.py` with cwd = app_data, stdout/stderr to `%APPDATA%/SeekDeep/logs/server.log`. Killed on window-close + app-exit.
- **No-op if external server is running**: probes :7865 first; if alive (e.g. user has the dev `.bat` running), the Tauri shell just navigates the WebView to chat.html without spawning.
- **Loading UX**: `gui/seekdeep-loading.html` polls /health every 500ms with stage-aware hints ("STILL PROBING · cold model imports may take a minute" at 30s). After 60s of failure, shows three in-app buttons: Retry / Install Python deps / Get Python 3.11+ ↗.

Deferred to a later pass:
- **Bundled Python runtime**: not in scope. Python stays a system dep per Nathan's call (clean separation of "ours" vs "user's environment").
- **Auto-download heavy ML deps** (torch / transformers / diffusers ~2 GB on first chat or image use). Currently the user has to install them via the same pip install path. Could be promoted to "first-use download" with consent UI later.
- **System tray + minimize-to-tray**.
- **Code signing** for Windows SmartScreen + macOS Gatekeeper.

---

**B. Universal "Archive (SeekDeep)" surface — context menu + reply-with-"archive"** — make EVERY image in chat archivable, not just bot-generated ones. Two trigger surfaces, zero channel noise by default.
   - **B.1 Context menu (always-on)**: register `Archive (SeekDeep)` as a Message context menu command alongside the existing `Force React (SeekDeep)`. Right-click any message → Apps → Archive (SeekDeep) → bot archives the attachments + embed images to the requesting user's archive, replies ephemerally with a confirmation. Works on user posts, bot posts, link previews, anything with an image. ~80 lines including registration + dispatch + the "no image to archive" empty-state.
   - **B.2 Reply-with-"archive"**: in `messageCreate`, detect when a message is a reply (`message.reference?.messageId`) AND the body matches a permissive `archive` trigger (`/^(?:@\S+\s+)?archive(?:\s+(?:this|that|it|please))?\s*$/i`). Fetch the referenced message, run the archive flow against it. ~60 lines. Liberal phrasing supports natural variants: "archive", "archive this", "archive please", "@SeekDeep archive". Won't conflict with the existing `archive` admin commands because those don't run in reply-to-image context.
   - Both share the existing archive flow as their backend — only the trigger surfaces are new.
   - Edge cases: replied message has no image → polite empty-state reply; replied message is from a thread/forum the bot can't read → 403 catch + "I can't see that message"; user archives someone else's image → silent for v1 (matches how anyone can already save any Discord image), add author-mention later if real users find it weird.

#### Needs a "go" from the user

5. **`index.js` split** into `lib/image-pipeline.js`, `lib/archive.js`, `lib/persona.js`, `lib/router.js`, `lib/commands.js`, `lib/reactrules.js`, `lib/discord-presence.js`. Designer's HANDOFF Task 6.
   - Effort: 1–2 days dedicated. Risk: high — touches 100+ handlers. CI's `preflight` (493 smoke tests) is the safety net. Recommended: do one module per commit, run preflight between each. Don't half-do.

6. **`smoke_test.mjs` split** into `tests/smoke/{archive,image-pipeline,router,persona,reactrules,commands,gpu-health}.mjs` with an index runner. Designer's HANDOFF Task 7.
   - Effort: ~half-day. Easier after #5.

~~7. **GIF history eviction**~~ — DONE 2026-05-25. Used `git filter-repo --strip-blobs-with-ids` to evict blob `991d748b` (17.5 MB) from every commit reachable from `main` and every tag. Force-pushed `origin/main` from `3756e35` → `a0bbf93`. Fresh `git clone --depth=1` of `origin/main` is now **23 MB** (was ~36 MB before). Same blob appeared under 4 paths in history (`docs/uploads/`, `gui/uploads/`, `gui/assets/seekdeep-mark.gif`, `SeekDeepOnline/uploads/`) — stripping by blob ID killed all four at once. Safety net: remote tag `pre-gif-evict-2026-05-25` still pins the original main commit; safe to delete once you're confident.

   Local `.git/` is still 42 MB because the local pack file doesn't fully reclaim unreachable blobs without a manual re-clone. Doesn't affect remote, doesn't affect fresh clones. If you want a smaller local repo, re-clone fresh from origin.

   v10.x tags were left alone by filter-repo (they pointed at commits that already didn't contain the blob in their tree snapshot), so all tag SHAs match between local and remote.

### Designer queue (UI work)

All have backend ready unless noted.

#### Backend ready — designer just builds UI

1. **"Add a Model" wizard** — 3–4 step picker. Step 1: backend (hf/ollama/openai-compat/anthropic/gemini). Step 2: model ID (with provider-specific helper text — link to HF Hub for hf, list of installed tags for ollama, model dropdowns for the remotes). Step 3: API URL + key when remote. Step 4: assign to role + confirm. Backend: `POST /model/install`.

2. **Settings / paths UI** in the Config pane — fields for `HF_HOME`, `OLLAMA_MODELS`, `LOCAL_MODEL_CACHE_DIR`, `OLLAMA_KEEP_ALIVE`, plus per-role API URL + key. Backend: existing `POST /config`.

3. **Wire Hub "Local stack" panel** to live data and remove "Example readout · awaiting live wiring" label. Backend: `SeekDeepEvents.on('vram.sample', ...)`, `('model.loaded', ...)`, `('queue.depth', ...)`.

4. **Wire Models pane** RESIDENT / PINNED / CACHED badges + HF / Ollama / Remote ⚠ backend badges. Backend: `/health.chat_backends` + `/health.remote_chat_endpoints` + `model.loaded` / `model.evicted` events.

5. **Wire Logs viewer** to live `log.line` events (currently polls `/logs/tail`). Backend: `SeekDeepEvents.on('log.line', ...)`. Note: opt-in via `SEEKDEEP_EMIT_LOG_LINES=on`.

6. **Title-bar LIVE pill** flips on WS connect / disconnect. Backend: `SeekDeepEvents.connected` + `'_open' / '_close'` pseudo-events.

7. **`data-version` attribute** added to every `v10.x` cell in titlebars / footers / sidebars. Backend: `version.js` auto-rewrites once marked; no JS needed on designer side. Cells in: `index.html`, `app.html`, `chat.html`, `landing.html`, `pitch.html`, `docs.html`, `api.html`, `architecture.html`, `roadmap.html`, `changelog.html`, `memory.html`, `mobile.html`, `boot.html`, `installer.html`, `nav.js`.

8. **Image pipeline A/B view** — same prompt + seed across `/image`, `/img2img`, `/instruct-pix2pix`, `/inpaint`. Four panels side by side. Backend: 4 endpoints already exist.

9. **API Explorer offline state** — surface the "falls back to canned mocks when offline" UX as a labeled state on each endpoint card.

10. **Quiet the bubbles** on `docs.html` + `api.html` (text-dense surfaces). CSS-only, opacity reduction on `.abyss` + `.bubbles` for those pages.

11. **Mobile mocks → real PWA** — `manifest.json` + service worker on `chat.html` if they want the mobile mock to become a real installable companion app.

#### Designer designs first, Claude Code builds backend after

12. **Memory recall UI** in `memory.html` — review / edit / export / clear the bot's per-user memories. Needs my #2 above (write-side commands + JSON store) shipped first, OR can be designed as a clickable prototype against mock data while I build the backend in parallel.

13. **Route Inspector panel** in `api.html` — renders the `/route/debug` debug payload. Needs my #1 above shipped first, OR can mock the JSON shape from this PLANNED entry while I build the endpoint in parallel.

14. **TTS preview UI** — voice channel picker + voice picker + queue mockup. Backend (Piper / XTTS / etc.) is deferred indefinitely; designer can mock now so when TTS finally lands, the integration target is clear.

15. **Prompt template marketplace** — Now spec'd as a per-server `#prompts` channel pattern (see "Queued for post-designer cycle" item **A** above). Designer can mock the share/import button UX against the new spec; Claude Code builds the backend after designer wraps.

### Needs decision before either of us starts

| Item | Decision needed |
|---|---|
| **Streaming chat responses** | Big refactor (`/chat` → SSE, bot handler restructures, Discord edits token-by-token). Worth the win? |
| **Per-message cost tracking for remote backends** | Useful to prevent surprise bills on `openai-compat` / `anthropic` / `gemini`. Where to store? How to display? |

### Already shipped — for cross-reference

The "what's now live" snapshot lives in the commit log; the canonical entry points to read are:

- `MAINTAINER.md § 1` — files we own and that designer zips would clobber (audit-overrides catalog)
- `INTEGRATION.md § 3.4` — chat-backend matrix, per-role config, `/model/install`, `/health.remote_chat_endpoints`
- `INTEGRATION.md § 3.5` — WebSocket event bridge (7 live topics)
- `INTEGRATION.md § 3.6` — Version SoT (`/health.version` + `data-version`)
- `INTEGRATION.md § 4` — Archive bot bridge snippet
- `README.md` privacy block — third-party disclosure (Discord / HF / Ollama / SearXNG / `openai-compat` / `anthropic` / `gemini`)
- `.env.example` — every supported env var with inline explainers

---

## v10.34 Sprint — All Fixed (pending commit)

All confirmed bugs from live testing on 2026-05-19. 274 smoke tests pass.

### 1. Persona modal crash ✅ fixed
Label shortened from 52 to 25 chars (`'Persona name (or reset)'`).

### 2. Deprecated `ephemeral: true` ✅ fixed
All 11 occurrences migrated to `flags: MessageFlags.Ephemeral`.

### 3. Shared archive button 77s-637s ✅ fixed
Removed O(n) full thread scan (`seekdeepScanThreadArchiveEntryStats`) from shared archive button path. Now trusts the JSON profile fast count. Verification scans reserved for `archive status`.

### 4. Archive delete button `50027` ✅ fixed
Removed full thread scan from delete path. Now decrements profile count atomically. Final `editReply` wrapped in try/catch with fallback to `channel.send`.

### 5. Inpaint prompt extraction ✅ fixed
Now extracts removal target ("the small houses") instead of generic fill prompt. Combines target+scene when scene is non-generic.

---

## Image Pipeline Quality — Priority Improvements

Audited all 5 image pipelines on 2026-05-19. Parameters listed are what the Node side sends (not just Python defaults).

### Pipeline Parameter Summary

| Pipeline | Steps | Guidance | Strength | Resolution | Neg Prompt |
|----------|-------|----------|----------|------------|------------|
| txt2img (`/image`) | env `IMAGE_STEPS` (28) | env `IMAGE_GUIDANCE_SCALE` (7.0) | n/a | 1024x1024 | env `IMAGE_NEGATIVE_PROMPT` |
| img2img | env `IMAGE_STEPS` (28) | env `IMAGE_GUIDANCE_SCALE` (7.0) | adaptive 0.45-0.80 | 1024x1024 | env `IMAGE_NEGATIVE_PROMPT` |
| pix2pix | 30 hardcoded | 9.0 hardcoded | n/a | 512->1024 upscale | env fallback |
| inpaint | 30 hardcoded | 5.0 hardcoded | 0.95 hardcoded | 1024x1024 | none sent |
| upscale | n/a | n/a | n/a | Lanczos NxN | n/a |

### 6. Inpainting quality improvements ✅ tuned
CLIPSeg mask: threshold 0.4->0.3, MaxFilter(21) dilation, GaussianBlur(8) feathering. Inpaint params: strength 0.95, guidance 5.0, steps 30, negative prompt now sent. CLIPSeg remains a lightweight model — future upgrade path is SAM/GroundingDINO.
**Remaining improvement ideas:**
  - [ ] Mask preview option (`mask_preview:true`)
  - [ ] Multi-prompt CLIPSeg for complex targets
  - [ ] Stronger segmentation model (SAM, GroundingDINO)

### 7. Pix2Pix image_guidance_scale ✅ fixed
Now adaptive: heavy edits (scene/style transforms) get 1.2, light edits (brightness/color tweaks) get 2.0, default 1.5. Was hardcoded at 1.0.

### 8. img2img guidance_scale ✅ fixed
Changed from `IMAGE_GUIDANCE_SCALE` (txt2img's 7.0) to `IMAGE_IMG2IMG_GUIDANCE_SCALE` (default 5.0).

### 9. Context menu img2img modal auto-routing ✅ fixed
Instruction-like prompts auto-route to pix2pix (modifications) or inpaint (removals) when features are enabled.

### 10. Adaptive strength scene/environment tier ✅ fixed
Added 0.80 tier for scene keywords. Generic "make it" bumped 0.65->0.70.

---

## Model Router Gaps

### 11. `lightweight_chat` routing ✅ fixed
Model router now routes to `lightweight_chat` (gemma-3n-E4B-it) for: translation tasks, greetings (hi/hello/thanks/bye), short trivial prompts (who are you, what time, ping). Only activates when `LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID` env var is set. Falls back to `default_chat` on Python side if model unavailable.

---

## Performance

### 12. Archive thread scan removed ✅ fixed (same as #3/#4)

### 13. Thread rename debounce ✅ fixed
`seekdeepMaybeRenameArchiveThread` now tracks last rename time per thread with 30-second cooldown. Rapid archive clicks no longer queue up rename API calls.

---

## Recently Shipped

### v10.33 -- Bug fixes + loading gif + image edit routing
- Ephemeral modal ack (fixed double-message on context menu modal submits).
- Pix2Pix output: fixed aspect ratio stretch on non-square images (now always 512->1024 square).
- Context menu embed image fallback (images in embeds now found by vision/upscale/img2img).
- Loading gif added to 8 context menu handlers + 3 slash commands.
- Stats chart orphan loading gif fix.
- Context menu upscale + img2img text-path changed to ephemeral defer.
- 7 new smoke tests (249->256).

### v10.32 -- Context menu modals + adaptive img2img + pix2pix tuning
### v10.31 -- InstructPix2Pix + Inpainting + routing overhaul
### v10.30 -- Image quality tuning (Dreamshaper-XL defaults)
### v10.29 -- Auto-translate channel
### v10.28 -- Refinement retry + analytics chart
### v10.27 -- COMMANDS.md permission column
### v10.22-v10.26 -- Phase 2 features (archive fix, search, templates, img2img, persona modal)
### v10.16-v10.21 -- QoL + maintenance (status rotation, help search, OCR, archive clean, repo cleanup)
### v10.12 -- GPU / VRAM live monitoring

---

## Next Up

- **Real-ESRGAN model download** -- scaffolded in v10.25 but needs user approval for the model cache.
- **TTS voice channel** -- Piper or XTTS. Biggest remaining lift. Requires model download.

## Optional Features (Scaffolded, Off By Default)

### `SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX` -- shipped v10.31
### `SEEKDEEP_FEATURE_INPAINT` -- shipped v10.31

### `SEEKDEEP_FEATURE_NSFW_GATE`
CLIP-based NSFW scorer on generated images. Needs model, scoring step, thresholds, `.env` knobs.

### `SEEKDEEP_FEATURE_TTS_VOICE`
Voice-channel TTS reader (Piper or XTTS). Voice connection, model setup, per-channel opt-in.

## Quality-of-Life Wishlist

- **GPU logging** -- optional background sampler, `SEEKDEEP_GPU_LOGGING=on`.
- **VRAM budget table** -- document which model combinations fit a 24 GB card.
- **Latin-script language detection** -- extend auto-translate to detect French, Spanish, etc.
- **Inpaint mask preview** -- ✅ shipped in Phase C. Exposes mask preview bypass command to check CLIPSeg outputs.

## Segmentation Roadmap: CLIPSeg to SAM/GroundingDINO

### Current CLIPSeg Behavior & Features
- **Model**: `CIDAS/clipseg-rd64-refined` (under 200MB, quick startup, fits within general VRAM budget).
- **Function**: Takes a text query (e.g. "the wizard") and returns a low-resolution heatmap of pixel probabilities, which is resized and thresholded (> 0.3) into a binary mask.
- **Feathering**: Extends mask bounds using `MaxFilter(21)` dilation and `GaussianBlur(8)` blur.

### Limitations of Current CLIPSeg
- **Spatial / Object Resolution**: Resolution is extremely low (64x64 internally), causing jagged boundaries or missing fine details (e.g., thin poles, fingers).
- **Semantic Overlap**: Often struggles to segment one object when multiple similar ones overlap or are near each other.
- **Scale Issues**: Very small objects or background elements fail to excite the text encoder, returning empty or incomplete masks.

### Future Path: SAM & GroundingDINO Integration
- **GroundingDINO**: A zero-shot object detector that will generate high-quality bounding boxes from text queries.
- **Segment Anything Model (SAM)**: Uses GroundingDINO's bounding boxes as prompts to produce high-resolution, pixel-perfect instance segmentations.
- **Expected Benefits**: Sharp, high-fidelity mask edges, distinct object separation, and robust detection of small/obscured objects.

### Implementation Dependencies & Deferred Rationale
- **Footprint**: SAM + GroundingDINO models are significantly larger (1.5GB to 3GB+ combined), adding heavy startup overhead.
- **Dependencies**: Requires extra complex libraries (`torchvision`, `supervision`, or custom CUDA extensions) which complicate multi-platform installation (especially on Windows).
- **VRAM Constraints**: Running SAM alongside SDXL, LLM chat, and vision models easily exceeds standard consumer GPU limits (e.g., 8-16 GB).
- **Role of Mask Preview**: Exposing the mask preview helper command (`@SeekDeep mask preview <target>`) allows testing/debugging CLIPSeg boundaries locally before spending GPU cycles on full diffusion inpainting.

## Persistent Memory Roadmap

### 1. Current State: Rolling Memory
Currently, SeekDeep utilizes in-memory rolling buffers (`getRecentContext`, `remember`) which maintain conversational state in RAM per-channel/thread. When the bot restarts, or after active contexts expire from memory, this state is lost.

### 2. Proposed Persistence: Per-User and Per-Channel JSON
To support long-term context retention across restarts, we propose a JSON-based file persistence layer:
- **Scope**: User-specific memories (e.g., preference overrides, user profile notes) stored in `data/user-memories.json` and channel-specific memories (e.g., context summaries, pinned facts) in `data/channel-memories.json`.
- **Atomic Operations**: Read-on-demand with atomic writes to guarantee file integrity, matching the patterns in `auto-reactions.json` and `prompt-templates.json`.

### 3. Privacy Controls & Opt-Outs
- **Per-Server Disable Switch**: Server admins can completely disable memory storage for their guild using `@SeekDeep memory feature off` (stored in `persona-overrides.json`).
- **Privacy Controls**: Opt-in/opt-out configuration for individual users so they can request SeekDeep not to record any long-term memories about them.

### 4. Memory Administration Commands
- **Remember/Forget**: Users can instruct the bot to store or purge facts explicitly:
  - `@SeekDeep remember that I prefer Python over JavaScript`
  - `@SeekDeep forget my coding preferences`
- **Export/Clear**: Commands to inspect and wipe all recorded data:
  - `@SeekDeep memory export` (returns a JSON file of stored data for that user).
  - `@SeekDeep memory clear` (wipes all personal data).

### 5. Retention Limits & Optimization
- **Limits**: Stored memories will be capped at a maximum of 25 facts per user/channel, or 10 KB per profile, to prevent unbounded file growth.
- **Pruning**: Least-recently-used (LRU) entries or oldest timestamps will be pruned automatically when limits are reached.

### 6. Why Deferred
- **Context Injection Cost**: Persisting memories requires semantic search (e.g., local vector store/embeddings) or model-based summarization to decide when to inject memories into the LLM system prompt.
- **Model Attention Spans**: Randomly injecting long lists of facts burns context window tokens and degrades attention/performance on lightweight models (Gemma-2B/3B).
- **Scope Isolation**: Deferred to a future release to keep Phase D focused on admin telemetry, permission diagnostics, and search safety controls.

## Deferred

- **`shouldAutoSearch` refactor** -- only worth doing if a second consumer needs the same lists.
- **`seekdeepLegacyArchiveUserThreadName` migration** -- needs one-time migration tool.

## Won't Do

- **Quote Cards** (from demonbot) -- explicitly skipped.
- **Game Lookup** (from demonbot) -- explicitly skipped.
- **Further messageCreate handler extraction** -- remaining lines ARE orchestration.
