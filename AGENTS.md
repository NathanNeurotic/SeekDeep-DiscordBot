# Agents & Internal Components

> **Sister docs:**
> - **[README.md](README.md)** — user-facing install / commands / feature flags.
> - **[CODEX_REPO_BRIEF.md](CODEX_REPO_BRIEF.md)** — onboarding brief for an AI assistant. Repo shape, routing, gotchas, common edits.
> - **[INTEGRATION.md](INTEGRATION.md)** — GUI ↔ FastAPI wiring.
>
> This file is the **architecture canonical**: what each subsystem does and where the key entry points live. Update this in the same change as the code edit.

SeekDeep is a single-file Node bot (`index.js`, ~24k lines as of v10.35.47) plus a Python FastAPI local AI server (`local_ai_server.py`, ~5.7k lines) and a GUI/control-center backend (`gui_endpoints.py`, ~6.4k lines). The Node side organizes its work into named "agents" that share top-level state through hoisted helper functions. A few leaf modules now live alongside `index.js` — notably [`lib/url-fetch-policy.js`](lib/url-fetch-policy.js) (the user-URL SSRF fetch policy, imported by `index.js`) and [`release_signing.py`](release_signing.py) (Ed25519 self-update signature verification). This document maps each subsystem to the key entry points so future edits don't have to grep blind.

Function names are stable enough to grep for. If you find a stale reference here while reading the code, please update this file in the same change.

## Discord Event Pipeline

The bot listens for three Discord events: `messageCreate`, `interactionCreate`, and `messageReactionAdd`. After v10.9 the messageCreate handler is a thin 112-line orchestrator that delegates to:

- `seekdeepProcessPreAddressMessageRoutes(message)` — pre-mention routes (archive config, status, search, persona, memory presets, stats, digest, translate channel, reactrule, emoji vault, natural-archive followups, img2img, upscale, templates). Returns `true` if a route handled the message.
- `seekdeepDispatchAddressedMessage(message, ctx)` — the addressed-message dispatcher. Runs after the bot mention is detected and the prompt has been normalized + deduped. Houses the ~370-line route cascade (reply-translate, chat-ask, image alias, pending image subject, vision, raw-image, research-table, chat fallback).

The handler also wires:

- `seekdeepClaimEventOnce(key)` — message-level dedupe.
- `seekdeepIsChannelAllowed(channelId)` — `SEEKDEEP_ALLOWED_CHANNELS` allowlist gate.
- `seekdeepApplyAutoReactions(message)` — fire-and-forget auto-reaction pass.
- `seekdeepAutoTranslateMessage(message)` — fire-and-forget auto-translate for non-Latin messages in the designated channel.

## Chat Agent

**Purpose**: Conversational queries via the role-routed local chat model.

**Key Functions**:
- `askChat(prompt, options)` — main entry. Resolves chat role (including `purpose: "image_refinement"`), builds prompt with memory/reply context, calls the FastAPI `/chat` endpoint, post-processes the reply.
- `shouldAutoSearch(prompt)` — keyword + regex cascade deciding whether SearXNG should run first (200 lines of inline data arrays — intentional, see v10.10 audit notes).
- `seekdeepResolveChatRoleForPrompt(prompt, opts)` — selects `default_chat` / `quality_text` / `reasoning_code` / `fallback_chat` / `lightweight_chat` from prompt content.
- `seekdeepBuildSystemPrompt(personaOverride, extra)` — composes the persona + user-preset system prompt.
- `memoryKeyFrom(source)`, `remember(key, role, value)`, `getRecentContext(key)`, `shouldUseMemory(prompt)`, `buildPromptWithMemory(prompt, key)` — rolling chat memory.
- `cleanLoopingReply(text)`, `stripQwenThinkingBlocks(text)` — anti-loop + Qwen `<think>...</think>` removal.

## Vision Agent

**Purpose**: Analyze images/videos via the local vision model.

