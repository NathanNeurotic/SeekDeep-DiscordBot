from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Remove any previous long-reply helper block so this patch is re-runnable.
text = re.sub(
    r"(?ms)\n*// SEEKDEEP_LONG_REPLY_HELPERS_START.*?// SEEKDEEP_LONG_REPLY_HELPERS_END\n*",
    "\n\n",
    text,
)

# Clean the previous standalone async corruption if it is still present.
text = re.sub(r"(?m)^\s*async\s*\r?\n", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# Slightly increase normal /ask budget. This does not force verbosity; it just
# avoids artificial model-side clipping on useful longer answers.
text = text.replace(
    "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = 700, temperature = 0.35, memoryKey = null } = {}) {",
    "async function askChat(prompt, { web = 'auto', system = '', maxNewTokens = Number(process.env.CHAT_MAX_NEW_TOKENS || 1400), temperature = 0.35, memoryKey = null } = {}) {",
)

helpers = r'''
// SEEKDEEP_LONG_REPLY_HELPERS_START
function splitDiscordText(value, limit = MAX_DISCORD_CHARS) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!raw) return [''];

  const fenced = raw.match(/^```([A-Za-z0-9_-]*)\n([\s\S]*)\n```$/);
  if (fenced) {
    const lang = fenced[1] || '';
    const body = fenced[2] || '';
    const overhead = 8 + lang.length;
    const innerLimit = Math.max(500, limit - overhead);
    return splitDiscordText(body, innerLimit).map((chunk) => `\`\`\`${lang}\n${chunk}\n\`\`\``);
  }

  const chunks = [];
  let remaining = raw;

  while (remaining.length > limit) {
    let cut = -1;
    const preferred = ['\n\n', '\n', '. ', '; ', ', ', ' '];

    for (const token of preferred) {
      const pos = remaining.lastIndexOf(token, limit);
      if (pos >= Math.floor(limit * 0.45)) {
        cut = pos + (token.trim() ? token.length : 0);
        break;
      }
    }

    if (cut < Math.floor(limit * 0.45)) {
      cut = limit;
    }

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}

function asTextBlock(value, lang = 'text') {
  return `\`\`\`${lang}\n${String(value ?? '').trim()}\n\`\`\``;
}

async function sendLongInteractionReply(interaction, content) {
  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = { content: chunks[i], allowedMentions: { repliedUser: false } };

    if (i === 0) {
      previous = await safeEditOrReply(interaction, payload);
      if (!previous && typeof interaction.fetchReply === 'function') {
        previous = await interaction.fetchReply().catch(() => null);
      }
      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (interaction.channel && typeof interaction.channel.send === 'function') {
      previous = await interaction.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}

async function sendLongMessageReply(message, content) {
  const chunks = splitDiscordText(content);
  let previous = null;

  for (let i = 0; i < chunks.length; i++) {
    const payload = { content: chunks[i], allowedMentions: { repliedUser: false } };

    if (i === 0) {
      previous = await message.reply(payload);
      continue;
    }

    if (previous && typeof previous.reply === 'function') {
      previous = await previous.reply(payload);
    } else if (message.channel && typeof message.channel.send === 'function') {
      previous = await message.channel.send(payload);
    } else {
      console.error('Could not send follow-up chunk; no previous message or channel is available.');
      break;
    }
  }

  return previous;
}
// SEEKDEEP_LONG_REPLY_HELPERS_END

'''

insert_at = text.find("client.on('interactionCreate'")
if insert_at == -1:
    insert_at = text.find('client.on("interactionCreate"')
if insert_at == -1:
    raise SystemExit("Could not find interactionCreate handler insertion point.")

text = text[:insert_at].rstrip() + "\n\n" + helpers + text[insert_at:].lstrip()

# Replace truncating response sends with chained long replies.
text = text.replace(
    "await safeEditOrReply(interaction, '```text\\n' + clampText(await statusText(), 1800) + '\\n```');",
    "await sendLongInteractionReply(interaction, asTextBlock(await statusText()));",
)

text = text.replace(
    "await safeEditOrReply(interaction, clampText(answer));",
    "await sendLongInteractionReply(interaction, answer);",
)

text = text.replace(
    "await safeEditOrReply(interaction, '```text\\n' + clampText(answer, 1800) + '\\n```');",
    "await sendLongInteractionReply(interaction, asTextBlock(answer));",
)

text = text.replace(
    "await message.reply(clampText(answer));",
    "await sendLongMessageReply(message, answer);",
)

text = text.replace(
    "await message.reply(clampText(`SeekDeep request failed.\\n\\nError:\\n${err.message}`));",
    "await sendLongMessageReply(message, `SeekDeep request failed.\\n\\nError:\\n${err.message}`);",
)

text = re.sub(
    r"await safeEditOrReply\(interaction, clampText\(\[([\s\S]*?)\]\.join\('\\n'\)\)\);",
    r"await sendLongInteractionReply(interaction, [\1].join('\n'));",
    text,
    count=1,
)

# Verify generated-answer paths no longer use clampText(answer).
if re.search(r"clampText\(answer", text):
    raise SystemExit("Patch failed: clampText(answer) is still present.")

# Verify the new helpers exist.
required = [
    "function splitDiscordText",
    "async function sendLongInteractionReply",
    "async function sendLongMessageReply",
    "previous = await previous.reply(payload)",
]
missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

p.write_text(text, encoding="utf-8")
print("Chained long-reply support added. Generated answers will split instead of truncating.")
