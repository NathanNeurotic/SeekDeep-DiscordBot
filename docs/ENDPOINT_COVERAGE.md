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

## gui_endpoints.py (78 routes)

| Method | Path | Auth | First GUI caller | Tested |
|---|---|---|---|---|
| GET | `/archive/config` | open | app.page1.js | yes |
| POST | `/archive/config` | token | app.page1.js | yes |
| POST | `/bot/command` | token | bot-bridge.js | yes |
| POST | `/cache/prune` | token | api.page.js | no |
| GET | `/config` | open | app.page2.js | yes |
| POST | `/config` | token | app.page2.js | yes |
| GET | `/config/features` | open | bot-bridge.js | no |
| POST | `/config/reload` | token | launcher.js | no |
| GET | `/config/schema` | open | app.page2.js | no |
| GET | `/config/status` | open | nav.js | yes |
| GET | `/data/{file}` | token* | app.page1.js | yes |
| POST | `/deps/install` | token | fix-action.js | yes |
| POST | `/docker/start-searxng` | token | installer.page4.js | yes |
| GET | `/emoji-vault/{guild_id}/backup.zip` | token | — | yes |
| GET | `/emoji-vault/{guild_id}/emojis` | token | — | yes |
| DELETE | `/emoji-vault/{guild_id}/emojis/{emoji_id}` | token | — | yes |
| POST | `/emoji-vault/{guild_id}/import` | token | — | yes |
| GET | `/emoji-vault/guilds` | token | emoji-vault.js | yes |
| WEBSOCKET | `/events` | token* | events.js | no |
| POST | `/events/emit` | token | — | yes |
| GET | `/events/status` | open | bot-bridge.js | yes |
| GET | `/force-react/{guild_id}/config` | token | — | yes |
| POST | `/force-react/{guild_id}/config` | token | — | yes |
| GET | `/force-react/{guild_id}/emojis` | token | — | yes |
| GET | `/force-react/guilds` | token | force-react.js | yes |
| POST | `/launcher/{service}/{action}` | token | app.page5.js | yes |
| POST | `/launcher/bot/kill-all` | token | nav.js | yes |
| GET | `/launchers/status` | open | api.page.js | yes |
| GET | `/logs/stream` | token* | app.page2.js | no |
| GET | `/logs/tail` | token | — | no |
| GET | `/memory/presets/{user_id}` | token | — | yes |
| POST | `/memory/presets/{user_id}` | token | — | yes |
| DELETE | `/memory/user/{user_id}` | token | — | yes |
| GET | `/memory/user/{user_id}` | token | — | yes |
| GET | `/memory/user/{user_id}/export` | token | — | yes |
| POST | `/memory/user/{user_id}/fact` | token | — | yes |
| DELETE | `/memory/user/{user_id}/fact/{n}` | token | — | yes |
| PATCH | `/memory/user/{user_id}/fact/{n}` | token | — | yes |
| GET | `/memory/users` | token | api.page.js | yes |
| POST | `/model/warm` | token | app.page1.js | yes |
| GET | `/persona` | open | api.page.js | yes |
| POST | `/persona` | token | api.page.js | yes |
| GET | `/personas` | open | personas.page.js | yes |
| POST | `/personas` | token | personas.page.js | yes |
| DELETE | `/personas/{slug}` | token | — | yes |
| GET | `/prompts/channels` | open | prompts.page.js | no |
| POST | `/prompts/template` | token | prompts.page.js | yes |
| DELETE | `/prompts/template/{template_id:path}` | token | — | yes |
| POST | `/reacts/builtin/{key}` | token | — | yes |
| POST | `/reacts/rule` | token | app.page1.js | yes |
| DELETE | `/reacts/rule/{rule_id}` | token | — | yes |
| PATCH | `/reacts/rule/{rule_id}` | token | — | yes |
| POST | `/save-file` | token | nav.js | yes |
| GET | `/stats/counts` | open | stats.js | yes |
| GET | `/stats/snapshot` | open | api.page.js | yes |
| POST | `/system/bootstrap` | token | installer.page2.js | no |
| GET | `/system/bootstrap-status` | open | installer.page2.js | no |
| GET | `/system/detect-venv` | open | — | yes |
| GET | `/system/docker` | open | installer.page7.js | yes |
| POST | `/system/doctor` | token | installer.page1.js | no |
| GET | `/system/firstrun` | open | app.page2.js | yes |
| POST | `/system/install-docker` | token | — | yes |
| POST | `/system/install-ollama` | token | — | no |
| POST | `/system/install-python` | token | — | yes |
| POST | `/system/kill-all` | token | launcher.js | no |
| POST | `/system/launch-all` | token | installer.page6.js | no |
| POST | `/system/lock-cache` | token | installer.page5.js | no |
| POST | `/system/ollama-signin` | token | installer.page3.js | no |
| GET | `/system/ollama-status` | open | installer.page3.js | no |
| POST | `/system/reinstall-torch` | token | — | no |
| GET | `/system/runtime` | open | installer.page7.js | yes |
| POST | `/system/self-update` | token | launcher.js | yes |
| POST | `/system/smoke` | token | launcher.js | no |
| POST | `/system/start-ollama` | token | — | no |
| POST | `/system/use-venv` | token | — | yes |
| POST | `/system/verify` | token | launcher.js | no |
| POST | `/system/warmup` | token | installer.page5.js | no |
| GET | `/token` | open | nav.js | yes |

## local_ai_server.py (27 routes)

| Method | Path | Auth | First GUI caller | Tested |
|---|---|---|---|---|
| POST | `/chart` | token | api.page.js | yes |
| POST | `/chat` | token | api.page.js | yes |
| GET | `/gpu` | open | api.page.js | yes |
| GET | `/health` | open | add-model.page.js | yes |
| POST | `/image` | token | api.page.js | yes |
| POST | `/img2img` | token | api.page.js | yes |
| POST | `/inpaint` | token | api.page.js | yes |
| POST | `/inpaint_mask_preview` | token | image-ab.page.js | yes |
| POST | `/instruct-pix2pix` | token | api.page.js | yes |
| GET | `/ml_deps` | open | ml-deps.js | yes |
| POST | `/model/install` | token | add-model.page.js | yes |
| POST | `/model/uninstall` | token | app.page4.js | yes |
| GET | `/models/available` | open | app.page4.js | no |
| GET | `/models/catalog` | open | installer.page7.js | no |
| GET | `/models/installed` | open | app.page4.js | yes |
| GET | `/route/debug` | open | api.page.js | yes |
| POST | `/tts` | token | tts.js | yes |
| POST | `/tts/engine/install` | token | tts.js | no |
| GET | `/tts/voices` | open | tts.js | no |
| POST | `/tts/voices/download` | token | tts.js | no |
| POST | `/unload` | token | api.page.js | yes |
| POST | `/upscale` | token | api.page.js | yes |
| POST | `/vision` | token | api.page.js | yes |
| GET | `/vram` | open | — | no |
| POST | `/warmup/chat` | token | — | yes |
| POST | `/warmup/image` | token | — | yes |
| POST | `/warmup/vision` | token | — | yes |

## Summary

- Total routes: **105**
- Open (no token): **28**
- Not referenced by any test suite: **28**

