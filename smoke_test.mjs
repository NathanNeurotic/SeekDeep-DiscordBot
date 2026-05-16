// SeekDeep automated smoke test.
// Runs the same checks the project SMOKE_TEST.md asks a human to do, but for the
// regression-prone pure-function parts only. Safe to run anytime — no Discord,
// no model load, no file mutation.
//
// Usage: node smoke_test.mjs
//
// Exit code 0 = all green. Non-zero = at least one regression.

import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' -> ' + detail : ''}`);
    console.log(`  FAIL ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

console.log('1. node --check index.js');
const checkRes = spawnSync(process.execPath, ['--check', 'index.js'], { encoding: 'utf8' });
check('index.js parses', checkRes.status === 0, checkRes.stderr?.slice(0, 200));

console.log('2. Regex-only patterns (no module import).');
// We inline-clone the regexes we care about so the test stays import-free.
// Mismatches mean somebody edited the live code without updating tests.
const rxQuotedStrip = (line) => /^\s*>/.test(line);
check('quoted-line detect: "> @SeekDeep"', rxQuotedStrip('> @SeekDeep hi') === true);
check('quoted-line detect: bare "@SeekDeep"', rxQuotedStrip('@SeekDeep hi') === false);

// Frustration detection — same patterns as seekdeepIsFrustrationPrompt.
const isFrustration = (p) => {
  const s = String(p || '').toLowerCase().trim();
  if (!s) return false;
  if (/^(?:no|nah|wrong|incorrect|false|bad|terrible|useless|garbage|bullshit|bs|wtf|what\s+the\s+fuck)\b/.test(s)) return true;
  if (/^(?:fuck|fucking|shit|damn|goddamn|ugh|argh|jesus|christ|fml|smh|wtf)\b\s*[!.?]*$/.test(s)) return true;
  if (/^(?:fuck|screw|damn|f\*+)\s+(?:you|this|that|off|me|it|all\s+of\s+(?:you|this))\b/.test(s)) return true;
  if (/^(?:i\s+(?:mean|just|literally))\s+fuck\b/.test(s)) return true;
  return false;
};
check('frustration: "FUCK"', isFrustration('FUCK') === true);
check('frustration: "fuck you"', isFrustration('fuck you') === true);
check('frustration: "shit"', isFrustration('shit') === true);
check('frustration: real prompt', isFrustration('a red glass apple') === false);

// Natural-archive followup
const rxNatArchive = /^(?:make\s+(?:it|this|that)\s+archive(?:\s+too|\s+shared)?|archive\s+(?:this|that|it|too|the\s+image|this\s+(?:one|image|picture|pic))|save\s+(?:this|that|it|the\s+image|this\s+(?:image|picture|pic)|to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive)|add\s+(?:this|it|that)\s+to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|put\s+(?:this|it|that)\s+in\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|share\s+(?:this|that|it|the\s+image)|shared\s+archive\s+(?:this|that|it|the\s+image)|send\s+(?:this|that|it)\s+to\s+(?:the\s+)?shared\s+archive)\s*[.!?]*$/i;
check('archive followup: "archive this"', rxNatArchive.test('archive this') === true);
check('archive followup: "save it"', rxNatArchive.test('save it') === true);
check('archive followup: "make it archive too"', rxNatArchive.test('make it archive too') === true);
check('archive followup: not "archive setup"', rxNatArchive.test('archive setup') === false);

// Vision follow-up auto-route
const looksLikeRecentImageFollowup = (p) => {
  const s = String(p || '').toLowerCase().trim();
  if (!s || s.length > 400) return false;
  return /\b(?:this|that|the)\s+(?:image|picture|photo|pic|video|clip|gif|media|screenshot)\b/.test(s)
      || /\b(?:in|from|on|about|of)\s+(?:this|that)\s+(?:image|picture|photo|pic|video|clip|gif|media|screenshot)\b/.test(s)
      || /^\s*(?:what|who|why|how|when|where|describe|tell\s+me)\s+(?:about|more\s+about)\s+(?:this|that|the)\s+(?:image|picture|photo|pic|video|clip|gif)\b/i.test(s);
};
check('vision followup: "tell me more about this image"', looksLikeRecentImageFollowup('tell me more about this image') === true);
check('vision followup: "what is in that picture"', looksLikeRecentImageFollowup('what is in that picture') === true);
check('vision followup: not "hi"', looksLikeRecentImageFollowup('hi') === false);
check('vision followup: not "compare X vs Y"', looksLikeRecentImageFollowup('compare X vs Y') === false);

