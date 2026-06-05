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

## GUI Control Plane — Token Gating

Every **mutating** GUI endpoint on the local AI server (config writes, launcher start/stop/kill, `/system/self-update`, `/model/install` + `/model/uninstall`, persona/archive/memory writes, etc.) is guarded by a per-install token via the `require_gui_token` FastAPI dependency (`gui_endpoints.py`). Callers must send the secret as the `X-SeekDeep-Token` header; a missing or wrong token returns `401`.

- The token lives in `.env` as `SEEKDEEP_GUI_TOKEN` (auto-generated on first run if absent). The GUI fetches it via `GET /token`, which only answers loopback callers.
- Read-only diagnostics that don't expose secrets stay unauthenticated (e.g. `/health`; `GET /config` returns a redacted env map with token/key/secret values masked to `*****`).
- Sensitive reads — the log tail (`/logs/tail`) and the sensitive data files — are token-gated, not unauthenticated.
- `SEEKDEEP_GUI_TOKEN_DISABLED=1` removes the gate for local development only — never set it on an exposed install.

## Desktop Shell (Tauri) Bridge (AUD-003)

The Tauri desktop shell exposes a small set of `#[tauri::command]` functions to the bundled GUI. The `open_external` command — which opens a frontend-supplied URL in the system browser — is allowlisted (`open_external_url_allowed` in `src-tauri/src/lib.rs`): only `https://` to a short product host list (github, discord, python.org, huggingface, pytorch, ollama, docker, nvidia) plus the first-party `discord://` deep-link are opened; `http:`, `file:`, `javascript:`, `data:`, and other custom schemes are refused. This keeps a hypothetical GUI XSS from turning the bridge into an arbitrary-URL / local-protocol-handler opener. Unit tests cover the allow/deny cases (`open_external_tests`).

The WebView CSP has been tightened: `'unsafe-eval'` is dropped (verified unused), the monolithic `default-src` is split into explicit directives, and `script-src` is scoped to `'self'` — `'unsafe-inline'` was removed (v10.38.63), and there are no arbitrary `https:` script origins. The desktop policy lives in `src-tauri/tauri.conf.json` (`app.security.csp`, with `dangerousDisableAssetCspModification` set to `["script-src", "style-src"]` so Tauri's asset-protocol rewriting doesn't override those two directives). The browser path — the GUI served over loopback at `/gui/*` — mirrors the same policy: `local_ai_server.py` emits an equivalent `Content-Security-Policy` header (`_SEEKDEEP_GUI_CSP`) plus `X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` on every HTML response. The Discord Activity sub-app (`gui/activity/*`) is intentionally **exempt** from the anti-framing header and the strict CSP — it runs inside Discord's own iframe and loads its SDK cross-origin. A regression harness (`e2e/csp.spec.mjs`) injects the shipped CSP onto every top-level GUI page and asserts zero violations, in `npm run test:e2e` + CI.

`'unsafe-inline'` has since been **dropped from `script-src`** (v10.38.63): all inline `<script>` blocks were externalized and all inline `on*=` handlers converted to delegated `addEventListener` (PRs #82–#90), including the Discord Activity page so the global Tauri WebView CSP doesn't break DATA DASH in the desktop app. `style-src` retains `'unsafe-inline'` by design (pervasive inline `style=`, low risk). `withGlobalTauri` is still on.

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

## Self-Update Trust Boundary (AUD-001)

`POST /system/self-update` is the highest-authority local action: it overwrites the running Python/GUI/script files from a GitHub ref. It is token-gated, and it stages every file, verifies each against the GitHub git-blob SHA for that ref, and only then move-replaces into the live tree (mid-batch failure leaves the tree untouched). On top of that:

- **Ref policy** — `SEEKDEEP_SELF_UPDATE_REF_POLICY=strict` (default) accepts only an immutable release tag (`vMAJOR.MINOR.PATCH[-pre]`) or a full 40-char commit SHA. Mutable `main` and short SHAs are refused. Set `SEEKDEEP_SELF_UPDATE_ALLOW_MAIN=on` to allow `main` under strict, or `…REF_POLICY=loose` to allow both.
- **Concurrency** — a module-level lock makes the route single-flight; a second concurrent request returns `409` instead of racing two commits over the same tree.
- **Bounded reads** — file fetches are capped at `SEEKDEEP_SELF_UPDATE_MAX_FILE_BYTES` (25 MiB) and API listings at `SEEKDEEP_SELF_UPDATE_MAX_API_BYTES` (8 MiB), so a garbled/oversized response fails that file instead of exhausting memory.
- **Kill switch** — `SEEKDEEP_SELF_UPDATE_ENABLED=off` refuses the route entirely (`403`) for installs that should only update via the signed MSI.
- **Release signature (AUD-001 follow-up)** — the git-SHA integrity check proves the bytes match GitHub's published tree for the ref; it does **not** by itself defend a compromised repo (malicious code would have a valid git SHA). When a release-signing public key is pinned (`release_signing.RELEASE_SIGNING_PUBKEY_HEX`), the server verifies a maintainer **Ed25519 signature** over a `release-manifest.json` (whose sha256s must match the staged files) before committing. A present-but-invalid signature is **always** refused; `SEEKDEEP_SELF_UPDATE_REQUIRE_SIGNATURE=on` additionally refuses *unsigned* releases. The private key is generated and held **offline** (never in the repo or CI), so a GitHub account compromise can't forge an installable release. Pure-Python Ed25519 (vendored, RFC 8032 test-vector-pinned) — no paid CA, no extra dependency. Full workflow: [RELEASE_SIGNING.md](RELEASE_SIGNING.md).
- The signature defends repo/account compromise; it does not replace OS-level **installer** signing (SmartScreen/Gatekeeper), a separate optional concern.

## Feature Flags As Attack-Surface Management

`SEEKDEEP_FEATURE_*` env vars default to `off`. The default-off list is deliberate:

- `SEEKDEEP_FEATURE_EMOJI_VAULT` — handler short-circuits before fetching any guild emoji or touching threads.
- `SEEKDEEP_FEATURE_FORCE_REACT` — context-menu entry is omitted from command registration, the dispatcher refuses the route, and any stale picker UI tears down with a "currently disabled" notice.
- `SEEKDEEP_FEATURE_IMG2IMG` — off by default; opt in with `SEEKDEEP_FEATURE_IMG2IMG=on`. Reuses the existing Dreamshaper-XL pipeline (no extra model download). The handler short-circuits when the flag is off (the code default in `index.js` is `off`).
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
