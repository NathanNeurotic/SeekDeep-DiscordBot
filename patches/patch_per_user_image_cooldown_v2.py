from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_per_user_image_cooldown_v2.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_once(haystack, old, new, label):
    count = haystack.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one anchor for {label}, found {count}.")
    return haystack.replace(old, new, 1)

def insert_before(haystack, anchor, insertion, label):
    require_contains(haystack, anchor, label)
    return haystack.replace(anchor, insertion + "\n" + anchor, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "function isNaturalImagePrompt(prompt)", "natural image prompt detector")
require_contains(text, "client.on('messageCreate'", "message dispatcher")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

cooldown_block = r"""
// SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START
const SEEKDEEP_IMAGE_USER_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.SEEKDEEP_IMAGE_USER_COOLDOWN_SECONDS || '45') * 1000
);

const seekdeepImageUserCooldowns = new Map();

function seekdeepImageCooldownKeyFromSource(source) {
  return String(source?.author?.id || source?.user?.id || source?.member?.user?.id || 'unknown').trim() || 'unknown';
}

function seekdeepIsImageCooldownBypassed(source) {
  try {
    const member = source?.member;
    const permissions = member?.permissions;

    if (permissions && typeof permissions.has === 'function') {
      if (permissions.has('Administrator') || permissions.has('ManageGuild') || permissions.has('ManageMessages')) {
        return true;
      }
    }
  } catch {}

  return false;
}

function seekdeepCheckImageUserCooldown(source, now = Date.now()) {
  if (!SEEKDEEP_IMAGE_USER_COOLDOWN_MS) {
    return { allowed: true, remainingMs: 0, cooldownMs: 0, key: seekdeepImageCooldownKeyFromSource(source) };
  }

  if (seekdeepIsImageCooldownBypassed(source)) {
    return { allowed: true, remainingMs: 0, cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS, key: seekdeepImageCooldownKeyFromSource(source), bypassed: true };
  }

  const key = seekdeepImageCooldownKeyFromSource(source);
  const lastAt = Number(seekdeepImageUserCooldowns.get(key) || 0);
  const elapsed = now - lastAt;
  const remainingMs = SEEKDEEP_IMAGE_USER_COOLDOWN_MS - elapsed;

  if (lastAt && remainingMs > 0) {
    return {
      allowed: false,
      remainingMs,
      cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS,
      key,
    };
  }

  return {
    allowed: true,
    remainingMs: 0,
    cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS,
    key,
  };
}

function seekdeepClaimImageUserCooldown(source, now = Date.now()) {
  const check = seekdeepCheckImageUserCooldown(source, now);

  if (!check.allowed) return check;

  if (check.cooldownMs && !check.bypassed) {
    seekdeepImageUserCooldowns.set(check.key, now);
  }

  return check;
}

function seekdeepResetImageUserCooldown(source) {
  const key = seekdeepImageCooldownKeyFromSource(source);
  seekdeepImageUserCooldowns.delete(key);
}

function seekdeepImageCooldownReplyText(check) {
  const seconds = Math.max(1, Math.ceil(Number(check?.remainingMs || 0) / 1000));
  return `Image cooldown active. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

async function seekdeepReplyImageCooldown(source, check) {
  const content = seekdeepAppendResponseFooter(seekdeepImageCooldownReplyText(check), {
    startedAt: source?.__seekdeepRequestStartedAt,
    modelUsed: seekdeepNoModelLabel(),
  });

  if (typeof source?.reply === 'function') {
    const payload = {
      content,
      allowedMentions: { repliedUser: false },
    };

    try {
      if (typeof source?.isRepliable === 'function' && source.isRepliable()) {
        payload.ephemeral = true;
      }
    } catch {}

    return await source.reply(payload);
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    return await source.channel.send({ content });
  }

  return null;
}
// SEEKDEEP_PER_USER_IMAGE_COOLDOWN_END
"""

if "SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START" not in text:
    text = insert_before(
        text,
        "function seekdeepEnqueueImageJob(job, runner)",
        cooldown_block,
        "image queue helper insertion point",
    )