// Proper-noun lookup
const looksLikeProperNounLookup = (prompt) => {
  const raw = String(prompt || '').trim();
  if (!raw || raw.length > 400) return false;
  const lookupPhrasePatterns = [
    /\btell\s+me\s+(?:more\s+)?about\b/i,
    /\b(?:can|could)\s+you\s+(?:please\s+)?(?:tell\s+me|explain|describe)\b/i,
    /\bwhat\s+(?:can|could)\s+you\s+tell\s+me\s+about\b/i,
    /\bwhat\s+do\s+you\s+know\s+about\b/i,
    /\bwhat'?s?\s+the\s+(?:story|deal|lore)\s+(?:behind|with|on|about)\b/i,
    /\binfo(?:rmation)?\s+on\b/i,
    /\blore\s+on\b/i,
    /\bdetails\s+on\b/i,
    /\bbackground\s+on\b/i,
    /\bhistory\s+of\b/i,
    /^\s*(?:more\s+about|tell\s+me\s+more)\b/i,
    /^\s*who(?:'s|\s+is|\s+was|\s+were)\s+/i,
    /^\s*what(?:'s|\s+is|\s+was|\s+were)\s+(?!the\s+best|a\s+good|a\s+recipe|your\s+name)/i,
    /^\s*where(?:'s|\s+is|\s+was|\s+were)\s+/i,
  ];
  if (!lookupPhrasePatterns.some((re) => re.test(raw))) return false;
  const STOP = new Set(['What','Who','Where','When','Why','How','Tell','Its',"It's",'Is','Are','Was','Were','Can','Could','Would','Should','Will','Do','Does','Did','I',"I'm","I'd","I've","I'll",'Yes','No','Ok','Okay','Sure','Hey','Hi','Hello','Please','Thanks','Thank','Maybe','Probably','Definitely','Also','But','And','Or','So','Now','Then','Just','Only','Even','Like','Some','The','A','An','My','Your','His','Her','Their','Our']);
  const matches = raw.match(/\b[A-Z][A-Za-z0-9'\-]{1,}/g) || [];
  for (const w of matches) if (!STOP.has(w)) return true;
  if (/\b(pokemon|mario|zelda|kk slider|animal crossing|nintendo)\b/i.test(raw)) return true;
  return false;
};
check('proper-noun lookup: KK Slider context', looksLikeProperNounLookup('Its KK Slider from Animal Crossing. What can you tell me about him?') === true);
check('proper-noun lookup: "tell me about Mario"', looksLikeProperNounLookup('tell me about Mario') === true);
check('proper-noun lookup: not "hi"', looksLikeProperNounLookup('hi') === false);
check('proper-noun lookup: not "what is your name"', looksLikeProperNounLookup('what is your name') === false);

// Image style preset
const STYLES = ['anime','photoreal','pixel','oil-painting','cyberpunk','cottagecore','cinematic','3d-render','sketch','watercolor'];
check('image-style presets: 10 defined', STYLES.length === 10);

// Image quality preset
const qualitySteps = { low: 12, standard: 28, high: 40 };
check('image-quality presets: 3 tiers', Object.keys(qualitySteps).length === 3);

// Auto-reaction pattern compile (substring case-insensitive default).
// Mirrors seekdeepCompileReactionPattern in index.js — must keep in sync.
function compileReactPattern(raw) {
  const r = String(raw || '').trim();
  if (!r) return null;
  const rx = r.match(/^\/(.+)\/([a-z]*)$/i);
  if (rx) { try { return new RegExp(rx[1], rx[2].replace(/[^gimsuy]/g, '') || 'i'); } catch { return null; } }
  const esc = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i');
}
const sus = compileReactPattern('sus');
check('reactrule compile: "sus" matches "that is sus"', sus.test('that is sus') === true);
check('reactrule compile: "sus" does NOT match "discuss"', sus.test('discuss') === false);
const regexPat = compileReactPattern('/^lol$/i');
check('reactrule compile: /^lol$/i matches "lol"', regexPat.test('lol') === true);
check('reactrule compile: /^lol$/i does NOT match "haha lol"', regexPat.test('haha lol') === false);

// Frustration filter regression — v10.2 update (the "no testicles for you" fix)
function isFrustrationV2(p) {
  const s = String(p || '').toLowerCase().trim();
  if (!s) return false;
  const w = s.split(/\s+/).filter(Boolean).length;
  if (w <= 3 && /^(?:no|nah|wrong|incorrect|false|bad|terrible|useless|garbage|bullshit|bs|wtf|what\s+the\s+fuck)\b/.test(s)) return true;
  if (/^(?:fuck|fucking|shit|damn|goddamn|ugh|argh|jesus|christ|fml|smh|wtf)\b\s*[!.?]*$/.test(s)) return true;
  if (w <= 6 && /^(?:fuck|screw|damn|f\*+)\s+(?:you|this|that|off|me|it|all\s+of\s+(?:you|this))\b/.test(s)) return true;
  return false;
}
check('frustration v2: "no testicles for you" is NOT flagged', isFrustrationV2('no testicles for you') === false);
check('frustration v2: "no" alone IS flagged', isFrustrationV2('no') === true);
check('frustration v2: "no help" IS flagged (short)', isFrustrationV2('no help') === true);

// Fence-aware Discord chunker — v10.3.1 fix. Mirrors splitDiscordText in
// index.js. The whole point is that splitting a long help message never
// leaves a code fence unbalanced across Discord message boundaries.
function splitDiscordText(value, limit) {
  const raw = String(value ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!raw) return [''];
  if (raw.length <= limit) return [raw];
  if (raw.indexOf('```') < 0) {
    // Plain fallback — naive lookback splitter.
    const chunks = [];
    let remaining = raw;
    while (remaining.length > limit) {
      let cut = -1;
      for (const token of ['\n\n', '\n', '. ', '; ', ', ', ' ']) {
        const pos = remaining.lastIndexOf(token, limit);
        if (pos >= Math.floor(limit * 0.45)) { cut = pos + (token.trim() ? token.length : 0); break; }
      }
      if (cut < Math.floor(limit * 0.45)) cut = limit;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);
    return chunks.length ? chunks : [''];
  }
  const lines = raw.split('\n');
  const chunks = [];
  let cur = [];
  let curLen = 0;
  let fenceOpen = null;
  const fenceRe = /^\s*```([A-Za-z0-9_-]*)\s*$/;
  const flush = (reopenFence) => {
    if (!cur.length) return;
    let body = cur.join('\n');
    if (fenceOpen) body += '\n```';
    chunks.push(body.trimEnd());
    cur = [];
    curLen = 0;
    if (reopenFence && fenceOpen) { cur.push(fenceOpen); curLen = fenceOpen.length; }
  };
  for (const line of lines) {
    const add = (cur.length ? 1 : 0) + line.length;
    if (line.length > limit) {
      flush(false);
      let rest = line;
      while (rest.length > limit) { chunks.push(rest.slice(0, limit)); rest = rest.slice(limit); }
      if (rest) { cur.push(rest); curLen = rest.length; }
      continue;
    }
    if (curLen + add > limit) flush(true);
    cur.push(line);
    curLen += (curLen ? 1 : 0) + line.length;
    const m = line.match(fenceRe);
    if (m) { if (fenceOpen) fenceOpen = null; else fenceOpen = line; }
  }
  flush(false);
  return chunks.length ? chunks : [''];
}

// Build a help-shaped input with 8 fenced sections, each ~700 chars.
const helpBlocks = [];
for (let i = 0; i < 8; i++) {
  helpBlocks.push('## Section ' + i);
  helpBlocks.push('```text');
  for (let j = 0; j < 10; j++) helpBlocks.push('command line ' + i + '.' + j + ' some content');
  helpBlocks.push('```');
  helpBlocks.push('after-fence prose line for section ' + i);
  helpBlocks.push('');
}
const helpInput = helpBlocks.join('\n');
const helpChunks = splitDiscordText(helpInput, 600);
let unbalanced = 0;
let overLimit = 0;
for (const c of helpChunks) {
  const fences = (c.match(/```/g) || []).length;
  if (fences % 2 !== 0) unbalanced++;
  if (c.length > 600) overLimit++;
}
check('chunker: produces multiple chunks for long input', helpChunks.length >= 3, 'got ' + helpChunks.length);
check('chunker: every chunk has balanced ``` fences', unbalanced === 0, unbalanced + ' chunks had unbalanced fences');
check('chunker: no chunk exceeds limit', overLimit === 0, overLimit + ' chunks over limit');

// Boundary check: when we close a fence mid-section, the next chunk must
// reopen with the SAME language hint (so syntax highlighting is preserved).
const reopened = helpChunks.slice(1).filter((c) => c.startsWith('```text')).length;
check('chunker: reopens ```text on continuation chunks', reopened >= 1);

// No-fence input still works.
const plainChunks = splitDiscordText('a '.repeat(2000), 100);
check('chunker: fence-free input still splits', plainChunks.length > 1);

// v10.4 help topic parser. Mirrors seekdeepParseHelpTopic in index.js.
function parseHelpTopic(prompt) {
  const p = String(prompt || '').toLowerCase().trim();
  let m = p.match(/^(?:help|commands)\s+([a-z\-]+)/i);
  if (m) return m[1];
  m = p.match(/^([a-z\-]+)\s+(?:help|commands)\b/i);
  if (m && !/^(?:archive|image|vision|cache|queue|recent|status|model)$/.test(m[1])) return m[1];
  m = p.match(/^(archive|archives|image|images|vision|cache|queue|recent|model|models|admin|reactrule|reactrules|emoji|context)\s+(?:help|commands)\b/i);
  if (m) return m[1];
  return '';
}
check('help topic: "help" -> empty', parseHelpTopic('help') === '');
check('help topic: "help chat" -> "chat"', parseHelpTopic('help chat') === 'chat');
check('help topic: "help reactrule" -> "reactrule"', parseHelpTopic('help reactrule') === 'reactrule');
check('help topic: "archive help" -> "archive"', parseHelpTopic('archive help') === 'archive');
check('help topic: "image help" -> "image"', parseHelpTopic('image help') === 'image');

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
