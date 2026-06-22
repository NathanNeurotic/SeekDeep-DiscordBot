// Pure decision helper extracted from index.js (leaf module — no Discord/Client
// or shared mutable state) so the V2 follow-up handler stays unit-testable.
// Given a pending image-subject state and the user's reply prompt, decide
// whether to queue the Original, the Refined, or both versions.
export function seekdeepPendingImageQueuePlan(pending = {}, prompt = '') {
  const safePending = pending && typeof pending === 'object' ? pending : {};
  const pendingWantsOriginal = safePending.wantsOriginal !== false;
  const pendingWantsRefined = safePending.wantsRefined !== false;
  const pendingWantsBoth = pendingWantsOriginal && pendingWantsRefined;

  const p = String(prompt || '').toLowerCase().trim();
  const explicitBothPhrase = /\b(?:do\s+both|make\s+both|queue\s+both|both\s+versions?|both\s+(?:original\s+and\s+refined|refined\s+and\s+original)|original\s+and\s+refined|refined\s+and\s+original|both\s+please|both\s+of\s+them|all\s+(?:of\s+)?them)\b/i.test(p)
    || /^both\b/i.test(p);
  const explicitOriginalOnly = /\b(?:just|only)\s+(?:the\s+)?original\b/i.test(p) || /\boriginal\s+only\b/i.test(p);
  const explicitRefinedOnly = /\b(?:just|only)\s+(?:the\s+)?refined\b/i.test(p) || /\brefined\s+only\b/i.test(p);

  let wantsOriginal;
  let wantsRefined;

  if (explicitBothPhrase) {
    wantsOriginal = true;
    wantsRefined = true;
  } else if (explicitOriginalOnly) {
    wantsOriginal = true;
    wantsRefined = false;
  } else if (explicitRefinedOnly) {
    wantsOriginal = false;
    wantsRefined = true;
  } else if (pendingWantsBoth) {
    // Pending state says "both", but the prompt did not ask for both explicitly.
    // Pick the safe default: refined only, which matches how a single ad-hoc
    // image request behaves elsewhere in the bot. Do not spam both.
    wantsOriginal = false;
    wantsRefined = true;
  } else {
    wantsOriginal = pendingWantsOriginal && !pendingWantsRefined;
    wantsRefined = pendingWantsRefined;
    if (!wantsOriginal && !wantsRefined) wantsRefined = true;
  }

  const wantsBoth = Boolean(wantsOriginal && wantsRefined);

  let ackText;
  if (wantsBoth) {
    ackText = 'Queued both:\n- Original\n- Refined';
  } else if (wantsRefined) {
    ackText = 'Queued: refined';
  } else {
    ackText = 'Queued: original (no refinement)';
  }

  return { wantsOriginal, wantsRefined, wantsBoth, ackText };
}
