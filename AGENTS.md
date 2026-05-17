# Agents & Internal Components

SeekDeep is a single-file Node bot (`index.js`, ~14k lines after the v10.5–v10.10 cleanup) plus a Python FastAPI local AI server (`local_ai_server.py`). The Node side organizes its work into named "agents" that share top-level state through hoisted helper functions. This document maps each subsystem to the key entry points so future edits don't have to grep blind.

Function names are stable enough to grep for. If you find a stale reference here while reading the code, please update this file in the same change.

## Discord Event Pipeline

The bot listens for three Discord events: `messageCreate`, `interactionCreate`, and `messageReactionAdd`. After v10.9 the messageCreate handler is a thin 112-line orchestrator that delegates to:

- `seekdeepProcessPreAddressMessageRoutes(message)` — pre-mention routes (archive config, status, search, persona, memory presets, stats, digest, reactrule, emoji vault, natural-archive followups). Returns `true` if a route handled the message.
- `seekdeepDispatchAddressedMessage(message, ctx)` — the addressed-message dispatcher. Runs after the bot mention is detected and the prompt has been normalized + deduped. Houses the ~370-line route cascade (reply-translate, chat-ask, image alias, pending image subject, vision, raw-image, research-table, chat fallback).

The handler also wires:

- `seekdeepClaimEventOnce(key)` — message-level dedupe.
- `seekdeepIsChannelAllowed(channelId)` — `SEEKDEEP_ALLOWED_CHANNELS` allowlist gate.
- `seekdeepApplyAutoReactions(message)` — fire-and-forget auto-reaction pass.

## Chat Agent

**Purpose**: Conversational queries via the role-routed local chat model.

**Key Functions**:
- `askChat(prompt, options)` — main entry. Resolves chat role, builds prompt with memory, calls the FastAPI `/chat` endpoint, post-processes the reply.
- `shouldAutoSearch(prompt)` — keyword + regex cascade deciding whether SearXNG should run first (200 lines of inline data arrays — intentional, see v10.10 audit notes).
- `seekdeepResolveChatRoleForPrompt(prompt, opts)` — selects `default_chat` / `quality_text` / `reasoning_code` / `fallback_chat` / `lightweight_chat` from prompt content.
- `seekdeepBuildSystemPrompt(personaOverride, extra)` — composes the persona + user-preset system prompt.
- `memoryKeyFrom(source)`, `remember(key, role, value)`, `getRecentContext(key)`, `shouldUseMemory(prompt)`, `buildPromptWithMemory(prompt, key)` — rolling chat memory.
- `cleanLoopingReply(text)`, `stripQwenThinkingBlocks(text)` — anti-loop + Qwen `<think>...</think>` removal.

## Vision Agent

**Purpose**: Analyze images/videos via the local vision model.

**Key Functions**:
- `askVision(attachment, prompt)` — downloads the attachment via `seekdeepFetchWithLimits`, base64-encodes, POSTs `/vision`.
- `seekdeepLooksLikeVisionPrompt(prompt)` — detects vision-style prompts ("what is this", "describe this image", etc.).
- `seekdeepLooksLikeVisualAttachment(attachment)` — checks contentType + filename/URL extension against image/video patterns (handles `avif/tiff/m4v` and `proxyURL`).
- `firstVisualAttachmentFrom(sourceMessage)` — walks direct attachments + `messageSnapshots` (forwarded messages) + embed image URLs (link previews) to find the first visual.
- `fetchRepliedMessage(message)` — fetches the replied-to message via `message.fetchReference()`.
- `seekdeepGetReplyVisualAttachment(message)` — convenience wrapper: `fetchRepliedMessage` + `firstVisualAttachmentFrom`.
- `seekdeepRememberRecentVisionTarget` / `seekdeepConsumeRecentVisionTarget` — cache the attachment URL so a follow-up ("tell me more about this image") can re-run vision without re-uploading.

## Image Agent

**Purpose**: SDXL generation with prompt refinement, queueing, and cooldown management.

