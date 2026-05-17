# Contributing To SeekDeep

SeekDeep is maintained as a local Discord bot project. Work evidence-first: inspect the live files, logs, and runtime behavior before changing code.

## Local Setup

Prerequisites:

- Node.js 20 or newer
- Python 3.10 or newer
- Docker Desktop (for SearXNG)
- NVIDIA/CUDA-capable local environment for the configured models

Install dependencies from the repo root:

```powershell
npm install
.\.venv\Scripts\python.exe -m pip install -r .\requirements-local.txt
```

Create `.env` from `.env.default` if needed, then set `DISCORD_TOKEN`.

Start the stack with:

```powershell
.\seekdeep_launcher.bat
```

## Development Rules

- Preserve working launch flows and local model behavior.
- Prefer minimal, bounded diffs over broad rewrites.
- Do not add new features until the relevant core route smoke tests pass.
- Do not touch `.env` secrets.
- If local Git metadata is unavailable, create a timestamped snapshot under `checkpoints/` before edits.
- Avoid the old PowerShell patch-file workflow unless specifically requested.
- New `SEEKDEEP_FEATURE_*` flags default to `off`. Existing optional features (`emoji vault`, `force react`) stay `off` in shared servers to avoid colliding with demonbot.

## Code Style

JavaScript (`index.js`):

- Use the existing style — single-quoted strings, 2-space indent, top-level function declarations for shared helpers.
- Keep helper functions top-level when they're shared across routes; nested arrow functions are OK for callbacks.
- Avoid wrapper stacks. If you find a `seekdeepFooSafeV13(x)` that just `return foo(x)`, delete the wrapper and rename call sites (v10.6 did this for 6 wrappers; the codebase is allergic to them now).
- Use `seekdeepReplyToTarget(target, payload)` for any new reply that should work with both `Message` and `Interaction` shapes — don't fork into two parallel `…Message` / `…Interaction` functions (v10.7 / v10.8 consolidated the last 4 of those).
- Use `seekdeepFetchWithLimits(url, { timeoutMs, maxBytes })` instead of bare `fetch(attachment.url)` for any user-supplied URL.

Python (`local_ai_server.py`):

- Keep it focused on local model serving.
- Preserve existing endpoint behavior for `/health`, `/chat`, `/vision`, `/image`, and `/unload`.

## Required Checks

Run after source edits:

```powershell
npm run preflight
```

This single command runs:

1. `node --check` on `index.js`, `smoke_test.mjs`, `scripts/preflight.mjs`
2. `python -m py_compile` on `local_ai_server.py`, `warmup_local_cache.py`
3. `npm run smoke` — the regression smoke test

Exit code 0 only when every stage passes. ~1 second total.

A `.git/hooks/pre-commit` hook runs the JS + Python parse checks before any commit lands. The hook is plain bash + node, no extra tooling required.

## Smoke Test Architecture

`smoke_test.mjs` sets `process.env.SEEKDEEP_TEST_MODE = '1'` before its dynamic `import('./index.js')`. With that env var set, `index.js` skips `client.login()` and exposes a whitelist of pure helpers on `globalThis.__seekdeepTest`:

```text
splitDiscordText
seekdeepIsFrustrationPrompt
seekdeepCompileReactionPattern
seekdeepHelpText
seekdeepHelpTopicSlice
seekdeepParseHelpTopic
seekdeepEmojiVaultThreadName
seekdeepEmojiVaultFormatPage
seekdeepForceReactBucketRange
forceReactConstants (object)
emojiVaultConstants (object)
chunkerConstants (object)
```

Every smoke assertion routes through the real implementation, not a mirrored copy. If you add a new pure helper that's worth regression-testing, expose it on `globalThis.__seekdeepTest` (near the end of `index.js`) and add the check to `smoke_test.mjs`.

## Live Discord Smoke

After the automated preflight passes, exercise the bot live for routes that depend on Discord state:

```text
@SeekDeep status
@SeekDeep help
@SeekDeep help chat
@SeekDeep cache status
@SeekDeep show me a banana eating a monkey
@SeekDeep draw me a goomba
@SeekDeep generate me
@SeekDeep ask what are you?
@SeekDeep stats
```

Archive smoke tests:

```text
@SeekDeep archive shared
@SeekDeep archive setup here
@SeekDeep archive status
@SeekDeep archive me
```

Then click `Archive` and `Shared Archive` on a generated image and verify the interactions finalize cleanly.

See [SMOKE_TEST.md](SMOKE_TEST.md) for the full live-Discord checklist.

## Documentation

Keep these files aligned when behavior changes:

- `README.md` — release notes, env knobs, feature-flag table
- `COMMANDS.md` — user-facing command reference
- `REQUIREMENTS.md` — runtime + env shape + verification
- `AGENTS.md` — internal subsystem map; if you add or delete a top-level helper, update the relevant section
- `SMOKE_TEST.md` — live-Discord verification steps
- `PLANNED.md` — deferred work and roadmap
- `.env.default` — env knob comments (the template `.env` is copied from)
- `SECURITY.md` — when adding new attack surface (new network endpoints, new permissions, new fetch sites)

Do not document unsupported commands as working.
