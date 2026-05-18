# SeekDeep Commands

Use one command per Discord message when smoke-testing routing. SeekDeep accepts the canonical mention `@SeekDeep`, direct bot mentions, and valid leading bot-role mentions.

**Permission key:** Everyone = any server member. Admin = `Administrator`, `Manage Server`, `Manage Channels`, or `SEEKDEEP_ADMIN_IDS`. Manage Msgs = `Manage Messages` or Admin.

## Start And Status

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep help` | Show the full in-Discord command map. | Everyone |
| `@SeekDeep help <topic>` | Show only one section. Topics: `start`, `chat`, `image`, `vision`, `archive`, `model`, `recent`, `admin`, `reactrule`, `emoji`, `context`, `all`. | Everyone |
| `@SeekDeep help search <query>` | Fuzzy-search all commands for a keyword. | Everyone |
| `@SeekDeep archive help` | Show help, archive section only. | Everyone |
| `@SeekDeep status` | Show local AI server, model, runtime, queue, and response status. | Everyone |
| `@SeekDeep ping` | Lightweight bot availability check. | Everyone |
| `@SeekDeep what model are you using?` | Show configured local model information. | Everyone |
| `/help topic:<choice> search:<query>` | Slash equivalent with optional fuzzy search. | Everyone |
| `/status verbose:true` | Slash status with the full chat-roles map + cache/map-size diagnostics. | Everyone |

## Chat, Web, And Prompting

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep ask <question>` | Ask the local chat model. | Everyone |
| `@SeekDeep refine <prompt>` | Rewrite or improve a prompt with the local chat model. | Everyone |
| `/ask prompt:<text> web:auto\|off\|always` | Slash-command chat entrypoint. | Everyone |
| `/refine prompt:<text>` | Slash-command prompt rewrite entrypoint. | Everyone |

`web:auto` lets SeekDeep decide whether SearXNG is needed. Use `web:off` for local-only answers. Use `web:always` to force a search.

Replying to any non-English message with `@SeekDeep translate this` (or just `translate`) auto-routes to translation.

## Image Generation

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep show me <subject>` | Generate an image. | Everyone |
| `@SeekDeep draw/make/create/render/paint/sketch/illustrate/design <subject>` | Generate an image (all verbs equivalent). | Everyone |
| `@SeekDeep regenerate` | Regenerate the most recent image prompt when available. | Everyone |
| `/image prompt:<text> width:<n> height:<n> seed:<n>` | Slash-command image generation. | Everyone |
| `/image ... quality:low\|standard\|high` | Image quality preset (12 / 28 / 40 inference steps). | Everyone |
| `/image ... style:anime\|photoreal\|pixel\|oil-painting\|cyberpunk\|cottagecore\|cinematic\|3d-render\|sketch\|watercolor` | Pre-baked style modifier. | Everyone |
| `/regen mode:refined\|original\|both` | Regenerate the latest channel image. | Everyone |
| `@SeekDeep img2img <prompt>` | Transform an attached/replied/recent image with a text prompt. | Everyone |
| `/img2img image:<file> prompt:<text> strength:0.6` | Slash img2img. Strength 0.05-1.0. | Everyone |
| `@SeekDeep upscale [2x\|3x\|4x]` | Upscale an attached/replied/recent image. | Everyone |
| `/upscale image:<file> scale:2\|3\|4` | Slash upscale. | Everyone |

If the subject is missing, for example `@SeekDeep generate me`, SeekDeep asks what to generate and consumes the next plain reply as the image subject.

Image requests offer `Original`, `Refined`, and `Both` choices. Refined prompts use the local chat model dynamically, then fall back to static cleanup if refinement fails.

Image result buttons:

- `Download` (full-resolution CDN URL)
- `Archive` (your personal thread)
- `Shared Archive` (server-wide thread)

Use `raw`, `unrefined`, `--raw`, or `no refine` in a prompt when you want to skip refinement.

**Iterative tweaks** — after the bot has generated an image in this channel, follow up with phrases like "now make her wear a hat" / "with sunglasses" / "same but in winter" / "make it black and white". SeekDeep extends the prior refined prompt instead of starting fresh.

## Vision

| Command | Purpose | Permission |
|---------|---------|------------|
| Reply to an image/video with `@SeekDeep what is this?` | Analyze the replied-to media. | Everyone |
| Reply to a forwarded image with the same prompt | Walks `messageSnapshots` to find the underlying image. | Everyone |
| `/vision file:<upload> prompt:<question> mode:describe\|ocr` | Slash-command vision analysis. OCR mode extracts text. | Everyone |
| `@SeekDeep tell me more about this image` | Re-runs vision on the cached attachment (within ~10 min). | Everyone |

## Archive — Setup

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep archive config` | Show archive configuration status. | Admin |
| `@SeekDeep archive setup here` | Configure the current channel as the server archive channel. | Admin |
| `@SeekDeep setup archive here` | Alias for archive setup in the current channel. | Admin |
| `@SeekDeep archive setup #channel` | Configure a mentioned channel as the server archive channel. | Admin |