**Key Functions**:
- `seekdeepSendImageWithButtons(target, prompt, w, h, seed, opts)` — unified message- and interaction-shaped image send. Resolves prompt context, gates on cooldown, queues a job, awaits result, posts with `Original/Refined/Both/Download/Archive/Shared Archive` button rows.
- `seekdeepSendImagePromptChoice(target, prompt, w, h, seed, opts)` — "preparing... → Original / Refined / Both" choice flow before queueing.
- `makeImageResult(prompt, w, h, seed, options)` — calls `/image`, returns `{ buffer, refinedPrompt, grounding, imageOptions }`.
- `seekdeepEnqueueImageJob(job, runner)` — FIFO queue with admin-priority insertion.
- `seekdeepImageCooldownRemaining(userId)` / `seekdeepRememberImageCooldown(userId)` — per-user cooldown TTLs (`SEEKDEEP_IMAGE_COOLDOWN_MS`).
- `seekdeepBuildImagePromptChoice(prompt, options)` — dynamic AI-refined prompt with static-cleanup fallback.
- `seekdeepImageModeOptionsFromPrompt(prompt)` — parses `raw`, `unrefined`, `--raw`, `no refine`, ground/refine toggles.
- `seekdeepLooksLikeIterativeImageModification(prompt)` + `seekdeepBuildIterativeImagePrompt(prompt, prior)` — "now make her wear a hat" etc.
- `seekdeepRememberTempImageState` / `seekdeepGetTempImageState` — TTL cache for the regenerate/archive button flow.
- `seekdeepAttachDownloadButton(sentMessage, actionId)` — adds the full-res Download link button to an already-sent image message.

## Web Search Agent

**Purpose**: SearXNG integration for grounded chat replies.

**Key Functions**:
- `searchWeb(query, options)` — POSTs SearXNG, returns sources.
- `buildSearchQuery(prompt, key)` — distills the prompt + recent memory into a focused search query.
- `formatSources(sources)` — formats hits into the model prompt + the visible "Sources:" footer.
- `shouldAutoSearch(prompt)` — see Chat Agent.

## Archive Agent

**Purpose**: Discord-thread-based image archive (per-user and shared).

**Key Functions**:
- `seekdeepArchiveImageStateToDiscordThread(state, target)` — writes a single image to the user's archive thread.
- `seekdeepArchiveImageStateToSharedDiscordThread(state, target)` — same for the shared thread.
- `seekdeepGetOrCreateSharedArchiveThread(target)` — bootstraps the shared archive thread on first use.
- `seekdeepArchiveThreadReadConfig()` / `seekdeepArchiveThreadSaveUserProfile(...)` — persistence (file-based, `data/archive-guild-config.json`).
- `seekdeepArchiveThreadCountExistingEntries(thread)` — scans the thread for archive-entry markers to get an accurate count after manual deletions.
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
- `seekdeepLooksLikeProperNounLookupPrompt(prompt)` — "tell me about KK Slider" / "what is Skyrim" auto-routes through web search + `quality_text`.
- `seekdeepShouldKeepPromptAsChatBeforeImage(prompt)` — guard against "what is" / "explain" routing to image.
- `seekdeepResolveImagePromptFromContext(message, prompt)` — looks back at recent messages when the prompt is referential ("him", "the same but in winter").

## Prompt Refinement

**Purpose**: Take a user image prompt and rewrite it into a denser, more model-friendly version.

**Key Functions**:
- `seekdeepBuildImagePromptChoice(prompt, options)` — orchestrates dynamic + static refinement.
- `seekdeepPrepareImagePromptDynamic(prompt, options)` — AI refinement via the local chat model.
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

**Per-channel/per-server persona overrides** — `@SeekDeep persona [channel|server] [neurotic|unsettling|clinical|chaotic|reset|show]`. Persistence in `data/persona-overrides.json`. Resolved at chat time by `seekdeepGetEffectivePersona(channelId, guildId)`.

