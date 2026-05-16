# SeekDeep Commands

Use one command per Discord message when smoke-testing routing. SeekDeep accepts the canonical mention `@SeekDeep`, direct bot mentions, and valid leading bot-role mentions.

## Start And Status

| Command | Purpose |
|---------|---------|
| `@SeekDeep help` | Show the full in-Discord command map. |
| `@SeekDeep archive help` | Show command help, including archive commands. |
| `@SeekDeep status` | Show local AI server, model, runtime, queue, and response status. |
| `@SeekDeep ping` | Lightweight bot availability check. |
| `@SeekDeep what model are you using?` | Show configured local model information. |

## Chat, Web, And Prompting

| Command | Purpose |
|---------|---------|
| `@SeekDeep ask <question>` | Ask the local chat model. |
| `@SeekDeep refine <prompt>` | Rewrite or improve a prompt with the local chat model. |
| `/ask prompt:<text> web:auto|off|always` | Slash-command chat entrypoint. |
| `/refine prompt:<text>` | Slash-command prompt rewrite entrypoint. |

`web:auto` lets SeekDeep decide whether SearXNG is needed. Use `web:off` for local-only answers.

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

If the subject is missing, for example `@SeekDeep generate me`, SeekDeep asks what to generate and consumes the next plain reply as the image subject.

Image requests offer `Original`, `Refined`, and `Both` choices. Refined prompts use the local chat model dynamically, then fall back to static cleanup if refinement fails.

Image result buttons:

- `Download`
- `Archive`
- `Shared Archive`

Use `raw`, `unrefined`, `--raw`, or `no refine` in a prompt when you want to skip refinement.

## Vision

| Command | Purpose |
|---------|---------|
| Reply to an image/video with `@SeekDeep what is this?` | Analyze the replied-to media. |
| `/vision file:<upload> prompt:<question>` | Slash-command vision analysis. |

## Archive Setup

Archive setup changes are restricted to server admins, users with Manage Server, users with Manage Channels, or configured SeekDeep admins.

| Command | Purpose |
|---------|---------|
| `@SeekDeep archive config` | Show archive configuration status. |
| `@SeekDeep archive setup here` | Configure the current channel as the server archive channel and bootstrap shared archive state. |
| `@SeekDeep setup archive here` | Alias for archive setup in the current channel. |
| `@SeekDeep archive setup #channel` | Configure a mentioned channel as the server archive channel. |

## Archive Use

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
| `/archivestatus` | Slash-command archive status. |

Archive thread names count archived generation entries, not general messages.

## Recent, Cache, And Queue

| Command | Purpose |
|---------|---------|
| `@SeekDeep recent images [limit]` | Show recent image generations. |
| `@SeekDeep recent prompts` | Show recent prompts for the current context. |
| `@SeekDeep cache status` | Show temporary image cache status. |
| `@SeekDeep queue status` | Show current image queue status. |
| `/recent kind:images|prompts` | Slash-command recent history. |
| `/cachestatus` | Slash-command cache status. |
| `/status` | Slash-command local backend status. |

Unsupported near-commands return a `Did you mean ...?` suggestion. Valid image commands are excluded from that suggestion route so they can reach image generation.