**Key Functions**:
- `askVision(attachment, prompt, { systemHint })` — downloads the attachment via `seekdeepFetchWithLimits`, base64-encodes, POSTs `/vision`. OCR mode passes `SEEKDEEP_OCR_SYSTEM_PROMPT` as `systemHint`.
- `seekdeepLooksLikeVisionPrompt(prompt)` — detects vision-style prompts ("what is this", "describe this image", etc.).
- `seekdeepLooksLikeVisualAttachment(attachment)` — checks contentType + filename/URL extension against image/video patterns (handles `avif/tiff/m4v` and `proxyURL`).
- `firstVisualAttachmentFrom(sourceMessage)` — walks direct attachments + `messageSnapshots` (forwarded messages) + embed image URLs (link previews) to find the first visual.
- `fetchRepliedMessage(message)` — fetches the replied-to message via `message.fetchReference()`.
- `seekdeepGetReplyVisualAttachment(message)` — convenience wrapper: `fetchRepliedMessage` + `firstVisualAttachmentFrom`.
- `seekdeepRememberRecentVisionTarget` / `seekdeepConsumeRecentVisionTarget` — cache the attachment URL so a follow-up ("tell me more about this image") can re-run vision without re-uploading.

## Image Agent

**Purpose**: SDXL generation with prompt refinement, queueing, and cooldown management.

**Key Functions**:
- `seekdeepSendImageWithButtons(target, prompt, w, h, seed, opts)` — unified message- and interaction-shaped image send. Resolves prompt context, gates on cooldown, queues a job, awaits result, posts with `Original/Refined/RE-REFINE/Both/Download/Archive/Shared Archive` button rows.
- `seekdeepSendImagePromptChoice(target, prompt, w, h, seed, opts)` — "preparing... → Original / Refined / Both" choice flow before queueing.
- `makeImageResult(prompt, w, h, seed, options)` — calls `/image`, returns `{ buffer, refinedPrompt, grounding, imageOptions }`.
- `seekdeepEnqueueImageJob(job, runner)` — FIFO queue with admin-priority insertion.
- `seekdeepImageCooldownRemaining(userId)` / `seekdeepRememberImageCooldown(userId)` — per-user cooldown TTLs (`SEEKDEEP_IMAGE_COOLDOWN_MS`).
- `seekdeepBuildImagePromptChoice(prompt, options)` — dynamic AI-refined prompt with static-cleanup fallback.
- `seekdeepImageModeOptionsFromPrompt(prompt)` — parses `raw`, `unrefined`, `--raw`, `no refine`, ground/refine toggles.
- `seekdeepRegenerateModeOptions(mode, state)` — maps button/text regenerate modes, including `rerefine` / `RE-REFINE` which bypasses the refined-prompt cache and preserves original generation settings.
- `seekdeepLooksLikeIterativeImageModification(prompt)` + `seekdeepBuildIterativeImagePrompt(prompt, prior)` — "now make her wear a hat" etc.
- `seekdeepRememberTempImageState` / `seekdeepGetTempImageState` — TTL cache for the regenerate/archive button flow.
- `seekdeepAttachDownloadButton(sentMessage, actionId)` — adds the full-res Download link button to an already-sent image message.

## Web Search Agent

**Purpose**: SearXNG integration for grounded chat replies.

**Key Functions**:
- `searchWeb(query, options)` — POSTs SearXNG, returns sources.
- `buildSearchQuery(prompt, key)` — distills the prompt + recent memory into a focused search query.
- `formatSources(sources)` — formats hits into the model prompt + the visible compact "Sources:" footer; URLs are wrapped in angle brackets to suppress Discord previews.
- `shouldAutoSearch(prompt)` — see Chat Agent.

## Archive Agent

**Purpose**: Discord-thread-based image archive (per-user and shared).

**Key Functions**:
- `seekdeepArchiveImageStateToDiscordThread(state, target)` — writes a single image to the user's archive thread, using `Archive Key` dedupe and per-thread count locking.
- `seekdeepArchiveImageStateToSharedDiscordThread(state, target)` — same for the shared thread.
- `seekdeepGetOrCreateSharedArchiveThread(target)` — bootstraps the shared archive thread on first use.
- `seekdeepArchiveThreadReadConfig()` / `seekdeepArchiveThreadSaveUserProfile(...)` — persistence (file-based, `data/archive-guild-config.json`).
- `seekdeepArchiveThreadCountExistingEntries(thread)` — scans the thread for archive-entry markers to get an accurate count after manual deletions.
- `seekdeepArchiveKeyFromState(state)` / `seekdeepArchiveThreadFindEntryByKey(thread, key)` — stable duplicate suppression for repeated archive operations, retries, and restarts.
- `seekdeepArchiveUserThreadName(user, count)` — coin-emoji thread name (`🪙 • Archive • <user> • <count>`).
- `seekdeepLegacyArchiveUserThreadName(user)` — pre-v10 plain-ASCII name format, kept for thread-discovery fallback (do not delete; orphans existing legacy threads).
- `seekdeepHandleArchiveOpenMessage(message, raw)` / `seekdeepHandleArchiveConfigMessage(...)` / `seekdeepHandleArchiveStatusMessage(...)` — command dispatchers for the three archive sub-commands.
- `seekdeepHandleNaturalArchiveImageFollowup(message, raw)` — "archive this" / "save it" / "make it archive too" / "shared archive this" detector.
- `seekdeepSearchArchiveByPrompt(message, query, limit)` — `@SeekDeep archive search red apple` text search.
- `seekdeepBuildRecentArchiveReport(target)` — `/recent kind:archive` report.

