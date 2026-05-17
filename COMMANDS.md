# SeekDeep Commands

Use one command per Discord message when smoke-testing routing. SeekDeep accepts the canonical mention `@SeekDeep`, direct bot mentions, and valid leading bot-role mentions.

## Start And Status

| Command | Purpose |
|---------|---------|
| `@SeekDeep help` | Show the full in-Discord command map. |
| `@SeekDeep help <topic>` | Show only one section. Topics: `start`, `chat`, `image`, `vision`, `archive`, `model`, `recent`, `admin`, `reactrule`, `emoji`, `context`, `all`. Both `help chat` and `chat help` parse. |
| `@SeekDeep archive help` | Show help, archive section only. |
| `@SeekDeep status` | Show local AI server, model, runtime, queue, and response status. |
| `@SeekDeep ping` | Lightweight bot availability check. |
| `@SeekDeep what model are you using?` | Show configured local model information. |
| `/help` | Slash equivalent. Accepts `topic:<choice>` for the same 11 sections + `all`. |
| `/status verbose:true` | Slash status with the full chat-roles map + cache/map-size diagnostics. |

## Chat, Web, And Prompting

| Command | Purpose |
|---------|---------|
| `@SeekDeep ask <question>` | Ask the local chat model. |
| `@SeekDeep refine <prompt>` | Rewrite or improve a prompt with the local chat model. |
| `/ask prompt:<text> web:auto\|off\|always` | Slash-command chat entrypoint. |
| `/refine prompt:<text>` | Slash-command prompt rewrite entrypoint. |

`web:auto` lets SeekDeep decide whether SearXNG is needed. Use `web:off` for local-only answers. Use `web:always` to force a search.

Replying to any non-English message with `@SeekDeep translate this` (or just `translate`) auto-routes to translation.

## Image Generation

| Command | Purpose |
|---------|---------|
| `@SeekDeep show me <subject>` | Generate an image. |
| `@SeekDeep show <subject>` | Generate an image. |
| `@SeekDeep draw me <subject>` | Generate an image. |
| `@SeekDeep draw <subject>` | Generate an image. |
| `@SeekDeep generate <subject>` | Generate an image. |
| `@SeekDeep generate me <subject>` | Generate an image with `me` treated as grammar, not as the subject. |
| `@SeekDeep make <subject>` | Generate an image. |
| `@SeekDeep create <subject>` | Generate an image. |
| `@SeekDeep render <subject>` | Generate an image. |
| `@SeekDeep paint <subject>` | Generate an image. |
| `@SeekDeep sketch <subject>` | Generate an image. |
| `@SeekDeep illustrate <subject>` | Generate an image. |
| `@SeekDeep design <subject>` | Generate an image. |
| `@SeekDeep regenerate` | Regenerate the most recent image prompt when available. |
| `/image prompt:<text> width:<n> height:<n> seed:<n>` | Slash-command image generation. |
| `/image ... quality:low\|standard\|high` | Image quality preset (12 / 28 / 40 inference steps). |
| `/image ... style:anime\|photoreal\|pixel\|oil-painting\|cyberpunk\|cottagecore\|cinematic\|3d-render\|sketch\|watercolor` | Pre-baked style modifier appended to the prompt. |
| `/regen mode:refined\|original\|both` | Regenerate the latest channel image with the chosen prompt. |

If the subject is missing, for example `@SeekDeep generate me`, SeekDeep asks what to generate and consumes the next plain reply as the image subject.

Image requests offer `Original`, `Refined`, and `Both` choices. Refined prompts use the local chat model dynamically, then fall back to static cleanup if refinement fails.

Image result buttons:

- `Download` (full-resolution CDN URL)
- `Archive` (your personal thread)
- `Shared Archive` (server-wide thread)

Use `raw`, `unrefined`, `--raw`, or `no refine` in a prompt when you want to skip refinement.

**Iterative tweaks** — after the bot has generated an image in this channel, follow up with phrases like "now make her wear a hat" / "with sunglasses" / "same but in winter" / "make it black and white". SeekDeep extends the prior refined prompt instead of starting fresh.

