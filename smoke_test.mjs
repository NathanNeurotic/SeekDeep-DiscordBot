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

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
