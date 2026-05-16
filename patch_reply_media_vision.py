from pathlib import Path
import re

p = Path("index.js")
text = p.read_text(encoding="utf-8")

old_func = re.search(
    r"function isNaturalVisionRequest\(prompt\) \{[\s\S]*?\n\}",
    text
)

if not old_func:
    raise SystemExit("Could not find isNaturalVisionRequest(prompt).")

new_func = r'''function isNaturalVisionRequest(prompt) {
  const p = normalizeUserText(prompt).toLowerCase().trim();

  return (
    /^vision\b/.test(p) ||
    /^describe\s+(this|the|that)\b/.test(p) ||
    /^analy[sz]e\s+(this|the|that)\b/.test(p) ||
    /^inspect\s+(this|the|that)\b/.test(p) ||
    /^look\s+at\s+(this|the|that)\b/.test(p) ||
    /^explain\s+(this|the|that)\b/.test(p) ||
    /^identify\s+(this|the|that)\b/.test(p) ||
    /^read\s+(this|the|that)\b/.test(p) ||
    /^ocr\b/.test(p) ||

    // Natural Discord profanity/casual forms.
    /^what\s+the\s+fuck\s+is\s+(this|that)\b/.test(p) ||
    /^what\s+the\s+hell\s+is\s+(this|that)\b/.test(p) ||
    /^what\s+tf\s+is\s+(this|that)\b/.test(p) ||
    /^wtf\s+is\s+(this|that)\b/.test(p) ||
    /^tf\s+is\s+(this|that)\b/.test(p) ||

    /^what\s+is\s+(this|that)\b/.test(p) ||
    /^what'?s\s+(this|that)\b/.test(p) ||
    /^what\s+am\s+i\s+looking\s+at\b/.test(p) ||
    /^what\s+is\s+in\s+(this|the|that)\b/.test(p) ||
    /^what'?s\s+in\s+(this|the|that)\b/.test(p) ||

    /\bwhat\s+is\s+this\s+(image|picture|photo|video|screenshot|gif)\b/.test(p) ||
    /\bdescribe\s+this\s+(image|picture|photo|video|screenshot|gif)\b/.test(p)
  );
}'''

text = text[:old_func.start()] + new_func + text[old_func.end():]

old_route = """    if (visionAttachment && (isNaturalVisionRequest(prompt) || message.attachments.size > 0)) {
      const visionPrompt = prompt || 'Describe this media clearly.';
      const answer = await askVision(visionAttachment, buildPromptWithMemory(visionPrompt, key));"""

new_route = """    if (visionAttachment && (isNaturalVisionRequest(prompt) || message.attachments.size > 0 || message?.reference?.messageId)) {
      const visionPrompt = prompt || 'Describe this media clearly.';
      const answer = await askVision(visionAttachment, buildPromptWithMemory(visionPrompt, key));"""

if old_route not in text:
    raise SystemExit("Could not find natural vision route condition.")

text = text.replace(old_route, new_route, 1)

if "what\\s+the\\s+fuck\\s+is" not in text:
    raise SystemExit("Vision profanity matcher was not inserted.")

if "message?.reference?.messageId" not in text:
    raise SystemExit("Reply-to-media fallback was not inserted.")

p.write_text(text, encoding="utf-8")
print("Reply-to-media vision routing patched.")