# Patch the normal text image route. This uses an intentionally broad but bounded
# replacement over the exact dispatcher route block, not brittle unrelated anchors.
if "seekdeepClaimImageUserCooldown(message)" not in text:
    pattern = re.compile(
        r"""    if \(isNaturalImagePrompt\(prompt\)\) \{\n"""
        r"""      seekdeepLogRoute\('image', prompt\);\n"""
        r"""      remember\(key, 'user', prompt\);\n"""
        r"""      remember\(key, 'assistant', 'Queued local image generation\.'\);\n"""
        r"""      const imagePrompt = (?P<imageprompt>.*?);\n"""
        r"""      await handleImagePrompt\(message, imagePrompt\);\n"""
        r"""      return;\n"""
        r"""    \}""",
        re.S,
    )

    match = pattern.search(text)
    if not match:
        raise SystemExit("Could not locate natural image route block to add cooldown.")

    replacement = """    if (isNaturalImagePrompt(prompt)) {
      seekdeepLogRoute('image', prompt);
      const cooldown = seekdeepClaimImageUserCooldown(message);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(message, cooldown);
        return;
      }
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Queued local image generation.');
      const imagePrompt = prompt
        .replace(/^(?:draw|sketch|paint|illustrate|render)\\s+me\\s+/i, '')
        .replace(/^(?:draw|sketch|paint|illustrate|render)\\s+/i, '')
        .trim() || prompt;
      try {
        await handleImagePrompt(message, imagePrompt);
      } catch (err) {
        seekdeepResetImageUserCooldown(message);
        throw err;
      }
      return;
    }"""
    text = text[:match.start()] + replacement + text[match.end():]

# Patch text regenerate route if present.
if "utilityKind === 'regenerate-image'" in text and "seekdeepRegenerateLatestImageFromMessage(message)" in text:
    if "seekdeepRegenerateLatestImageFromMessage(message);" in text and "seekdeepClaimImageUserCooldown(message);\n      if (!cooldown.allowed)" not in text:
        regen_pattern = re.compile(
            r"""    if \(utilityKind === 'regenerate-image'\) \{\n"""
            r"""      seekdeepLogRoute\('regenerate-image', prompt\);\n"""
            r"""      remember\(key, 'user', prompt\);\n"""
            r"""      remember\(key, 'assistant', 'Regenerating latest cached image\.'\);\n"""
            r"""      await seekdeepRegenerateLatestImageFromMessage\(message\);\n"""
            r"""      return;\n"""
            r"""    \}""",
            re.S,
        )

        match = regen_pattern.search(text)
        if match:
            replacement = """    if (utilityKind === 'regenerate-image') {
      seekdeepLogRoute('regenerate-image', prompt);
      const cooldown = seekdeepClaimImageUserCooldown(message);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(message, cooldown);
        return;
      }
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Regenerating latest cached image.');
      try {
        await seekdeepRegenerateLatestImageFromMessage(message);
      } catch (err) {
        seekdeepResetImageUserCooldown(message);
        throw err;
      }
      return;
    }"""
            text = text[:match.start()] + replacement + text[match.end():]

# Conservatively patch common slash /image direct branches if they exist.
slash_variants = [
    (
        """    if (commandName === 'image') {
      const prompt = interaction.options.getString('prompt', true);""",
        """    if (commandName === 'image') {
      const cooldown = seekdeepClaimImageUserCooldown(interaction);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(interaction, cooldown);
        return;
      }
      const prompt = interaction.options.getString('prompt', true);"""
    ),
    (
        """    if (interaction.commandName === 'image') {
      const prompt = interaction.options.getString('prompt', true);""",
        """    if (interaction.commandName === 'image') {
      const cooldown = seekdeepClaimImageUserCooldown(interaction);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(interaction, cooldown);
        return;
      }
      const prompt = interaction.options.getString('prompt', true);"""
    ),
]

for old, new in slash_variants:
    if old in text and new not in text:
        text = replace_once(text, old, new, "slash image cooldown branch")

# Help text is best-effort only.
if "Image cooldown:" not in text:
    for target in [
        "    'Buttons: Regenerate / Download / Archive',\n",
        "    'Text: @SEEKOTICS regenerate / regen',\n",
    ]:
        if target in text:
            text = text.replace(
                target,
                target + "    `Image cooldown: ${Math.round(SEEKDEEP_IMAGE_USER_COOLDOWN_MS / 1000)}s per user`,\n",
                1,
            )
            break

for needle, label in [
    ("SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START", "per-user cooldown helper block"),
    ("const SEEKDEEP_IMAGE_USER_COOLDOWN_MS", "cooldown duration constant"),
    ("const seekdeepImageUserCooldowns = new Map();", "cooldown user map"),
    ("function seekdeepClaimImageUserCooldown", "cooldown claim helper"),
    ("function seekdeepReplyImageCooldown", "cooldown reply helper"),
    ("seekdeepClaimImageUserCooldown(message)", "message image route cooldown claim"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with per-user image cooldown support.")