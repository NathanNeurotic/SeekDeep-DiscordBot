from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_missing_mention_helpers.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")


def fail(msg):
    raise SystemExit(msg)


if "seekdeepCountBotMentionTags" not in text:
    fail("index.js does not reference seekdeepCountBotMentionTags; wrong failure state or already changed.")


helpers = r"""function seekdeepBotUserId() {
  return String(client?.user?.id || process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID || '').trim();
}

function seekdeepCountBotMentionTags(value = '') {
  const text = String(value || '');
  const botId = seekdeepBotUserId();

  if (!botId) {
    return 0;
  }

  const normalMention = new RegExp(`<@${botId}>`, 'g');
  const nicknameMention = new RegExp(`<@!${botId}>`, 'g');

  return (text.match(normalMention) || []).length + (text.match(nicknameMention) || []).length;
}

function seekdeepStripBotMentions(value = '') {
  const text = String(value || '');
  const botId = seekdeepBotUserId();

  if (!botId) {
    return text
      .replace(/\b@?SEEKOTICS\b/gi, ' ')
      .replace(/\b@?SeekDeep\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return text
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/\b@?SEEKOTICS\b/gi, ' ')
    .replace(/\b@?SeekDeep\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seekdeepMessageMentionsBot(message = null) {
  if (!message) return false;

  const botId = seekdeepBotUserId();
  const content = String(message.content || '');

  if (botId && seekdeepCountBotMentionTags(content) > 0) {
    return true;
  }

  if (botId && message.mentions?.users?.has?.(botId)) {
    return true;
  }

  return /\b@?SEEKOTICS\b/i.test(content) || /\b@?SeekDeep\b/i.test(content);
}
"""

if "function seekdeepCountBotMentionTags" not in text:
    # Put these before messageCreate handler because the error is inside that handler.
    pos = text.find("client.on('messageCreate'")
    if pos < 0:
        pos = text.find('client.on("messageCreate"')
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    if pos < 0:
        fail("Could not find client handler insertion point.")

    text = text[:pos] + helpers + "\n\n" + text[pos:]


# Optional: if code strips bot mentions manually in a fragile way later, leave it alone.
# The missing symbol is the immediate hard crash.

for needle, label in [
    ("function seekdeepBotUserId", "bot id helper"),
    ("function seekdeepCountBotMentionTags", "mention count helper"),
    ("function seekdeepStripBotMentions", "strip helper"),
    ("function seekdeepMessageMentionsBot", "mentions helper"),
]:
    if needle not in text:
        fail(f"Missing required helper after patch: {label}")

for bad in ["}, target = null) {", "state = {) {", "state = {,"]:
    if bad in text:
        fail(f"Malformed code detected after patch: {bad}")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched missing mention helpers.")