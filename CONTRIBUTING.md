# Contributing To SeekDeep

SeekDeep is currently maintained as a local Discord bot project. Work evidence-first: inspect the live files, logs, and runtime behavior before changing code.

## Local Setup

Prerequisites:

- Node.js 20 or newer
- Python 3.10 or newer
- Docker Desktop
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

## Code Style

JavaScript:

- Use the existing style in `index.js`.
- Keep helper functions top-level when they are shared across routes.
- Avoid wrapper stacks when a single canonical helper is clearer.

Python:

- Keep `local_ai_server.py` focused on local model serving.
- Preserve existing endpoint behavior for `/health`, `/chat`, `/vision`, `/image`, and `/unload`.

## Required Checks

Run after source edits:

```powershell
node --check .\index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
```

Core Discord smoke tests:

```text
@SeekDeep status
@SeekDeep help
@SeekDeep cache status
@SeekDeep show me a banana eating a monkey
@SeekDeep draw me a goomba
@SeekDeep generate a goomba
@SeekDeep generate me
@SeekDeep ask what are you?
```

Archive smoke tests:

```text
@SeekDeep archive shared
@SeekDeep archive setup here
@SeekDeep setup archive here
@SeekDeep archive status
@SeekDeep archive status @user
```

Then click `Archive` and `Shared Archive` on a generated image and check that interactions finalize cleanly.

## Documentation

Keep these files aligned when behavior changes:

- `README.md`
- `COMMANDS.md`
- `REQUIREMENTS.md`
- `.env.default`
- `AGENTS.md`

Do not document unsupported commands as working.