## Archive — Use

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep archive me` | Open or create your personal archive thread. | Everyone |
| `@SeekDeep archive @user` | Open or create another user's archive thread when permitted. | Everyone |
| `@SeekDeep archive shared` | Open or create the shared archive thread. | Everyone |
| `@SeekDeep archive status` | Show your archive status. | Everyone |
| `@SeekDeep archive status @user` | Show a user's archive status. | Everyone |
| `@SeekDeep archive count set <number>` | Manually set the count for your archive thread. | Admin |
| `@SeekDeep archive count @user set <number>` | Set another user's count. | Admin |
| `@SeekDeep archive search <query>` | Text-search prompts in your archive thread. | Everyone |
| `@SeekDeep archive clean older than <duration>` | Preview old entries for bulk deletion (e.g. `7d`, `2w`, `1m`). | Everyone |
| `@SeekDeep archive clean confirm` | Confirm pending bulk deletion (2-min TTL). | Everyone |
| `/archivestatus` | Slash-command archive status. | Everyone |
| `/recent kind:archive` | Newest 10 entries in your archive thread. | Everyone |

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

## Search And Templates

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep search <query>` | Search recent conversations in this channel by keyword. | Everyone |
| `/search query:<keywords>` | Slash conversation search. | Everyone |
| `@SeekDeep template save <name>: <prompt>` | Save a reusable image prompt template. | Everyone |
| `@SeekDeep template list` | Show your saved templates. | Everyone |
| `@SeekDeep template use <name>` | Generate an image from a saved template. | Everyone |
| `@SeekDeep template delete <name>` | Remove a template. | Everyone |
| `/template action:save\|list\|use\|delete name:<n> prompt:<p>` | Slash template management. | Everyone |

## Recent, Cache, And Queue

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep recent images [limit]` | Show recent image generations (defaults to 5, max 10). | Everyone |
| `@SeekDeep recent prompts` | Show recent prompts for the current context. | Everyone |
| `@SeekDeep recent errors` | Show recent bot-side errors. | Everyone |
| `@SeekDeep changelog` | Show the last 10 git commits. | Everyone |
| `@SeekDeep cache status` | Show temporary image cache status. | Everyone |
| `@SeekDeep queue status` | Show current image queue status. | Everyone |
| `@SeekDeep stats` | Server-wide totals + top contributors. | Everyone |
| `@SeekDeep stats me` | Your activity in this server. | Everyone |
| `@SeekDeep stats chart` | 30-day activity chart image (images, chats, vision). | Everyone |
| `/stats scope:server\|me\|chart` | Slash-command stats with optional chart. | Everyone |
| `/recent kind:images\|prompts\|archive` | Slash-command recent history. | Everyone |
| `/cachestatus` | Slash-command cache status. | Everyone |
| `/changelog` | Slash-command git log (last 10 commits). | Everyone |
| `/status` | Slash-command local backend status. | Everyone |
| `@SeekDeep gpu` / `@SeekDeep vram` | One-shot GPU + VRAM snapshot. | Everyone |
| `@SeekDeep gpu watch [N]` / `vram watch [N]` | Live-tail VRAM every N sec (default 5, max 2 min). React ✋ to stop. | Everyone |
| `/gpu watch:true interval:5` | Slash live-tail GPU. | Everyone |

## Admin / Customization

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep persona [channel\|server] [neurotic\|unsettling\|clinical\|chaotic\|reset\|show]` | Set or display the persona. | Admin |
| `/persona` | Open the persona editor modal (interactive popup). | Manage Guild |
| `@SeekDeep memory preset add <preset-name>` | Layer a behavior preset. Presets: `brief`, `expert`, `no-emoji`, `formal`, `casual`. | Everyone |
| `@SeekDeep memory preset list` | Show your active presets. | Everyone |
| `@SeekDeep memory preset remove <key>` | Remove a preset. | Everyone |
| `@SeekDeep memory preset clear` | Clear all your presets. | Everyone |
| `@SeekDeep digest channel here` | Set this channel as the daily-digest destination. | Admin |
| `@SeekDeep digest channel off` | Disable the daily digest for this server. | Admin |
| `@SeekDeep translate channel here` | Enable auto-translate for non-Latin messages in this channel. | Admin |
| `@SeekDeep translate channel off` | Disable auto-translate for this server. | Admin |
| `/say text:<text> channel:<#channel> image_url:<url>` | Admin anonymous post. | Manage Msgs |