## Vision

| Command | Purpose |
|---------|---------|
| Reply to an image/video with `@SeekDeep what is this?` | Analyze the replied-to media. |
| Reply to a forwarded image with the same prompt | Walks `messageSnapshots` to find the underlying image. |
| `/vision file:<upload> prompt:<question>` | Slash-command vision analysis. |
| `@SeekDeep tell me more about this image` (within ~10 min of a prior vision reply) | Re-runs vision on the cached attachment without requiring a new upload. |

## Archive — Setup

Archive setup changes are restricted to server admins, users with Manage Server, users with Manage Channels, or configured SeekDeep admins.

| Command | Purpose |
|---------|---------|
| `@SeekDeep archive config` | Show archive configuration status. |
| `@SeekDeep archive setup here` | Configure the current channel as the server archive channel and bootstrap shared archive state. |
| `@SeekDeep setup archive here` | Alias for archive setup in the current channel. |
| `@SeekDeep archive setup #channel` | Configure a mentioned channel as the server archive channel. |

## Archive — Use

| Command | Purpose |
|---------|---------|
| `@SeekDeep archive me` | Open or create your personal archive thread. |
| `@SeekDeep archive @user` | Open or create another user's archive thread when permitted. |
| `@SeekDeep archive for @user` | Alias for `archive @user`. |
| `@SeekDeep archive shared` | Open or create the shared archive thread. |
| `@SeekDeep shared archive` | Alias for `archive shared`. |
| `@SeekDeep archive status` | Show your archive status. |
| `@SeekDeep archive status @user` | Show a user's archive status. |
| `@SeekDeep archive status shared` | Show shared archive status. |
| `@SeekDeep archive count set <number>` | Manually set the count for your archive thread (admin only). |
| `@SeekDeep archive count @user set <number>` | Same for another user (admin only). |
| `@SeekDeep archive search <query>` | Text-search prompts in your archive thread. |
| `/archivestatus` | Slash-command archive status. |
| `/recent kind:archive` | Newest 10 entries in your archive thread. |

Each archive thread entry has:

- A **Download** link button (full-resolution CDN URL).
- A grey **Delete from Archive** button that removes that single entry and updates the thread's count.

**Natural-language archive** of the most recent SeekDeep image in the channel (no button click required):

```text
@SeekDeep archive this | archive it | archive too | archive that | archive the image
@SeekDeep save this | save it | save the image
@SeekDeep add this to my archive | put it in my archive | make it archive too
@SeekDeep share this | shared archive this | save to shared archive
```

## Recent, Cache, And Queue

| Command | Purpose |
|---------|---------|
| `@SeekDeep recent images [limit]` | Show recent image generations (defaults to 5, max 10). |
| `@SeekDeep recent prompts` | Show recent prompts for the current context. |
| `@SeekDeep recent errors` | Show recent bot-side errors. |
| `@SeekDeep changelog` | Show the last 10 git commits. |
| `@SeekDeep cache status` | Show temporary image cache status. |
| `@SeekDeep queue status` | Show current image queue status. |
| `@SeekDeep stats` | Server-wide totals + top contributors. |
| `@SeekDeep stats me` | Your activity in this server. |
| `/recent kind:images\|prompts\|archive` | Slash-command recent history. |
| `/cachestatus` | Slash-command cache status. |
| `/changelog` | Slash-command git log (last 10 commits). |
| `/status` | Slash-command local backend status. |

## Admin / Customization

Admin-only commands require `Manage Messages`, `Administrator`, or membership in `SEEKDEEP_ADMIN_IDS`.

