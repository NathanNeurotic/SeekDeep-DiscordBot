# SeekDeep Slash Command Parity Audit & Report

This document audits the parity between SeekDeep's text mention (`@SeekDeep <command>`) interface and its Discord Slash Command (`/command`) interface.

## Summary Matrix

| Subsystem / Feature | Mention Command | Slash Command Equivalent | Parity Status | Notes / Rationale |
|---|---|---|---|---|
| **Chat Fallback / Ask** | `@SeekDeep <prompt>` | `/ask prompt:<text>` | ✅ Full Parity | Main conversational interface. |
| **Image Generation** | `@SeekDeep draw <prompt>` | `/image prompt:<text> ...` | ✅ Full Parity | Supports width, height, seed, raw options. |
| **Image Modifications** | Reply `@SeekDeep <edit>` | Context Menu Modals | ✅ Full Parity | Handled naturally via right-click or conversational follow-up. |
| **Vision Analysis** | `@SeekDeep describe this` | `/vision prompt:<text>` | ✅ Full Parity | Resolves attachments from context or uploads. |
| **Templates** | `@SeekDeep template [list/save/...]` | None | ❌ Mention-Only | Highly interactive template management. |
| **Auto-Reaction Rules** | `@SeekDeep reactrule [add/...]` | None | ❌ Mention-Only | Admin-only pattern rule configuration. |
| **Emoji Vault** | `@SeekDeep emoji [backup/...]` | None | ❌ Mention-Only | Admin-only command. |
| **Archive Search** | `@SeekDeep archive search <query>` | `/archive query:<text>` | ✅ Full Parity | Text search across archived posts. |
| **Archive Setup** | `@SeekDeep archive setup here` | None | ❌ Mention-Only | Configures the channel binding. |
| **Channel Status** | `@SeekDeep status` | None | ❌ Mention-Only | Fast-path channel status report. |
| **GPU / VRAM Monitoring** | `@SeekDeep gpu / gpu watch` | None | ❌ Mention-Only | Hardware telemetry. |
| **Recent Errors Log** | `@SeekDeep recent errors` | None | ❌ Mention-Only | Admin-only diagnostic tool. |
| **Model Warmup** | `@SeekDeep warmup [chat/image/...]` | None | ❌ Mention-Only | Admin-only model priming. |
| **Model Unload** | `@SeekDeep unload` | None | ❌ Mention-Only | Admin-only VRAM purge. |
| **Model Reload** | `@SeekDeep reload [chat/image/...]` | None | ❌ Mention-Only | Admin-only reload. |
| **Queue Status** | `@SeekDeep queue status` | None | ❌ Mention-Only | Shows image jobs status. |
| **Queue Clear** | `@SeekDeep queue clear` | None | ❌ Mention-Only | Admin-only queue purge. |
| **Mask Preview** | `@SeekDeep mask preview <target>` | None | ❌ Mention-Only | Phase C developer check tool. |
| **Prompt Debug** | `@SeekDeep prompt debug` | None | ❌ Mention-Only | Phase C developer check tool. |
| **Admin Status** | `@SeekDeep admin status` | None | ❌ Mention-Only | Phase D administrative overview. |
| **Permissions Check** | `@SeekDeep permissions` | None | ❌ Mention-Only | Phase D server permission diagnostic. |

---

## Command Classification

### 1. Mention Commands with Slash Equivalents
- **`/ask`**: Maps to conversational chat fallbacks.
- **`/image`**: Maps to `@SeekDeep draw/paint/generate`.
- **`/vision`**: Maps to `@SeekDeep describe/what is this`.
- **`/archive`**: Maps to `@SeekDeep archive search`.

### 2. Mention Commands without Slash Equivalents
- **Templates**: `template save`, `template list`, `template use`, `template delete`.
- **Auto-Reactions**: `reactrule add`, `reactrule list`, `reactrule remove`, `reactrule toggle`.
- **Emoji Vault**: `emoji backup`, `emoji import`, `emoji count`, `emoji list`.
- **Administration & Hardware**: `warmup`, `unload`, `reload`, `gpu`, `gpu watch`.
- **Image Queue Control**: `queue status`, `queue clear`.
- **Diagnostics & Telemetry**: `prompt debug`, `mask preview`, `admin status`, `permissions`, `recent errors`.

### 3. Slash Commands without Mention Equivalents
- **`/persona`**: Interactive modal-based channel and server-wide persona selector (modal-based input is only available via slash commands/interactions).
- **`/stats`**: Interactive chart/graph configuration interface.

---

## Intentional Gaps & Design Rationale

### Commands that SHOULD Stay Mention-Only
The following commands are intentionally omitted from slash registration due to their dependency on Discord reply-context, conversational follow-ups, or administrative nature:
1. **Interactive Image Follow-ups ("now make her wear a hat")**: Rely heavily on looking back at the channel history or the replied-to message. Stamping these as slash commands defeats the seamless natural routing flow.
2. **Warmup / Unload / Reload**: These are developer/admin utilities used to manage server hardware. Having them as slash commands clutters the public server autocomplete options for standard users.
3. **Prompt Debug & Mask Preview**: Intentionally kept as developer checks to test prompt filters and CLIPSeg thresholds. Mention-only keeps the slash profile clean.
4. **Emoji Vault & Reactrule**: Admin-only setups that are infrequently run. Storing and displaying rules is much more compact in text channels than in slash parameters.

---

## Recommended Next Slash Commands
For future expansion, we recommend porting the following commands to slash commands for user convenience:
1. **`/queue`**:
   - Subcommand `status`: View the current image queue (accessible to all).
   - Subcommand `clear` (Admin only): Clear the pending image queue.
2. **`/diagnostics`** (Admin only):
   - Subcommand `permissions`: Check bot channel/guild permissions.
   - Subcommand `status`: Check bot telemetry and local AI status (replaces `admin status`).
   - Subcommand `errors`: Check recent error logs.
3. **`/template`**:
   - Subcommand `list`: List saved user templates.
   - Subcommand `save name:<name> prompt:<prompt>`: Save a new template.
   - Subcommand `delete name:<name>`: Delete a saved template.
