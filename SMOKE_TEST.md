# SeekDeep Smoke Test

Run after the v10.0-baseline commit + the recent batch of fixes to verify nothing regressed. Each step has an explicit pass criterion.

## 0. Pre-flight

- [ ] `node --check index.js` exits clean
- [ ] `.\.venv\Scripts\python.exe -m py_compile local_ai_server.py warmup_local_cache.py` exits clean
- [ ] `git status` shows the expected uncommitted state
- [ ] `npm run audit:model-cache` — all four chat-role models + vision + image marked `cached`
- [ ] `.env` has `HF_LOCAL_FILES_ONLY=true` (or you're knowingly in online mode)

## 1. Cold launch

- [ ] `.\seekdeep_launcher.bat` → option 8 launches SearXNG + local AI server + bot with no errors
- [ ] Bot console shows `Logged in as SeekDeep#...`
- [ ] `logs/seekdeep-YYYY-MM-DD.log` appears in the project folder
- [ ] Bot console shows `[SeekDeep] file logging enabled -> logs/seekdeep-...`

## 2. `/status`

- [ ] `@SeekDeep status` returns the full status block
- [ ] Block contains `Chat quantization: 4bit`
- [ ] Block contains `Loaded chat role: none` (before any chat)
- [ ] Block contains `Chat roles:` mapping with all 5 roles → model IDs
- [ ] Block contains `Recent chat-role loads:` (empty until something loads)

## 3. `/help`

- [ ] `@SeekDeep help` returns the command map
- [ ] Includes a "Chat Model Roles (automatic)" section
- [ ] Includes "Natural-language archive of the most recent image"
- [ ] Includes "Right-click message context menu" with all 5 commands
- [ ] Includes `/recent kind:images|prompts|archive`

## 4. Chat routing

- [ ] `@SeekDeep hi` → reply via `default_chat` (Qwen3-8B). Footer shows `Model Used: Qwen/Qwen3-8B`.
- [ ] `@SeekDeep compare iOS vs Android with pros and cons` → routes to `quality_text` (Mistral-Nemo). Footer shows the Mistral model. Web sources cited.
- [ ] `@SeekDeep debug this stack trace: NameError: name 'foo' is not defined` → routes to `reasoning_code` (Phi-4). Footer shows phi-4.
- [ ] `@SeekDeep tell me about KK Slider` → routes to `quality_text` (proper-noun lookup detector) AND auto-searches web.
- [ ] Each chat shows the bot "typing..." indicator while generating.

## 5. Image generation

- [ ] `@SeekDeep draw a brass lantern in a foggy forest` → image queues, Original + Refined buttons appear.
- [ ] Click **Original** → image generates without re-running prompt refinement.
- [ ] Click **Refined** → image generates with refined prompt.
- [ ] Quickly click **Refined** again on the same prompt → console does NOT show another `image prompt refined: ...` line (cache reused).
- [ ] `@SeekDeep i need a red glass apple` → routes to image (natural-language detector).
- [ ] `@SeekDeep can you please generate an image of him` (after a prior context image) → routes to image, not chat.
- [ ] `@SeekDeep draw KK Slider` → image of a white dog with black eye markings + guitar (franchise grounding override).
- [ ] `@SeekDeep draw Pikachu` → recognizable Pikachu (franchise grounding).

## 6. Vision

- [ ] Reply to an image with `@SeekDeep what is this?` → vision route. Footer shows `Qwen/Qwen2.5-VL-3B-Instruct`.
- [ ] Reply to a **forwarded** image → still routes to vision (forward-snapshot resolver).
- [ ] Vision response does NOT start with "This image depicts ..." boilerplate.
- [ ] Follow up with `@SeekDeep tell me about him` → chat picks up the vision context (memory tagged `[vision-description]`) and answers grounded in what the image showed.

## 7. Archive — buttons

- [ ] Generate an image. Click **Archive** → ephemeral confirmation. New entry posted to your archive thread.
- [ ] Archive thread entry has Download (link button) + grey Delete from Archive button.
- [ ] Click **Shared Archive** on another image → entry posts to the shared thread. Count increments to actual entry count.
- [ ] Manually delete one shared archive entry → on next archive, count reflects actual (Math.max removed).

## 8. Archive — natural language

- [ ] After generating an image, `@SeekDeep archive this` → archives it to your personal thread.
- [ ] `@SeekDeep share this` → archives it to shared thread.
- [ ] `@SeekDeep archive too` → archives most recent image.
- [ ] `/recent kind:archive` → lists newest 10 entries in your archive thread.
- [ ] `@SeekDeep archive me` → opens the archive thread link.

## 9. Right-click context menu

- [ ] Right-click any text message → Apps → **Inspect (SeekDeep)** → ephemeral debug card appears.
- [ ] Right-click a chat message → **Generate Image from this** → posts a queued image generation.
- [ ] Right-click a chat message that says "hi" → **Refine as Image Prompt** → refuses with guidance.
- [ ] Right-click any non-English / slang message → **Translate (SeekDeep)** → returns plain-English translation only.
- [ ] Right-click any message → **Compare with previous** → returns a structured comparison vs the prior non-bot message.

## 10. Frustration / edge cases

- [ ] `@SeekDeep generate me` then reply with `FUCK` → bot does NOT generate an image titled FUCK. Pending request stays alive.
- [ ] Paste the help text into Discord with multiple @SeekDeep mentions inside `> ` quoted blocks → bot ignores quoted mentions; counts only your real mention.
- [ ] Send a message with two genuine @SeekDeep mentions → bot fires the warning **once** and stops (no chat reply afterwards).
- [ ] `/refine prompt:i mean fuck you` → bot refuses without calling the chat model.

## 11. Fallback / OOM behavior

- [ ] If a role's model OOMs at load: chat still succeeds via `fallback_chat`. Reply footer adds a line `Fallback used: role=... reason=cuda-oom`.
- [ ] `/status` "Recent chat-role loads:" shows the failed role + the fallback role in order.

## 12. File logging

- [ ] After running the bot for a few minutes: `Get-Content -Tail 40 logs\seekdeep-*.log`
- [ ] Lines are timestamped `[2026-...] [log] ...` / `[warn]` / `[error]`.
- [ ] No `hf_*`, `sk-*`, or Discord token strings appear in the log file (redaction).

## 13. Shutdown / restart

- [ ] Stop the bot (Ctrl+C in launcher) → no unhandled rejection on exit.
- [ ] Restart via option 8 again → clean startup, no stale state errors.

## What "pass" means

All boxes checked = the v10.x feature set is solid. Any failure: capture the exact prompt + bot console line and report. The bot console + the new `logs/` file usually pinpoint where things diverged from expected routing.

## Known-limitation reminders

- Mistral-Nemo and Phi-4 only fit at 4-bit on a 24GB GPU. If `LOCAL_CHAT_QUANT=none`, they'll OOM and silently fall back to Granite. Keep `LOCAL_CHAT_QUANT=4bit` unless you've changed hardware.
- Lightweight Gemma 3n model (optional `lightweight_chat`) uses a multimodal loader that may not match `AutoModelForCausalLM`. It is excluded from default warmup; only `--include-optional` pulls it.
- Discord context menu commands take up to ~1 hour to propagate globally after registration. If they don't appear, re-register or wait.