## Natural Routing

**Purpose**: When the bot is mentioned but the prompt doesn't match any explicit command, decide whether the user wants chat, image, vision, or research-table output.

**Key Functions**:
- `seekdeepDispatchAddressedMessage(message, ctx)` — the dispatcher. See "Discord Event Pipeline" above.
- `seekdeepLooksLikeImagePrompt(prompt)`, `isNaturalImagePrompt(prompt)`, `seekdeepLooksLikeVisualRequest(prompt)`, `seekdeepIsDirectImageAliasPrompt(prompt, opts)` — image-intent detectors.
- `seekdeepLooksLikeRecentImageFollowup(prompt)` — "tell me more about this image" auto-routes to vision (reuses cached attachment).
- `seekdeepClassifyImageReplyIntent(prompt, context)` / `seekdeepHandleImageReplyIntent(message, prompt, key)` — classifies replies to images as edit, fresh inspired generation, vision/OCR, upscale, regenerate, RE-REFINE, or clarification.
- `seekdeepLooksLikeProperNounLookupPrompt(prompt)` — "tell me about KK Slider" / "what is Skyrim" auto-routes through web search + `quality_text`.
- `seekdeepShouldKeepPromptAsChatBeforeImage(prompt)` — guard against "what is" / "explain" routing to image.
- `seekdeepResolveImagePromptFromContext(message, prompt)` — looks back at recent messages when the prompt is referential ("him", "the same but in winter").

## img2img + Upscale (v10.25)

**Purpose**: Transform existing images with a text prompt, or enlarge them.

**Key Functions**:
- `seekdeepHandleImg2Img(target, prompt, sourceUrl)` — fetches source image, calls `/img2img`, posts result with buttons.
- `seekdeepHandleUpscale(target, sourceUrl, scale)` — fetches source image, calls `/upscale`, posts result, and clears loading state on success/failure.
- `seekdeepResolveSourceImage(target)` — 3-step waterfall: direct attachment → replied message → most recent bot image in channel.
- `seekdeepFetchImageAsBase64(url)` — download + base64-encode an image URL.
- `seekdeepImg2ImgQueryFromMessage(raw)` / `seekdeepUpscaleQueryFromMessage(raw)` — extract prompt/scale from message text.

img2img uses `AutoPipelineForImage2Image.from_pipe()` on the Python server to share existing SDXL weights — zero extra model download. Upscale defaults to PIL Lanczos with a mild configurable unsharp mask (`SEEKDEEP_UPSCALE_*`); Real-ESRGAN is scaffolded for future opt-in.

Python image endpoints decode through a shared byte/pixel guard: base64 payloads are capped by `LOCAL_AI_MAX_IMAGE_BYTES` / `LOCAL_AI_MAX_B64_CHARS`, and decoded dimensions are capped by `LOCAL_AI_MAX_IMAGE_PIXELS` before PIL `load()` / `convert()` or Real-ESRGAN upscaling.

## Conversation Search (v10.23)

**Purpose**: Full-text keyword search across recent channel messages.

**Key Functions**:
- `seekdeepSearchConversationHistory(channel, botId, query, maxPages)` — pages through `channel.messages.fetch` (up to 500 messages), matches bot responses and user messages mentioning the bot.
- `seekdeepFormatConversationSearchResults(results, query)` — renders a compact report with timestamps, snippets, and jump-to-message links.
- `seekdeepConversationSearchQueryFromMessage(raw)` — extracts the query from `@SeekDeep search <query>` (avoids false-matching `archive search`).

