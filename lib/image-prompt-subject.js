// Pure leaf helpers extracted from index.js (no Discord/Client/shared state):
// decide whether a refined SDXL prompt still depicts the original subject.
export function seekdeepImagePromptKeywordStem(word = '') {
  return String(word || '')
    .toLowerCase()
    .replace(/(?:ing|ers|er|ies|ied|ed|es|s)$/i, '')
    .trim();
}

export function seekdeepImagePromptKeywords(prompt = '') {
  const stop = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'the', 'their', 'this', 'to', 'with',
    'make', 'create', 'draw', 'generate', 'show', 'render', 'paint', 'sketch', 'illustrate', 'design', 'image', 'picture', 'photo', 'art', 'prompt'
  ]);

  const words = String(prompt || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  const out = [];

  for (const word of words) {
    if (word.length < 3 || stop.has(word)) continue;
    const stem = seekdeepImagePromptKeywordStem(word);
    if (stem.length < 3 || stop.has(stem)) continue;
    if (!out.includes(stem)) out.push(stem);
  }

  return out.slice(0, 14);
}

export function seekdeepDynamicImagePromptPreservesSubject(originalPrompt = '', candidatePrompt = '') {
  const originalKeywords = seekdeepImagePromptKeywords(originalPrompt);
  if (!originalKeywords.length) return true;

  const candidate = ' ' + seekdeepImagePromptKeywords(candidatePrompt).join(' ') + ' ';
  const lowerCandidate = String(candidatePrompt || '').toLowerCase();
  const matched = originalKeywords.filter((word) => candidate.includes(' ' + word + ' ') || lowerCandidate.includes(word));

  // v10.14: looser threshold. The previous 45%-of-keywords-required rule
  // rejected good refinements that intelligently translated franchise
  // references into visual style cues, because every dropped franchise
  // reference word counted equally against subject preservation. Example:
  //   "a vanilla colored ant from the movie antz similar to a bugs life"
  //   -> 8 keywords -> 45% = 4 required.
  // A great refinement that preserved (vanilla, colored, ant) but dropped
  // (movie, antz, similar, bugs, life) only matched 3/8 and was rejected.
  //
  // New rule: at least 2 head nouns must survive, capped at 3 max — even
  // long prompts. Anything obviously off-topic still fails (the bad-refine
  // case is "a red car" -> "a banana in a forest" which preserves 0).
  const required = originalKeywords.length <= 2
    ? originalKeywords.length
    : Math.max(2, Math.min(3, Math.ceil(originalKeywords.length * 0.25)));
  return matched.length >= required;
}