## Auto-reactions

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep reactrule list` | Show this guild's auto-reaction rules + built-in toggles. | Manage Msgs |
| `@SeekDeep reactrule add <emoji> when <pattern>` | Add a rule. Pattern is substring; use `/regex/flag` for regex. | Manage Msgs |
| `@SeekDeep reactrule add <emoji> when <pattern> in #channel` | Restrict the rule to a channel. | Manage Msgs |
| `@SeekDeep reactrule add <emoji> for @user` | Restrict the rule to a user. | Manage Msgs |
| `@SeekDeep reactrule remove <id>` | Remove a rule by ID. | Manage Msgs |
| `@SeekDeep reactrule toggle <id>` | Enable / disable a rule. | Manage Msgs |
| `@SeekDeep reactrule builtin <name> on\|off` | Toggle a built-in stacking rule. | Manage Msgs |
| `@SeekDeep reactrule export` | Attach a JSON of the current rules. | Manage Msgs |
| `@SeekDeep reactrule import` | Re-create rules from an attached JSON. | Manage Msgs |

## Emoji Vault *(feature-flagged off by default)*

Set `SEEKDEEP_FEATURE_EMOJI_VAULT=on` in `.env` to enable.

| Command | Purpose | Permission |
|---------|---------|------------|
| `@SeekDeep emoji backup` | Create the emoji thread with paginated previews + JSON + ZIP. | Manage Msgs |
| `@SeekDeep emoji import` | Re-create emojis from an attached JSON or ZIP. Bot needs `Manage Expressions`. | Manage Msgs |
| `@SeekDeep emoji count` | Quick count + animated/static split. | Manage Msgs |
| `@SeekDeep emoji list` | Short text list of all custom emojis. | Manage Msgs |

## Right-click Message Context Menu

Right-click any message → **Apps** → SeekDeep submenu.

| Command | Action | Permission |
|---------|--------|------------|
| **Generate Image from this** | Use the message text as an image prompt. | Everyone |
| **Refine as Image Prompt** | Rewrite as a stronger image prompt. | Everyone |
| **Inspect (SeekDeep)** | Ephemeral debug card: IDs, timestamps, attachments. | Everyone |
| **Translate (SeekDeep)** | Translate to plain English. | Everyone |
| **Compare with previous** | Compare this message against the prior non-bot message. | Everyone |
| **Force React (SeekDeep)** *(disabled by default)* | Paginated emoji picker. Enable with `SEEKDEEP_FEATURE_FORCE_REACT=on`. | Everyone |

## Reaction Shortcuts on Bot Messages

React to a SeekDeep image message with:

| Emoji | Action | Permission |
|-------|--------|------------|
| 📥 (inbox tray) | Archive the image to your personal archive thread. | Requester / Admin |
| 🗑 (wastebasket) | Delete the bot message. | Requester / Admin |
| 🔁 (counterclockwise) | Regenerate (refined). | Requester / Admin |

Unsupported near-commands return a `Did you mean ...?` suggestion. Valid image commands are excluded from that suggestion route so they can reach image generation.