## Prompt Templates (v10.24)

**Purpose**: Per-user saved image prompts for one-command regeneration.

**Key Functions**:
- `seekdeepHandleTemplateCommand(message, raw)` — save/list/use/delete dispatcher.
- `seekdeepSaveUserTemplate(guildId, userId, name, prompt)` — validates name/prompt, enforces max 25 per user.
- `seekdeepGetUserTemplates(guildId, userId)` — returns the user's template map.
- `seekdeepTemplateNameSanitize(name)` — lowercase, strip special chars, max 30 chars.

## Auto-Translate Channel (v10.29)

**Purpose**: Automatically translate non-Latin messages in a designated channel.

**Key Functions**:
- `seekdeepAutoTranslateMessage(message)` — checks if message is in the auto-translate channel, detects non-Latin script, translates via chat model.
- `seekdeepLooksLikeNonLatin(text)` — fast regex check for CJK, Cyrillic, Arabic, Devanagari, Thai, Korean, etc.
- `seekdeepHandleAutoTranslateChannelCommand(message, raw)` — admin `translate channel here|off`.
- `seekdeepGetAutoTranslateChannelId(guildId)` — reads from persona-overrides.json.

## Prompt Refinement

**Purpose**: Take a user image prompt and rewrite it into a denser, more model-friendly version.

**Key Functions**:
- `seekdeepBuildImagePromptChoice(prompt, options)` — orchestrates dynamic + static refinement.
- `seekdeepPrepareImagePromptDynamic(prompt, options)` — AI refinement via the pinned `default_chat` role; supports force-fresh refinement for RE-REFINE and logs rejection/fallback reasons.
- `seekdeepPrepareImagePrompt(prompt)` — static keyword-rule fallback.
- `seekdeepRefinedPromptCacheGet` / `seekdeepRefinedPromptCacheSet` — TTL cache so clicking Refined twice in a row doesn't re-run the chat model.
- `seekdeepCleanRefinedPrompt(text)` + `removeRepeatedSentences(text)` — post-processing.

## Auto-Reactions

**Purpose**: Auto-add emoji reactions to messages matching configured patterns.

**Key Functions**:
- `seekdeepApplyAutoReactions(message)` — fires for every non-bot human message. Walks the guild's rule list + built-in stacking rules.
- `seekdeepHandleReactRuleCommand(message, raw)` — `@SeekDeep reactrule add/list/remove/toggle/builtin/export/import`.
- `seekdeepCompileReactionPattern(raw)` — accepts substring (default), `/regex/flag`, or built-in trigger name.
- Built-in stacking rules: `long_message`, `forwarded`, `code_block`, `image_only`, `link_only`. Each is opt-in per guild via `reactrule builtin <name> on|off`. Persistence in `data/auto-reactions.json`.

## Force React *(feature-flagged off)*

**Purpose**: Manually apply up to 5 reactions to a target message via a paginated picker UI.

**Key Functions**:
- `seekdeepHandleContextMenuForceReact(interaction, targetMessage)` — entry point from the right-click "Force React (SeekDeep)" context menu.
- `seekdeepBuildForceReactComponents(targetMsgId, guild, state)` — builds 4 collapsible select menus (25 emoji each, 100 per page) + nav row.
- `seekdeepHandleForceReactComponent(interaction)` — dispatches select/nav/apply/cancel button interactions.
- `seekdeepForceReactGet/Set/Delete(userId, targetMsgId)` — per-user-per-target picker state map with `SEEKDEEP_FORCE_REACT_TTL_MS` TTL.

Gated by `SEEKDEEP_FEATURE_FORCE_REACT=on` in `.env`. Both context-menu registration and dispatcher refuse to run when off.

## Emoji Vault *(feature-flagged off)*

**Purpose**: Backup and restore guild custom emoji via a dedicated thread + JSON + ZIP attachment.

**Key Functions**:
- `seekdeepHandleEmojiVaultCommand(message, raw)` — `@SeekDeep emoji backup/import/count/list` dispatcher.
- `seekdeepEmojiVaultFindOrCreateThread(message, guild)` — opens or creates `<Guild> — Emojis` thread.
- `seekdeepEmojiVaultFormatPage(...)` — paginated emoji preview with `<:name:id>` previews + name + ID.
- `seekdeepEmojiVaultBuildZip(emojis, options)` — fetches every emoji image (8-way concurrent) and packages into a ZIP with internal `manifest.json`. 24 MB cap.