**Per-user memory presets** — `@SeekDeep memory preset add brief | expert | no-emoji | formal | casual | <custom>`. Persistence in `data/memory-presets.json`. Rendered into the system prompt by `seekdeepGetUserMemoryPresetsLines(userId)`.

**Server stats** — `@SeekDeep stats` / `stats me`. Counts per-guild per-user per-kind (chat / image / vision) interactions. Persistence in `data/server-stats.json`. Updated by `seekdeepTrackStatEvent({...})`.

**Daily digest** — opt-in via `SEEKDEEP_DAILY_DIGEST=on`. Admin sets channel with `@SeekDeep digest channel here`. Posts a stats summary at `SEEKDEEP_DAILY_DIGEST_HOUR` (default 9) per guild.

## Help Routing

- `seekdeepHelpText(source)` — builds the full ~150-line help map. Sections conditionally omitted when their feature flag is off (`SEEKDEEP_FEATURE_EMOJI_VAULT`, `SEEKDEEP_FEATURE_FORCE_REACT`).
- `seekdeepHelpTopicSlice(topic, source)` — returns just one section of the help, predicate-based on `## ` heading text.
- `seekdeepParseHelpTopic(prompt)` — extracts `"chat"` from `"help chat"` / `"chat help"`.

## Reply / Fetch Helpers

- `seekdeepReplyToTarget(target, payload, options?)` — target-agnostic reply. Sniffs `Interaction` vs `Message` and dispatches to `safeEditOrReply` or `message.reply` respectively. Optional `previousReply` lets the Message path EDIT a prior reply handle so the "preparing → final" flow matches `Interaction.editReply` semantics.
- `safeEditOrReply(interaction, payload)` — interaction reply with deferred/replied state machine + explicit-content fallback.
- `seekdeepFetchWithLimits(url, options)` — `fetch` wrapper with `AbortController` timeout + `Content-Length` precheck. Used by `askVision`, reactrule import, emoji vault import.
- `splitDiscordText(value, limit)` — fence-aware splitter. Closes open ` ``` ` on the cut chunk and reopens with the same language hint on the next chunk.
- `sendLongMessageReply(message, content)` / `sendLongInteractionReply(interaction, content)` — auto-chunked replies.

## Test Mode

When `SEEKDEEP_TEST_MODE=1` is set in the environment, the bot:

- Skips `client.login()` so the module can be imported without spinning up a Discord gateway connection.
- Exposes whitelisted helpers on `globalThis.__seekdeepTest`:
  - `splitDiscordText`, `seekdeepIsFrustrationPrompt`, `seekdeepCompileReactionPattern`
  - `seekdeepHelpText`, `seekdeepHelpTopicSlice`, `seekdeepParseHelpTopic`
  - `seekdeepEmojiVaultThreadName`, `seekdeepEmojiVaultFormatPage`
  - `seekdeepForceReactBucketRange`
  - `forceReactConstants`, `emojiVaultConstants`, `chunkerConstants`

`smoke_test.mjs` sets the env var before its dynamic `import('./index.js')` so every assertion runs against the real function bodies. New pure helpers worth testing should be added to the whitelist near the bottom of `index.js`.

## Integration Points

| Source | Path |
|---|---|
| Discord `messageCreate` | `seekdeepProcessPreAddressMessageRoutes` → `seekdeepDispatchAddressedMessage` → appropriate agent |
| Discord slash command | `client.on('interactionCreate')` slash router → agent |
| Discord button | Image action, prompt-choice, archive button, shared archive button, force-react component, archive-delete button — each has a dedicated `seekdeepHandle*Button` |
| Discord modal | (Force React's modal was removed in v10.4.1; legacy `seekdeep:force-react:` modal returns a "use the new picker" notice) |
| Discord reaction add | `messageReactionAdd` → archive shortcut / delete shortcut / regenerate shortcut |
| Local AI server | `askChat`, `askVision`, `makeImageResult` → `http://127.0.0.1:7865/{chat,vision,image}` |
| SearXNG | `searchWeb` → `http://127.0.0.1:8080/search` |
