# Security Policy

SeekDeep is intended to run as a local Discord bot backed by local model services. Protect the host machine, Discord bot token, archive data, generated images, and local model cache.

## Supported Versions

This local project follows the active working tree. Keep the local stack updated and rerun smoke tests after changes.

## Secrets

- Keep `.env` private.
- Do not commit or publish Discord tokens.
- Do not paste secrets into Discord messages for testing.
- Treat `keys.txt`, local logs, and config exports as sensitive until inspected.

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

## Dependency And Model Safety

- Review dependency updates before applying them.
- Use `npm audit` and Python security tooling when preparing a public release.
- Keep Docker Desktop and SearXNG images updated.
- Download models from known model IDs and keep the cache under `./models/huggingface`.
- Use the offline cache lock scripts after the required models are downloaded and verified.

## Reporting Issues

For this local workspace, report security-sensitive issues directly to the project owner through a private channel. Do not post tokens, logs with secrets, or exploit details in public Discord channels.

When documenting a security issue, include:

- Affected command or component
- Exact local reproduction steps
- Relevant sanitized logs
- Whether the issue exposes tokens, files, generated content, archive data, or local services