Gated by `SEEKDEEP_FEATURE_EMOJI_VAULT=on` in `.env`. Returns `false` (not `true`) from the handler when disabled so it stays out of the dispatch chain entirely.

## Persona / Memory / Stats / Digest

**Per-channel/per-server persona overrides** — `@SeekDeep persona [channel|server] [neurotic|unsettling|clinical|chaotic|reset|show]` or `/persona` modal (v10.26). Persistence in `data/persona-overrides.json`. Resolved at chat time by `seekdeepGetEffectivePersona(channelId, guildId)`.

**Per-user memory presets** — `@SeekDeep memory preset add brief | expert | no-emoji | formal | casual | <custom>`. Persistence in `data/memory-presets.json`. Rendered into the system prompt by `seekdeepGetUserMemoryPresetsLines(userId)`.

**Server stats** — `@SeekDeep stats` / `stats me` / `stats chart` (v10.28). Counts per-guild per-user per-kind (chat / image / vision) interactions with 30-day rolling daily buckets. Chart mode renders a matplotlib line chart via the Python server's `/chart` endpoint. Persistence in `data/server-stats.json`. Updated by `seekdeepTrackStatEvent({...})`.

**Daily digest** — opt-in via `SEEKDEEP_DAILY_DIGEST=on`. Admin sets channel with `@SeekDeep digest channel here`. Posts a stats summary at `SEEKDEEP_DAILY_DIGEST_HOUR` (default 9) per guild.

## Help Routing

- `seekdeepHelpText(source)` — builds the full ~150-line help map. Sections conditionally omitted when their feature flag is off (`SEEKDEEP_FEATURE_EMOJI_VAULT`, `SEEKDEEP_FEATURE_FORCE_REACT`).
- `seekdeepHelpTopicSlice(topic, source)` — returns just one section of the help, predicate-based on `## ` heading text.
- `seekdeepParseHelpTopic(prompt)` — extracts `"chat"` from `"help chat"` / `"chat help"`.

## Reply / Fetch Helpers

