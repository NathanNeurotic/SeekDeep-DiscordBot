// Pure leaf extracted from index.js (no Discord/Client/shared state): hardened
// compile/validate of user-supplied auto-react patterns. The two consts are
// re-exported because seekdeepRuleMatches (which stays in index.js) uses them.
export const SEEKDEEP_REACT_PATTERN_MAX = 200;
// BOT-1: cap how much message text a user-supplied react pattern is tested
// against. Bounds the worst case for any pattern the detector still allows
// (e.g. polynomial `.*a.*a` shapes have no repeated group, so they pass the
// detector but stay cheap on a bounded input). Discord messages are <=4000.
export const SEEKDEEP_REACT_MATCH_MAX_CHARS = Number(process.env.SEEKDEEP_REACT_MATCH_MAX_CHARS || 2000);
export function seekdeepReactPatternRedosRisk(src) {
  // BOT-1: a quantifier that REPEATS a group — `(…)*`, `(…)+`, `(…){n[,m]}` — is
  // the necessary ingredient for catastrophic (exponential) backtracking. The
  // old detector only caught groups that ALSO had a quantifier inside, so
  // alternation-overlap like `(a|a)*` (no inner quantifier) slipped through and
  // could freeze the event loop for tens of seconds. Reject ALL repeated groups;
  // a bounded optional group `(…)?` is safe and still allowed.
  return /\)\s*[*+]/.test(src)                       // (…)*  (…)+
      || /\)\s*\{/.test(src)                         // (…){n}  (…){n,}  (…){n,m}
      || /\([^()]*[+*}][^()]*\)\s*[+*]/.test(src)    // (…+…)+  (…*…)*  (kept)
      || /\([^()]*[+*}][^()]*\)\s*\{/.test(src)      // (…+…){n,}
      || /[+*]\)\s*[+*]/.test(src);                  // …+)+   …*)*
}
// Returns a human-readable reason if the pattern is unusable/dangerous, else null
// (null also = an intentionally-empty "match everything in scope" pattern).
export function seekdeepReactPatternRejectReason(pattern = '') {
  const raw = String(pattern || '').trim();
  if (!raw) return null;
  const rx = raw.match(/^\/(.+)\/([a-z]*)$/i);
  const src = rx ? rx[1] : raw;
  if (src.length > SEEKDEEP_REACT_PATTERN_MAX) return `pattern too long (max ${SEEKDEEP_REACT_PATTERN_MAX} chars)`;
  if (rx) {
    if (seekdeepReactPatternRedosRisk(src)) return 'pattern repeats a group (e.g. (…)+ / (…){n}) which can hang the bot — rejected';
    try { new RegExp(src, rx[2].replace(/[^gimsuy]/g, '') || 'i'); }
    catch (e) { return 'invalid regex: ' + (e?.message || e); }
  }
  return null;
}
export function seekdeepCompileReactionPattern(pattern = '') {
  const raw = String(pattern || '').trim();
  if (!raw) return null;
  // /regex/flags syntax for power users — hardened against ReDoS.
  const rxMatch = raw.match(/^\/(.+)\/([a-z]*)$/i);
  if (rxMatch) {
    const src = rxMatch[1];
    if (src.length > SEEKDEEP_REACT_PATTERN_MAX) return null;   // fail closed
    if (seekdeepReactPatternRedosRisk(src)) return null;        // fail closed
    try { return new RegExp(src, rxMatch[2].replace(/[^gimsuy]/g, '') || 'i'); }
    catch { return null; }
  }
  // Otherwise plain substring, case-insensitive, with word boundaries when sensible.
  if (raw.length > SEEKDEEP_REACT_PATTERN_MAX) return null;
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
}
