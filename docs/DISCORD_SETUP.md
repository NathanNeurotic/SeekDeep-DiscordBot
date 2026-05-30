# Discord Developer Portal setup for SeekDeep

This is the exact Discord-side configuration SeekDeep needs. It's tied to what
the bot's code actually requests — so if you follow it, you won't hit the
common traps (the 4014 "Disallowed intent" respawn loop, the bot ignoring DMs,
or "the bot is online but never answers").

You'll end up filling two values in your `.env`:

```env
DISCORD_TOKEN=          # required — the bot token
DISCORD_CLIENT_ID=      # optional — the Application ID (used for diagnostics only)
```

Everything else is portal configuration. Open <https://discord.com/developers/applications>.

---

## 1. Create the application

**New Application** → name it (e.g. `SeekDeep`) → Create.

On **General Information**, copy the **Application ID** → this is your
`DISCORD_CLIENT_ID` (optional, but the doctor/diagnostics use it).

## 2. Add the bot + get the token

**Bot** (left sidebar) → the bot user is created automatically in v2 apps.

- **Reset Token** → copy it → this is your `DISCORD_TOKEN`. **Treat it like a
  password.** If you ever paste it anywhere public, reset it here.
- (Optional) turn **Public Bot** off if you don't want others adding it.

## 3. Privileged Gateway Intents — the part that actually matters

Still on the **Bot** page, scroll to **Privileged Gateway Intents**. SeekDeep's
code requests these, and Discord **rejects the gateway connection** if the code
asks for a privileged intent whose toggle is off here.

| Intent | SeekDeep needs it? | Turn it on if… |
|---|---|---|
| **Message Content Intent** | **YES — required** | always. The bot reads message text for `@SeekDeep` mentions, replies, and DM prompts. Without it, the bot connects but never sees what you typed. |
| **Server Members Intent** | only for join/leave logging | you set `JOIN_LEAVE_CHANNEL_ID` in `.env`. SeekDeep only requests this intent **when that var is set**, so leave it OFF otherwise. |
| **Presence Intent** | no | never — SeekDeep doesn't use it. |

> ⚠️ **The 4014 trap.** If `JOIN_LEAVE_CHANNEL_ID` is set in `.env` **but** Server
> Members Intent is OFF here, Discord closes the connection with code **4014
> (Disallowed intent)**. SeekDeep detects this, prints an actionable message, and
> exits with code 42 instead of respawn-looping. Fix it by either flipping
> Server Members Intent ON here, **or** unsetting `JOIN_LEAVE_CHANNEL_ID`.

The **non-privileged** intents SeekDeep also uses — `Guilds`, `GuildMessages`,
`DirectMessages`, `GuildMessageReactions` — need **no portal toggle**. They're
requested in code automatically. (DirectMessages is what lets the bot receive
typed DMs — see §6.)

## 4. Installation: scopes, contexts, and permissions

Go to **Installation** (left sidebar). This is where you choose *how* the app is
added and *what* it can do.

### Install contexts
- **Guild Install** — the bot joins servers. Needed for normal server use.
- **User Install** — the app's slash commands follow a user into DMs/other
  servers. Optional; enable it if you want `/ask` etc. available in any DM.

### Scopes
Set these under the install settings (or build them into your invite URL):

```txt
Guild Install:  bot   applications.commands
User Install:   applications.commands
```

Do **not** add the scary scopes (`dm_channels.messages.read`,
`messages.read`, etc.) — SeekDeep doesn't use them and they aren't the fix for
anything.

### Bot permissions
SeekDeep's features map to these permissions. The first block is the minimum to
work; the rest unlock specific features.

| Permission | Why |
|---|---|
| **View Channels** | see channels it operates in |
| **Send Messages** | reply to you |
| **Embed Links** | rich embeds (status, join/leave cards) |
| **Attach Files** | send generated images + vision results |
| **Read Message History** | reply-context, "reply to keep chatting" |
| **Add Reactions** | auto-reactions + the 📥 archive button |
| **Use Application (Slash) Commands** | granted by the `applications.commands` scope |
| Create Public Threads + Send Messages in Threads | **archive** feature (threads in the archive channel) |
| Manage Expressions (Emojis & Stickers) | **emoji-vault** feature only (optional) |

> Tip: the **OAuth2 → URL Generator** lets you tick `bot` + `applications.commands`
> and the permission checkboxes above, then copy a ready-made invite URL. That's
> less error-prone than hand-building a `permissions=` integer.

## 5. Add the bot to your server

Open the generated invite URL (or use the Installation page's "Install" link),
pick your server, and authorize. You need **Manage Server** on that server to add
a bot.

Slash commands register **globally** (SeekDeep doesn't pin them to one guild), so
they can take up to ~1 hour to appear the first time. Mentions (`@SeekDeep …`)
and DMs work immediately.

## 6. DMs (optional but nice)

A plain typed DM to the bot is treated as a chat prompt (full chat + image +
memory pipeline). Requirements:
- **Message Content Intent** ON (§3) — already required.
- The **DirectMessages** intent — requested in code, **non-privileged**, no portal
  toggle.
- `SEEKDEEP_DM_CHAT_ENABLED=on` in `.env` (the default).

Note: this works when the bot is a real bot user you can DM. In **user-install-only**
contexts (the bot isn't actually a member), Discord does not stream typed
messages to bots at all — use slash commands there.

## 7. Put it together + restart

```env
DISCORD_TOKEN=<from step 2>
DISCORD_CLIENT_ID=<from step 1, optional>
# optional features:
# JOIN_LEAVE_CHANNEL_ID=<channel id>   # also flip Server Members Intent ON (§3)
# SEEKDEEP_ALLOWED_CHANNELS=           # comma-sep channel IDs to restrict the bot (DMs bypass this)
```

Then **restart the bot** so it re-connects with the new token/intents. On a clean
start its log prints a health report ending in `Ready. Use: /ask …`. If you set
up the join/leave logger, you'll also see
`[SeekDeep JoinLeave] enabled -> channel …`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot exits with **code 42**, log says "Disallowed intent (4014)" | `JOIN_LEAVE_CHANNEL_ID` set but Server Members Intent OFF | flip Server Members Intent ON (§3), or unset the var |
| Bot is **online but never replies** to `@mentions` | Message Content Intent OFF | turn it ON (§3) and restart |
| Bot ignores **typed DMs** | old build, or `SEEKDEEP_DM_CHAT_ENABLED=off` | update + restart; ensure DM chat is on (§6) |
| Bot replies in some channels but not others | `SEEKDEEP_ALLOWED_CHANNELS` is set | add the channel ID, or clear the allowlist |
| "Invalid token" / login fails on boot | wrong/expired `DISCORD_TOKEN` | reset the token (§2) and paste the new one |
| Slash commands don't appear | global registration still propagating | wait up to ~1h; mentions/DMs work immediately |

## Quick reference: intent → portal action

| Intent (in code) | Privileged? | Portal toggle needed | Driven by |
|---|---|---|---|
| Guilds | no | none | always |
| GuildMessages | no | none | always |
| DirectMessages | no | none | always (DM support) |
| GuildMessageReactions | no | none | always |
| **MessageContent** | **yes** | **ON (required)** | always |
| **GuildMembers** | **yes** | **ON only if** `JOIN_LEAVE_CHANNEL_ID` set | join/leave logger |
| Presence | yes | leave OFF | not used |
