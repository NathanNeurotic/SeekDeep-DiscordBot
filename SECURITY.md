# Security Policy

SeekDeep is intended to run as a local Discord bot backed by local model services. Protect the host machine, Discord bot token, archive data, generated images, and local model cache.

## Supported Versions

This local project follows the active working tree. Keep the local stack updated and rerun smoke tests after changes.

## Secrets

- Keep `.env` private. It contains the live Discord token and any HuggingFace / DeepSeek / NGC keys.
- `.env` is in `.gitignore`. `.env.default` is committed as a template.
- Do not commit or publish Discord tokens.
- Do not paste secrets into Discord messages for testing.
- Treat `keys.txt`, local logs under `logs/`, archive thread configs under `data/`, and emoji-vault ZIP exports as sensitive until inspected.
- The file logger (`SEEKDEEP_FILE_LOGGING=on`) redacts `hf_*`, `sk-*`, and Discord-token-shaped strings before writing to `logs/seekdeep-YYYY-MM-DD.log`. Spot-check before sharing logs.

## Local Services

By default, SeekDeep expects local services on loopback:

- Local AI server: `http://127.0.0.1:7865`
- SearXNG: `http://127.0.0.1:8080`

Do not expose these ports publicly unless you have added authentication, firewall rules, and a clear deployment plan.

## Discord Permissions

Use the minimum Discord bot permissions needed for:

- Reading message content where enabled
- Sending messages
- Uploading attachments
- Creating and managing archive threads in configured archive channels
- Handling slash commands and component interactions

Archive setup should stay restricted to Discord server admins, users with Manage Server, users with Manage Channels, or configured SeekDeep admins.

## Attack Surface — User-Supplied URLs

User-attached files (vision uploads, reactrule import JSON, emoji vault import JSON/ZIP) are fetched via `seekdeepFetchWithLimits(url, { timeoutMs, maxBytes })` rather than raw `fetch`. The helper enforces:

- A configurable timeout via `AbortController` (`SEEKDEEP_FETCH_DEFAULT_TIMEOUT_MS`, 30s default).
- A `Content-Length` precheck against `SEEKDEEP_FETCH_DEFAULT_MAX_BYTES` (50 MB default).
- Per-callsite overrides (vision: 60s no cap; reactrule import: 15s / 1 MB; emoji vault import: 60s / 32 MB).
- **SSRF policy (AUD-002):** before any request goes out, `seekdeepValidateFetchTarget(url)` rejects non-`http(s)` schemes and resolves the host, blocking loopback, `0.0.0.0`/`::`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), IPv6 unique-local (`fc00::/7`), multicast, and cloud-metadata endpoints (`169.254.169.254`, `metadata.google.internal`, etc.). Redirects are followed **manually** so every hop is re-validated — a public URL that 302s to `127.0.0.1` or the metadata IP is refused before its body is read. The default is fail-closed; `SEEKDEEP_FETCH_ALLOW_PRIVATE=on` opts a trusted single-user LAN install back into private targets (cloud-metadata + unspecified stay blocked regardless). Residual risk: a DNS-rebinding answer that differs between this lookup and the kernel's connect-time lookup is not fully closed (would require IP-pinned connections); the resolve-and-check stops the realistic URL→localhost / URL→metadata cases.

When adding a new feature that fetches a user-supplied URL, use this helper. Do not fall back to bare `await fetch(url)`. For deliberate internal/loopback calls (local AI server, SearXNG), use `fetchJson` or pass `{ allowPrivate: true }` explicitly — never route a user-controlled URL through the private path.

## Feature Flags As Attack-Surface Management

`SEEKDEEP_FEATURE_*` env vars default to `off`. The default-off list is deliberate:

- `SEEKDEEP_FEATURE_EMOJI_VAULT` — handler short-circuits before fetching any guild emoji or touching threads.
- `SEEKDEEP_FEATURE_FORCE_REACT` — context-menu entry is omitted from command registration, the dispatcher refuses the route, and any stale picker UI tears down with a "currently disabled" notice.
- `SEEKDEEP_FEATURE_IMG2IMG` — on by default since v10.25; reuses the existing Dreamshaper-XL pipeline (no extra model download). The handler short-circuits when the flag is off.
- `SEEKDEEP_FEATURE_UPSCALE_REALESRGAN` / `SEEKDEEP_FEATURE_NSFW_GATE` / `SEEKDEEP_FEATURE_TTS_VOICE` — scaffolds only; require additional model downloads and Python endpoints to activate.

Audit each feature flag's surface before flipping it on in a production server.

## Dependency And Model Safety

- Review dependency updates before applying them.
- Run `npm run preflight` after any dependency bump to confirm nothing regresses.
- Use `npm audit` and Python security tooling when preparing a public release.
- Keep Docker Desktop and SearXNG images updated.
- Download models from known model IDs and keep the cache under `./models/huggingface`.
- Use the offline cache lock scripts after the required models are downloaded and verified.
- Optionally pin models to specific commits via `<ENV_VAR>_REVISION` so silent upstream updates don't change behavior. See README "Online setup phase" for examples.

## Reporting Issues

For this local workspace, report security-sensitive issues directly to the project owner through a private channel. Do not post tokens, logs with secrets, or exploit details in public Discord channels.

When documenting a security issue, include:

- Affected command or component
- Exact local reproduction steps
- Relevant sanitized logs
- Whether the issue exposes tokens, files, generated content, archive data, or local services
