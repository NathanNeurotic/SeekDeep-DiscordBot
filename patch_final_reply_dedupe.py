from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

# Clean known old patch damage if present.
text = re.sub(r"(?m)^\s*async\s*$\r?\n?", "", text)
text = text.replace(
    "async function askVisionasync function askVision",
    "async function askVision"
)

# Add final reply dedupe globals once.
dedupe_block = r'''
// SEEKDEEP_FINAL_REPLY_DEDUPE_START
const SEEKDEEP_FINAL_REPLY_TTL_MS = Number(process.env.SEEKDEEP_FINAL_REPLY_TTL_MS || 180000);
const seekdeepFinalReplyClaims = new Map();

function seekdeepClaimFinalReply(kind, id) {
  if (!id) return true;

  const now = Date.now();

  for (const [key, expires] of seekdeepFinalReplyClaims.entries()) {
    if (expires <= now) seekdeepFinalReplyClaims.delete(key);
  }

  const key = `${kind}:${id}`;

  if (seekdeepFinalReplyClaims.has(key) && seekdeepFinalReplyClaims.get(key) > now) {
    console.warn(`Duplicate final reply suppressed for ${key}`);
    return false;
  }

  seekdeepFinalReplyClaims.set(key, now + SEEKDEEP_FINAL_REPLY_TTL_MS);
  return true;
}
// SEEKDEEP_FINAL_REPLY_DEDUPE_END

'''

if "SEEKDEEP_FINAL_REPLY_DEDUPE_START" not in text:
    insert_pos = text.find("async function sendLongInteractionReply")
    if insert_pos == -1:
        insert_pos = text.find("async function sendLongMessageReply")
    if insert_pos == -1:
        insert_pos = text.find("client.on('interactionCreate'")
    if insert_pos == -1:
        insert_pos = text.find('client.on("interactionCreate"')
    if insert_pos == -1:
        raise SystemExit("Could not find insertion point for final reply dedupe block.")

    text = text[:insert_pos].rstrip() + "\n\n" + dedupe_block + text[insert_pos:].lstrip()

def insert_after_function_open(src: str, signature: str, marker: str, injection: str) -> str:
    pos = src.find(signature)
    if pos == -1:
        raise SystemExit(f"Could not find function signature: {signature}")

    # Avoid duplicate insertion inside this function.
    next_func = src.find("\nasync function ", pos + len(signature))
    if next_func == -1:
        next_func = src.find("\nfunction ", pos + len(signature))
    if next_func == -1:
        next_func = len(src)

    if marker in src[pos:next_func]:
        return src

    brace = src.find("{", pos)
    if brace == -1:
        raise SystemExit(f"Could not find opening brace for {signature}")

    return src[:brace + 1] + injection + src[brace + 1:]

# Suppress duplicate generated replies to the same original Discord message.
text = insert_after_function_open(
    text,
    "async function sendLongMessageReply(message, content)",
    "SEEKDEEP_FINAL_MESSAGE_REPLY_DEDUPE",
    r'''
  // SEEKDEEP_FINAL_MESSAGE_REPLY_DEDUPE
  if (!seekdeepClaimFinalReply('message', message?.id)) {
    return null;
  }
'''
)

# Suppress duplicate generated replies to the same slash interaction.
text = insert_after_function_open(
    text,
    "async function sendLongInteractionReply(interaction, content)",
    "SEEKDEEP_FINAL_INTERACTION_REPLY_DEDUPE",
    r'''
  // SEEKDEEP_FINAL_INTERACTION_REPLY_DEDUPE
  if (!seekdeepClaimFinalReply('interaction', interaction?.id)) {
    return null;
  }
'''
)

# Extra protection: if message path bypasses sendLongMessageReply and directly uses message.reply,
# mark the event as claimed near prompt normalization.
if "SEEKDEEP_MESSAGE_EARLY_FINAL_CLAIM" not in text:
    handler_pos = text.find("client.on('messageCreate'")
    if handler_pos == -1:
        handler_pos = text.find('client.on("messageCreate"')

    if handler_pos != -1:
        handler_end = text.find("client.on(", handler_pos + 20)
        if handler_end == -1:
            handler_end = len(text)

        handler = text[handler_pos:handler_end]
        m = re.search(r"(?m)^(\s*const\s+prompt\s*=\s*normalizeUserText\([^\n]+;\s*)$", handler)

        if m:
            injection = r'''
  // SEEKDEEP_MESSAGE_EARLY_FINAL_CLAIM
  if (!seekdeepClaimFinalReply('message-start', message?.id)) {
    console.warn(`Duplicate message handler path suppressed before generation: ${message?.id}`);
    return;
  }
'''
            abs_pos = handler_pos + m.end()
            text = text[:abs_pos] + injection + text[abs_pos:]
        else:
            print("Warning: could not insert early message final-claim guard. Final send guard still applied.")
    else:
        print("Warning: could not find messageCreate handler. Final send guard still applied.")

required = [
    "SEEKDEEP_FINAL_REPLY_DEDUPE_START",
    "seekdeepClaimFinalReply",
    "SEEKDEEP_FINAL_MESSAGE_REPLY_DEDUPE",
    "SEEKDEEP_FINAL_INTERACTION_REPLY_DEDUPE",
]

missing = [x for x in required if x not in text]
if missing:
    raise SystemExit("Patch failed; missing markers: " + ", ".join(missing))

# Sanity checks.
if re.search(r"(?m)^\s*async\s*$", text):
    raise SystemExit("Standalone async line exists after patch.")

if "askVisionasync" in text:
    raise SystemExit("askVisionasync corruption exists after patch.")

bad_join = re.search(r"\.join\(['\"]\s*\r?\n\s*['\"]\)", text)
if bad_join:
    raise SystemExit("Malformed multiline .join string exists after patch.")

p.write_text(text, encoding="utf-8")
print("Final outgoing reply dedupe patched.")