- `seekdeepReplyToTarget(target, payload, options?)` — target-agnostic reply. Sniffs `Interaction` vs `Message` and dispatches to `safeEditOrReply` or `message.reply` respectively. Optional `previousReply` lets the Message path EDIT a prior reply handle so the "preparing → final" flow matches `Interaction.editReply` semantics.
- `safeEditOrReply(interaction, payload)` — interaction reply with deferred/replied state machine + explicit-content fallback.
- `seekdeepFetchWithLimits(url, options)` — the user-URL fetch wrapper, **defined in [`lib/url-fetch-policy.js`](lib/url-fetch-policy.js)** and imported by `index.js` (it is no longer inline). Layers: `AbortController` timeout + `Content-Length`/streamed byte cap; **SSRF validation** (`seekdeepValidateFetchTarget` rejects non-http(s) schemes and private/loopback/link-local/CGNAT/IPv6-ULA/cloud-metadata targets); **manual redirect re-validation** on every hop; and **DNS-pinned connections** (the socket connects to the exact validated IP — anti-rebinding, via `seekdeepBuildPinnedAgent`). Default-deny; `SEEKDEEP_FETCH_ALLOW_PRIVATE=on` opts a trusted LAN install back in. Used by `askVision`, img2img/upscale/pix2pix/inpaint source fetches, archive upload, reactrule import, emoji vault import.
- `splitDiscordText(value, limit)` — fence-aware splitter. Closes open ` ``` ` on the cut chunk and reopens with the same language hint on the next chunk.
- `sendLongMessageReply(message, content)` / `sendLongInteractionReply(interaction, content)` — auto-chunked replies.

## Test Mode

When `SEEKDEEP_TEST_MODE=1` is set in the environment, the bot:

- Skips `client.login()` so the module can be imported without spinning up a Discord gateway connection.
- Exposes whitelisted helpers on `globalThis.__seekdeepTest`:
  - `splitDiscordText`, `seekdeepIsFrustrationPrompt`, `seekdeepCompileReactionPattern`
  - `seekdeepHelpText`, `seekdeepHelpTopicSlice`, `seekdeepParseHelpTopic`, `seekdeepHelpSearch`
  - `seekdeepEmojiVaultThreadName`, `seekdeepEmojiVaultFormatPage`
  - `seekdeepForceReactBucketRange`
  - `seekdeepCleanDynamicImagePromptDetailed`, `seekdeepDynamicImagePromptPreservesSubject`
  - `seekdeepArchiveThreadTrustedCount`, `seekdeepArchiveThreadBuildName`, `seekdeepArchiveThreadDisplayName`, `seekdeepArchiveMessageLooksLikeEntry`, `SEEKDEEP_ARCHIVE_COUNT_SOURCE`
  - `seekdeepConversationSearchQueryFromMessage`, `seekdeepFormatConversationSearchResults`
  - `seekdeepTemplateNameSanitize`, `seekdeepGetUserTemplates`, `SEEKDEEP_MAX_TEMPLATES_PER_USER`
  - `seekdeepImg2ImgQueryFromMessage`, `seekdeepUpscaleQueryFromMessage`
  - `seekdeepLooksLikeNonLatin`, `SEEKDEEP_NON_LATIN_REGEX`
  - `seekdeepArchiveKeyFromState`, `seekdeepArchiveMessageArchiveKey`
  - `seekdeepClassifyImageReplyIntent`, `seekdeepImageReplyEditPlan`, `seekdeepRegenerateModeOptions`
  - `formatSources`, `seekdeepDiscordSafeUrl`
  - `forceReactConstants`, `emojiVaultConstants`, `chunkerConstants`

`smoke_test.mjs` sets the env var before its dynamic `import('./index.js')` so every assertion runs against the real function bodies. New pure helpers worth testing should be added to the whitelist near the bottom of `index.js`.

## Data Persistence (`data/*.json`)

All runtime state is stored as flat JSON files in the `data/` directory. Each file is read on demand and written back atomically. The `data/` directory is auto-created on first write. All runtime files are gitignored (real `archive-guild-config.json` carries server/channel/user IDs and is NOT tracked); `data/archive-guild-config.sample.json` IS tracked as a schema reference, and `data/.gitkeep` keeps the empty directory in the repo.

### `archive-guild-config.json`

Per-guild archive configuration and per-user archive thread profiles.

```jsonc
{
  "guilds": {
    "<guildId>": {
      "archiveChannelId": "123456789",       // channel where archive threads live
      "sharedArchiveThreadId": "987654321",   // shared archive thread ID
      "sharedArchiveCount": 34,               // entry count in shared thread
      "userArchives": {
        "<userId>": {
          "threadId": "111222333",            // user's personal archive thread ID
          "count": 12,                        // trusted entry count
          "countSource": "seekdeep-archive-posts-v3"  // source-gate for trusted counts
        }
      }
    }
  }
}
```

Read: `seekdeepArchiveThreadReadConfig()` / Write: `seekdeepArchiveThreadWriteConfig(config)`

### `persona-overrides.json`

Per-channel persona overrides, per-guild digest/auto-translate channel config.

```jsonc
{
  "channels": {
    "<channelId>": {
      "persona": "neurotic"                   // channel-level persona override
    }
  },
  "guilds": {
    "<guildId>": {
      "persona": "clinical",                  // server-wide persona override
      "digestChannelId": "123456789",         // daily digest target channel
      "autoTranslateChannelId": "987654321"   // auto-translate target channel
    }
  }
}
```

Read: `seekdeepReadPersonaOverrides()` / Write: `seekdeepWritePersonaOverrides(data)`

### `server-stats.json`

Per-guild activity counters with 30-day rolling daily buckets.

```jsonc
{
  "guilds": {
    "<guildId>": {
      "totalImages": 142,
      "totalChats": 580,
      "totalVision": 23,
      "users": {
        "<userId>": { "images": 42, "chats": 120, "vision": 5 }
      },
      "dayBuckets": {
        "2026-05-18": { "images": 3, "chats": 12, "vision": 1 }
        // ... last 30 days, older entries auto-trimmed
      }
    }
  }
}
```

Read: `seekdeepReadServerStats()` / Write: `seekdeepWriteServerStats(data)` / Increment: `seekdeepTrackStatEvent({ guildId, userId, kind })`

### `memory-presets.json`

Per-user behavior presets injected into the chat system prompt.

```jsonc
{
  "users": {
    "<userId>": {
      "brief": "The user prefers brief, terse answers. Skip long preambles.",
      "no-emoji": "Do not use emoji in replies for this user."
      // keys: brief, expert, no-emoji, no-followup-questions, formal, casual
    }
  }
}
```

Read: `seekdeepReadMemoryPresets()` / Write: `seekdeepWriteMemoryPresets(data)`

### `prompt-templates.json`

Per-guild per-user saved image prompt templates.

```jsonc
{
  "guilds": {
    "<guildId>": {
      "<userId>": {
        "<template-name>": {
          "prompt": "cyberpunk cityscape at night, neon reflections...",
          "createdAt": 1716048000000,
          "usedCount": 3,
          "lastUsedAt": 1716134400000
        }
      }
    }
  }
}
```

Max 25 templates per user. Names: lowercase alphanumeric + hyphens, max 30 chars. Prompt text: max 2000 chars.

Read: `seekdeepReadPromptTemplates()` / Write: `seekdeepWritePromptTemplates(data)`

### `auto-reactions.json`

Per-guild custom auto-reaction rules and built-in toggle overrides.

```jsonc
{
  "guilds": {
    "<guildId>": {
      "rules": [
        {
          "id": "r_1716048000000_abc",
          "emoji": "👀",                       // the reaction emoji
          "pattern": "sus",                    // substring match
          "regex": false,                      // true if /regex/flags syntax
          // scope/target replaced the old channelId/userId pair after v10.4.x.
          // scope = "guild" | "channel" | "user"; target = id-or-empty.
          // empty target on a channel/user scope means "any channel/any user".
          "scope": "guild",
          "target": "",
          "enabled": true,
          "createdBy": "123456789012345678",
          "createdAt": "2026-05-26T09:00:00.000Z"
        }
      ],
      "builtins": {
        "long_message": true,                  // override for built-in stacking rules
        "forwarded": false
      }
    }
  }
}
```

Read: `seekdeepReadAutoReactions()` / Write: `seekdeepWriteAutoReactions(data)`

## Desktop Sidecar / Watchdog

**Purpose**: Tauri desktop shell process management for the local FastAPI server.

**Key Rust Entry Points**:
- `src-tauri/src/sidecar.rs::boot_sequence(app)` — one-at-a-time startup/respawn orchestrator. Handles stale listener checks, bundle extraction, Python selection, dependency probing, and `local_ai_server.py` spawn.
- `src-tauri/src/sidecar.rs::spawn_server(python, runtime, log_dir)` — launches the Python sidecar with hidden Windows console flags and redirects stdout/stderr to runtime logs.
- `src-tauri/src/sidecar.rs::start_crash_watchdog(app)` — polls the tracked child, backs off unexpected respawns, and uses `watchdog_generation` to retire stale watchdog threads.
- `src-tauri/src/sidecar.rs::kill_child(state)` — intentional child stop used by restart/install/quit paths. It only arms the watchdog's `intentional_kill` suppressor when a tracked child handle was actually removed.
- `src-tauri/src/sidecar.rs::shutdown_all(state)` — exit-time sweep for the tracked child plus orphan SeekDeep Python/bot processes.
- `src-tauri/src/lib.rs::restart_sidecar(app)` — GUI/tray command: kill tracked child, sweep orphan AI servers, then re-run `boot_sequence`.

## Integration Points

| Source | Path |
|---|---|
| Discord `messageCreate` | `seekdeepProcessPreAddressMessageRoutes` → `seekdeepDispatchAddressedMessage` → appropriate agent |
| Discord slash command | `client.on('interactionCreate')` slash router → agent |
| Discord button | Image action, prompt-choice, archive button, shared archive button, force-react component, archive-delete button — each has a dedicated `seekdeepHandle*Button` |
| Discord modal | `seekdeepHandlePersonaModalSubmit` (persona editor, v10.26). Legacy Force React modal returns a "use the new picker" notice |
| Discord reaction add | `messageReactionAdd` → archive shortcut (📥) / delete shortcut (🗑) / regenerate shortcut (🔁) |
| Discord context menu | Right-click → Apps → Generate Image / Refine / Inspect / Translate / Compare / Force React |
| Local AI server | `askChat` → `/chat`, `askVision` → `/vision`, `makeImageResult` → `/image`, img2img → `/img2img`, upscale → `/upscale`, chart → `/chart`, GPU → `/gpu` |
| SearXNG | `searchWeb` → `http://127.0.0.1:8080/search` |