| Command | Purpose |
|---------|---------|
| `@SeekDeep persona [channel\|server] [neurotic\|unsettling\|clinical\|chaotic\|reset\|show]` | Set or display the persona for this channel / server. |
| `@SeekDeep memory preset add <preset-name>` | Layer a behavior preset onto your chats. Presets: `brief`, `expert`, `no-emoji`, `formal`, `casual`, or a custom line. |
| `@SeekDeep memory preset list` | Show your active presets. |
| `@SeekDeep memory preset remove <key>` | Remove a preset. |
| `@SeekDeep memory preset clear` | Clear all your presets. |
| `@SeekDeep digest channel here` | Set this channel as the daily-digest destination. |
| `@SeekDeep digest channel off` | Disable the daily digest for this server. |
| `/say text:<text> channel:<#channel> image_url:<url>` | Admin anonymous post. `Manage Messages` required. Strips `@everyone` / `@here` / role mentions. |

## Auto-reactions

`Manage Messages` or admin required.

| Command | Purpose |
|---------|---------|
| `@SeekDeep reactrule list` | Show this guild's auto-reaction rules + built-in toggles. |
| `@SeekDeep reactrule add <emoji> when <pattern>` | Add a rule. Pattern is substring by default; use `/regex/flag` for regex. |
| `@SeekDeep reactrule add <emoji> when <pattern> in #channel` | Restrict the rule to a channel. |
| `@SeekDeep reactrule add <emoji> for @user` | Restrict the rule to messages by a specific user. |
| `@SeekDeep reactrule remove <id>` | Remove a rule by ID. |
| `@SeekDeep reactrule toggle <id>` | Enable / disable a rule without removing it. |
| `@SeekDeep reactrule builtin long_message\|forwarded\|code_block\|image_only\|link_only on\|off` | Toggle a built-in stacking rule. All off by default. |
| `@SeekDeep reactrule export` | Attach a JSON of the current rules (use as a save slot). |
| `@SeekDeep reactrule import` | Re-create rules from an attached JSON. |

## Emoji Vault *(feature-flagged off by default)*

Set `SEEKDEEP_FEATURE_EMOJI_VAULT=on` in `.env` to enable. `Manage Messages` or admin required to use.

| Command | Purpose |
|---------|---------|
| `@SeekDeep emoji backup` | Find or create the `<Guild> — Emojis` thread, post paginated emoji previews + the JSON manifest + a ZIP of every emoji image. |
| `@SeekDeep emoji import` | Re-create emojis from an attached JSON or ZIP. Skips names that already exist. Bot needs `Manage Expressions`. |
| `@SeekDeep emoji count` | Quick count + animated/static split. |
| `@SeekDeep emoji list` | Short text list of all custom emojis. |

## Right-click Message Context Menu

Right-click any message → **Apps** → SeekDeep submenu.

| Command | Action |
|---|---|
| **Generate Image from this** | Use the message text as an image prompt, queue Original generation. |
| **Refine as Image Prompt** | Rewrite as a stronger image prompt. Refuses non-image input. Public reply by default; `SEEKDEEP_CONTEXT_REFINE_EPHEMERAL=on` makes it ephemeral. |
| **Inspect (SeekDeep)** | Ephemeral debug card: IDs, timestamps, attachments, buttons, cached state. |
| **Translate (SeekDeep)** | Translate to plain English. Public by default; `SEEKDEEP_CONTEXT_TRANSLATE_EPHEMERAL=on` makes it ephemeral. |
| **Compare with previous** | Compare this message against the prior non-bot message. Public by default; `SEEKDEEP_CONTEXT_COMPARE_EPHEMERAL=on` makes it ephemeral. |
| **Force React (SeekDeep)** *(disabled by default)* | Paginated emoji picker — up to 5 reactions. Enable with `SEEKDEEP_FEATURE_FORCE_REACT=on`. |

## Reaction Shortcuts on Bot Messages

React to a SeekDeep image message with:

| Emoji | Action |
|---|---|
| 📥 (inbox tray) | Archive the image to your personal archive thread. |
| 🗑 (wastebasket) | Delete the bot message. |
| 🔁 (counterclockwise) | Regenerate (refined). |

Only the original requester or a configured `SEEKDEEP_ADMIN_IDS` member can trigger.

Unsupported near-commands return a `Did you mean ...?` suggestion. Valid image commands are excluded from that suggestion route so they can reach image generation.
