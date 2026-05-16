from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_research_followup_repair.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def insert_before(src: str, anchor: str, insert: str, label: str) -> str:
    if insert.strip() in src:
        return src
    pos = src.find(anchor)
    if pos < 0:
        raise SystemExit(f"Could not locate insertion anchor: {label}")
    return src[:pos] + insert + src[pos:]

require_contains(text, "async function seekdeepHandleResearchTableMessage", "research/table handler")
require_contains(text, "seekdeepSetPendingResearchTask(key", "pending research state")
require_contains(text, "seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "post archive", "post archive context")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

# Fix mojibake-prone curly apostrophe text if present.
text = text.replace(
    "Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, Iâ€™ll use web search instead of guessing.",
    "Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing."
)
text = text.replace(
    "Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, IÃ¢â‚¬â„¢ll use web search instead of guessing.",
    "Yes. Send the exact thing you want searched or compared. For product specs, generations, prices, or current info, I'll use web search instead of guessing."
)

helper = r"""
function seekdeepIsResearchFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p) return false;

  return (
    /\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p) ||
    /\b(of each|each one|each model|each laptop|for each|both of them|those|these|that comparison|the comparison)\b/.test(p) ||
    /\b(can you|could you|would you|please)?\s*(give|make|create|show|list|break down)\s+(me\s+)?(a\s+)?(pros?\s*\/\s*cons?|pros and cons|summary|recommendation|winner|ranking|table|chart)\b/.test(p)
  );
}

function seekdeepResearchFollowupMode(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (/\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p)) return 'proscons';
  if (/\b(table|chart|matrix|spreadsheet|tablesheet)\b/.test(p)) return 'table';
  if (/\b(winner|which one|which should|recommend|recommendation|ranking|rank)\b/.test(p)) return 'recommendation';
  return 'followup';
}

function seekdeepResearchFollowupPrompt(prompt = '', pending = null) {
  const clean = normalizeUserText(prompt);
  const topic = normalizeUserText(pending?.topic || '');
  const mode = seekdeepResearchFollowupMode(clean);

  if (mode === 'proscons') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      'Provide a pros/cons list for each item/model in the previous comparison.',
      'Use concise bullets. If exact specs vary by configuration, say so.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'recommendation') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      'Give a practical recommendation with clear criteria and caveats.',
      'Do not invent details that are not supported by the search/context.',
    ].filter(Boolean).join('\n');
  }

  return [
    'Continue the previous research/comparison task.',
    topic ? `Previous topic/items: ${topic}` : '',
    `User follow-up: ${clean}`,
    '',
    'Resolve the follow-up using the previous topic and available web/search context.',
    'Do not answer as a generic list detached from the prior comparison.',
  ].filter(Boolean).join('\n');
}
"""

if "function seekdeepIsResearchFollowupPrompt" not in text:
    anchor = "async function seekdeepHandleResearchTableMessage"
    text = insert_before(text, anchor, helper + "\n", "research handler")

# Insert follow-up handling after pending is defined and before table/vague logic can fall through.
anchor = """  if (seekdeepIsFrustrationPrompt(p)) {
"""
followup_block = r"""  if (pending?.topic && seekdeepIsResearchFollowupPrompt(p)) {
    seekdeepLogRoute('research-followup', prompt);
    const answer = await askChat(seekdeepResearchFollowupPrompt(p, pending), {
      web: 'always',
      memoryKey: key,
      system: seekdeepResearchSystem(seekdeepResearchFollowupMode(p) === 'table' ? 'table' : 'research'),
      maxNewTokens: Number(process.env.SEEKDEEP_RESEARCH_FOLLOWUP_MAX_TOKENS || 1800),
      temperature: 0.2,
    });

    remember(key, 'user', prompt);
    remember(key, 'assistant', answer);
    seekdeepSetResponseModel(message, seekdeepChatModelLabel());
    await sendLongMessageReply(message, answer);
    seekdeepSetPendingResearchTask(key, { ...pending, kind: pending.kind || 'comparison', lastAnswer: answer });
    return true;
  }

"""
if "seekdeepLogRoute('research-followup', prompt);" not in text:
    text = insert_before(text, anchor, followup_block, "frustration prompt branch")

# Make comparison search query more specific by making the prompt ask for official/support specs and the concrete models.
old = """    return [
      'Research and answer this request using available web/search context.',
      `Request: ${cleanTopic}`,
      '',
      'If this is a product comparison, identify the concrete models/generations involved and avoid hallucinating unavailable variants.',
    ].join('\\n');
"""
new = """    return [
      'Research and answer this request using available web/search context.',
      `Request: ${cleanTopic}`,
      '',
      'If this is a laptop/product comparison, search for official manufacturer specs, PSREF/spec sheets, reputable reviews, and concrete generation/model names.',
      'Identify the concrete models/generations involved and avoid hallucinating unavailable variants.',
      'If search results are weak or unrelated, say so instead of pretending they support the answer.',
    ].join('\\n');
"""
if old in text:
    text = text.replace(old, new, 1)

for needle, label in [
    ("function seekdeepIsResearchFollowupPrompt", "research follow-up detector"),
    ("function seekdeepResearchFollowupPrompt", "research follow-up prompt builder"),
    ("seekdeepLogRoute('research-followup', prompt);", "research follow-up route"),
    ("web: 'always'", "forced web research"),
    ("I'll use web search instead of guessing.", "ASCII apostrophe prompt"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched research follow-up handling.")