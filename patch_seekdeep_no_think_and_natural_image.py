from pathlib import Path
import re

# ----------------------------
# Patch local_ai_server.py
# ----------------------------
srv_path = Path("local_ai_server.py")
srv = srv_path.read_text(encoding="utf-8")

if "import re" not in srv:
    srv = srv.replace("import os\n", "import os\nimport re\n")

old_apply = """    try:
        text = chat_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        text = f"{messages[0]['content']}\\n\\nUser: {messages[1]['content']}\\nAssistant:"""

new_apply = """    try:
        # Qwen3 tends to emit hidden thinking blocks unless explicitly disabled.
        try:
            text = chat_tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            text = chat_tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    except Exception:
        text = f"{messages[0]['content']}\\n\\nUser: {messages[1]['content']}\\nAssistant:"""

if old_apply in srv:
    srv = srv.replace(old_apply, new_apply)
else:
    raise SystemExit("Could not patch apply_chat_template block in local_ai_server.py")

old_answer = """    new_tokens = out[0][inputs["input_ids"].shape[-1]:]
    answer = chat_tokenizer.decode(new_tokens, skip_special_tokens=True, clean_up_tokenization_spaces=False).strip()
    return {"text": answer or "(empty response)"}"""

new_answer = """    new_tokens = out[0][inputs["input_ids"].shape[-1]:]
    answer = chat_tokenizer.decode(new_tokens, skip_special_tokens=True, clean_up_tokenization_spaces=False).strip()

    # Safety cleanup in case the model still leaks hidden thinking.
    answer = re.sub(r"<think>[\\s\\S]*?</think>", "", answer, flags=re.IGNORECASE).strip()
    answer = re.sub(r"<think>[\\s\\S]*$", "", answer, flags=re.IGNORECASE).strip()
    answer = answer.replace("</think>", "").strip()

    return {"text": answer or "(empty response)"}"""

if old_answer in srv:
    srv = srv.replace(old_answer, new_answer)
else:
    raise SystemExit("Could not patch answer cleanup block in local_ai_server.py")

srv_path.write_text(srv, encoding="utf-8")


# ----------------------------
# Patch index.js
# ----------------------------
js_path = Path("index.js")
js = js_path.read_text(encoding="utf-8")

helper_marker = "// SEEKDEEP_NATURAL_IMAGE_ROUTING_HELPERS"
if helper_marker not in js:
    helper_block = r'''
// SEEKDEEP_NATURAL_IMAGE_ROUTING_HELPERS
function isNaturalImageRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^generate (an |a )?(image|picture|photo|artwork|art)\b/.test(p) ||
    /^make (me )?(an |a )?(image|picture|photo|artwork|art)\b/.test(p) ||
    /^create (an |a )?(image|picture|photo|artwork|art)\b/.test(p) ||
    /^draw\b/.test(p) ||
    /^render\b/.test(p)
  );
}

function stripNaturalImageRequestPrefix(prompt) {
  let p = normalizeUserText(prompt);

  p = p.replace(/^generate (an |a )?(image|picture|photo|artwork|art)\s+(of\s+)?/i, '');
  p = p.replace(/^make (me )?(an |a )?(image|picture|photo|artwork|art)\s+(of\s+)?/i, '');
  p = p.replace(/^create (an |a )?(image|picture|photo|artwork|art)\s+(of\s+)?/i, '');
  p = p.replace(/^draw\s+(me\s+)?/i, '');
  p = p.replace(/^render\s+(me\s+)?/i, '');

  return p.trim() || normalizeUserText(prompt);
}
'''
    anchor = "client.on('messageCreate', async (message) => {"
    if anchor not in js:
        raise SystemExit("Could not find messageCreate anchor in index.js")
    js = js.replace(anchor, helper_block + "\n\n" + anchor, 1)

route_marker = "// SEEKDEEP_NATURAL_IMAGE_MESSAGE_ROUTE"
if route_marker not in js:
    anchor = """    const key = memoryKeyFrom(message);
    const firstAttachment = message.attachments.first();
"""
    insert = r"""    const key = memoryKeyFrom(message);

    // SEEKDEEP_NATURAL_IMAGE_MESSAGE_ROUTE
    if (prompt && isNaturalImageRequest(prompt)) {
      const imagePrompt = stripNaturalImageRequestPrefix(prompt);
      const file = await makeImage(imagePrompt, 1024, 1024, null);

      remember(key, 'user', prompt);
      remember(key, 'assistant', `Generated image locally for: ${imagePrompt}`);

      stopSeekDeepTypingLoopForMessage(message);
      await message.reply({
        content: `Generated locally: ${imagePrompt}`,
        files: [file],
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const firstAttachment = message.attachments.first();
"""
    if anchor not in js:
        raise SystemExit("Could not find routing insertion point in index.js")
    js = js.replace(anchor, insert, 1)

js_path.write_text(js, encoding="utf-8")
print("Patched local_ai_server.py and index.js successfully.")
