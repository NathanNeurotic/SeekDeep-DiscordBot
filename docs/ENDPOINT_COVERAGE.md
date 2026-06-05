# Endpoint → GUI / Test Coverage Map (AUD-006)

> **Generated** by `scripts/audit_endpoint_coverage.mjs`. Do not edit by hand —
> run `node scripts/audit_endpoint_coverage.mjs` to regenerate. `npm run preflight`
> fails (the `coverage` stage) when this file drifts from the code.
>
> Columns: HTTP method · route path · auth mode (`token` = `X-SeekDeep-Token`
> required via decorator; `token*` = gated manually inside the handler — `?token=`
> for EventSource/WebSocket, or the per-file sensitive allowlist on `/data/{file}`;
> `open` = no token) · first GUI file that references the path · whether a test
> suite (`e2e/`, `scripts/smoke_gui_endpoints.py`, `scripts/dev/verify_e2e.py`)
> references it. `—` / `no` are drift signals, not necessarily bugs (some routes
> are tray-only or future-facing); investigate before assuming coverage.

## gui_endpoints.py (70 routes)

| Method | Path | Auth | First GUI caller | Tested |
|---|---|---|---|---|
| GET | `/archive/config` | open | app.html | yes |
| POST | `/archive/config` | token | app.html | yes |
| POST | `/cache/prune` | token | api.html | no |
| GET | `/config` | open | app.html | yes |
| POST | `/config` | token | app.html | yes |
| GET | `/config/features` | open | docs.html | no |
| POST | `/config/reload` | token | launcher.js | no |
| GET | `/config/schema` | open | app.html | no |
| GET | `/config/status` | open | nav.js | yes |
| GET | `/data/{file}` | token* | app.html | yes |
| POST | `/deps/install` | token | fix-action.js | yes |
| POST | `/docker/start-searxng` | token | installer.html | yes |
| GET | `/emoji-vault/{guild_id}/backup.zip` | token | — | yes |
| GET | `/emoji-vault/{guild_id}/emojis` | token | — | yes |
| GET | `/emoji-vault/guilds` | token | emoji-vault.js | yes |
| WEBSOCKET | `/events` | token* | events.js | no |
| POST | `/events/emit` | token | — | yes |
| GET | `/events/status` | open | — | yes |
| POST | `/launcher/{service}/{action}` | token | app.html | yes |
| POST | `/launcher/bot/kill-all` | token | nav.js | yes |
| GET | `/launchers/status` | open | api.html | yes |
| GET | `/logs/stream` | token* | app.html | no |
| GET | `/logs/tail` | token | — | no |
| GET | `/memory/presets/{user_id}` | token | — | yes |
| POST | `/memory/presets/{user_id}` | token | — | yes |
| DELETE | `/memory/user/{user_id}` | token | — | yes |
| GET | `/memory/user/{user_id}` | token | — | yes |
| GET | `/memory/user/{user_id}/export` | token | — | yes |
| POST | `/memory/user/{user_id}/fact` | token | — | yes |
| DELETE | `/memory/user/{user_id}/fact/{n}` | token | — | yes |
| PATCH | `/memory/user/{user_id}/fact/{n}` | token | — | yes |
| GET | `/memory/users` | token | api.html | yes |
| POST | `/model/warm` | token | app.html | yes |
| GET | `/persona` | open | api.html | yes |
| POST | `/persona` | token | api.html | yes |
| GET | `/personas` | open | personas.html | yes |
| POST | `/personas` | token | personas.html | yes |
| DELETE | `/personas/{slug}` | token | — | yes |
| GET | `/prompts/channels` | open | prompts.html | no |
| POST | `/prompts/template` | token | prompts.html | yes |
| DELETE | `/prompts/template/{template_id:path}` | token | — | yes |
| POST | `/reacts/builtin/{key}` | token | — | yes |
| POST | `/reacts/rule` | token | app.html | yes |
| DELETE | `/reacts/rule/{rule_id}` | token | — | yes |
| PATCH | `/reacts/rule/{rule_id}` | token | — | yes |
| GET | `/stats/counts` | open | stats.js | yes |
| GET | `/stats/snapshot` | open | api.html | yes |
| POST | `/system/bootstrap` | token | installer.html | no |
| GET | `/system/bootstrap-status` | open | installer.html | no |
| GET | `/system/detect-venv` | open | — | yes |
| GET | `/system/docker` | open | installer.html | yes |
| POST | `/system/doctor` | token | installer.html | no |
| GET | `/system/firstrun` | open | app.html | yes |
| POST | `/system/install-docker` | token | — | yes |
| POST | `/system/install-ollama` | token | — | no |
| POST | `/system/install-python` | token | — | yes |
| POST | `/system/kill-all` | token | launcher.js | no |
| POST | `/system/launch-all` | token | installer.html | no |
| POST | `/system/lock-cache` | token | installer.html | no |
| POST | `/system/ollama-signin` | token | installer.html | no |
| GET | `/system/ollama-status` | open | installer.html | no |
| POST | `/system/reinstall-torch` | token | — | no |
| GET | `/system/runtime` | open | installer.html | yes |
| POST | `/system/self-update` | token | launcher.js | yes |
| POST | `/system/smoke` | token | launcher.js | no |
| POST | `/system/start-ollama` | token | — | no |
| POST | `/system/use-venv` | token | — | yes |
| POST | `/system/verify` | token | launcher.js | no |
| POST | `/system/warmup` | token | installer.html | no |
| GET | `/token` | open | nav.js | yes |

## local_ai_server.py (23 routes)

| Method | Path | Auth | First GUI caller | Tested |
|---|---|---|---|---|
| POST | `/chart` | token | api.html | yes |
| POST | `/chat` | token | api.html | yes |
| GET | `/gpu` | open | api.html | yes |
| GET | `/health` | open | add-model.html | yes |
| POST | `/image` | token | api.html | yes |
| POST | `/img2img` | token | api.html | yes |
| POST | `/inpaint` | token | api.html | yes |
| POST | `/inpaint_mask_preview` | token | image-ab.html | yes |
| POST | `/instruct-pix2pix` | token | api.html | yes |
| GET | `/ml_deps` | open | ml-deps.js | yes |
| POST | `/model/install` | token | add-model.html | yes |
| POST | `/model/uninstall` | token | app.html | yes |
| GET | `/models/available` | open | app.html | no |
| GET | `/models/catalog` | open | installer.html | no |
| GET | `/models/installed` | open | app.html | yes |
| GET | `/route/debug` | open | api.html | yes |
| POST | `/unload` | token | api.html | yes |
| POST | `/upscale` | token | api.html | yes |
| POST | `/vision` | token | api.html | yes |
| GET | `/vram` | open | — | no |
| POST | `/warmup/chat` | token | — | yes |
| POST | `/warmup/image` | token | — | yes |
| POST | `/warmup/vision` | token | — | yes |

## Summary

- Total routes: **93**
- Open (no token): **27**
- Not referenced by any test suite: **25**

