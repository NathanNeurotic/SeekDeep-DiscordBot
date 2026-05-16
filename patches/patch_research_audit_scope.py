from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_research_audit_scope.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack: str, needle: str, label: str):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_function_by_name(src: str, name: str, replacement: str) -> str:
    marker = f"function {name}("
    start = src.find(marker)
    if start < 0:
        raise SystemExit(f"Could not locate function {name}.")

    next_positions = []
    for marker2 in ["\nfunction ", "\nasync function ", "\n// SEEKDEEP_"]:
        pos = src.find(marker2, start + len(marker))
        if pos >= 0:
            next_positions.append(pos)

    if not next_positions:
        raise SystemExit(f"Could not locate end of function {name}.")

    end = min(next_positions)
    return src[:start] + replacement.rstrip() + "\n\n" + src[end + 1:]

for needle, label in [
    ("function seekdeepIsResearchFollowupPrompt", "research follow-up detector"),
    ("function seekdeepResearchFollowupMode", "research follow-up mode"),
    ("function seekdeepResearchFollowupPrompt", "research follow-up prompt"),
    ("function seekdeepResearchPrompt", "research prompt"),
    ("function seekdeepResearchSystem", "research system"),
    ("async function seekdeepHandleResearchTableMessage", "research handler"),
    ("seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

new_followup_detector = r"""function seekdeepIsResearchFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (!p) return false;

  return (
    /\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p) ||
    /\b(of each|each one|each model|each laptop|for each|both of them|those|these|that comparison|the comparison)\b/.test(p) ||
    /\b(can you|could you|would you|please)?\s*(give|make|create|show|list|break down)\s+(me\s+)?(a\s+)?(pros?\s*\/\s*cons?|pros and cons|summary|recommendation|winner|ranking|table|chart)\b/.test(p) ||
    /^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)
  );
}"""

new_followup_mode = r"""function seekdeepResearchFollowupMode(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase();
  if (/^(audit|fact\s*check|fact-check|check that|check the answer|verify that|verify the answer|review that|review the answer|was that right|is that right|source audit|sources audit)\b/.test(p)) return 'audit';
  if (/\b(pros?\s*\/\s*cons?|pros and cons|advantages?|disadvantages?|downsides?|upsides?|strengths?|weaknesses?)\b/.test(p)) return 'proscons';
  if (/\b(table|chart|matrix|spreadsheet|tablesheet)\b/.test(p)) return 'table';
  if (/\b(winner|which one|which should|recommend|recommendation|ranking|rank)\b/.test(p)) return 'recommendation';
  return 'followup';
}"""

new_followup_prompt = r"""function seekdeepResearchFollowupPrompt(prompt = '', pending = null) {
  const clean = normalizeUserText(prompt);
  const topic = normalizeUserText(pending?.topic || '');
  const lastAnswer = normalizeUserText(pending?.lastAnswer || '').slice(0, 3500);
  const mode = seekdeepResearchFollowupMode(clean);

  const scopeRules = [
    'Scope discipline:',
    '- Preserve the exact prior comparison topic/items.',
    '- Do not introduce unrelated models or generations.',
    '- If the prior topic says X1 Carbon and T14, do not switch to X230, T13, T14s, Framework, or unrelated models unless explicitly asked.',
    '- If the prior topic is broad, say that exact specs vary by generation/configuration.',
    '- If sources are weak/unrelated, say that plainly.',
  ].join('\n');

  if (mode === 'audit') {
    return [
      'Audit the previous research/comparison answer.',
      topic ? `Previous topic/items: ${topic}` : '',
      lastAnswer ? `Previous answer to audit:\n${lastAnswer}` : '',
      '',
      scopeRules,
      '',
      'Output:',
      '1. List any likely wrong, unsupported, or overconfident claims.',
      '2. List source-quality problems.',
      '3. Give a corrected concise answer if possible.',
      '4. If more exact model generations are needed, ask for them.',
    ].filter(Boolean).join('\n');
  }

  if (mode === 'proscons') {
    return [
      'Continue the previous research/comparison task.',
      topic ? `Previous topic/items: ${topic}` : '',
      `User follow-up: ${clean}`,
      '',
      scopeRules,
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
      scopeRules,
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
    scopeRules,
    '',
    'Resolve the follow-up using the previous topic and available web/search context.',
    'Do not answer as a generic list detached from the prior comparison.',
  ].filter(Boolean).join('\n');
}"""

text = replace_function_by_name(text, "seekdeepIsResearchFollowupPrompt", new_followup_detector)
text = replace_function_by_name(text, "seekdeepResearchFollowupMode", new_followup_mode)
text = replace_function_by_name(text, "seekdeepResearchFollowupPrompt", new_followup_prompt)

# Strengthen research system by adding scope/source discipline if not already present.
if "Never introduce unrelated model names" not in text:
    text = text.replace(
        "'Use web/search context when provided. Do not bluff current product specs, prices, release details, or generation availability.',",
        "'Use web/search context when provided. Do not bluff current product specs, prices, release details, or generation availability.',\n"
        "    'Never introduce unrelated model names or generations. Preserve the user\\'s requested comparison scope.',\n"
        "    'If sources are low quality, irrelevant, or not about the exact requested model/generation, say that plainly.',",
        1
    )

# Strengthen research prompt if the previous patch did not already.
if "Do not change the requested comparison scope" not in text:
    text = text.replace(
        "'If this is a laptop/product comparison, search for official manufacturer specs, PSREF/spec sheets, reputable reviews, and concrete generation/model names.',",
        "'If this is a laptop/product comparison, search for official manufacturer specs, PSREF/spec sheets, reputable reviews, and concrete generation/model names.',\n"
        "      'Do not change the requested comparison scope. Do not introduce unrelated models or generations.',",
        1
    )

for needle, label in [
    ("return 'audit';", "audit mode"),
    ("Previous answer to audit", "audit prompt includes previous answer"),
    ("Scope discipline:", "scope discipline prompt"),
    ("Do not introduce unrelated models or generations.", "unrelated model guard"),
    ("Never introduce unrelated model names or generations.", "system-level scope guard"),
    ("seekdeepEnqueueImageJob(job, runner)", "image queue contract preserved"),
]:
    require_contains(text, needle, label)

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched research audit and scope discipline.")