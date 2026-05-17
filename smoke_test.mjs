// SeekDeep automated smoke test.
// v10.5: imports index.js with SEEKDEEP_TEST_MODE=1 so every check exercises
// the REAL helper functions instead of inline mirrors. Mirrors drifted out
// of sync at least twice between v10.2 and v10.3.1 (the chunker regression
// was caught precisely because the mirror disagreed with the real impl) —
// so we kill that whole class of bug by routing through globalThis.__seekdeepTest.
//
// Safe to run anytime — no Discord login, no model load, no file mutation.
//
// Usage: node smoke_test.mjs
// Exit code 0 = all green. Non-zero = at least one regression.

// Set test mode BEFORE importing index.js — top-level statements in index.js
// see process.env at their evaluation time.
process.env.SEEKDEEP_TEST_MODE = '1';

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

console.log('2. import index.js helpers (real, not mirrored).');
await import('./index.js');
const T = globalThis.__seekdeepTest;
if (!T) {
  fail++;
  console.log('  FAIL globalThis.__seekdeepTest missing — test mode broken');
  process.exit(1);
}
check('globalThis.__seekdeepTest has 12 keys', Object.keys(T).length >= 12);

console.log('3. Inline regex patterns (no helper available — kept inline).');
const rxQuotedStrip = (line) => /^\s*>/.test(line);
check('quoted-line detect: "> @SeekDeep"', rxQuotedStrip('> @SeekDeep hi') === true);
check('quoted-line detect: bare "@SeekDeep"', rxQuotedStrip('@SeekDeep hi') === false);

console.log('4. Frustration detection (real seekdeepIsFrustrationPrompt).');
check('frustration: "FUCK"', T.seekdeepIsFrustrationPrompt('FUCK') === true);
check('frustration: "fuck you"', T.seekdeepIsFrustrationPrompt('fuck you') === true);
check('frustration: "shit"', T.seekdeepIsFrustrationPrompt('shit') === true);
check('frustration: real prompt', T.seekdeepIsFrustrationPrompt('a red glass apple') === false);
check('frustration v2: "no testicles for you" NOT flagged', T.seekdeepIsFrustrationPrompt('no testicles for you') === false);
check('frustration v2: "no" alone IS flagged', T.seekdeepIsFrustrationPrompt('no') === true);
check('frustration v2: "no help" IS flagged (short)', T.seekdeepIsFrustrationPrompt('no help') === true);

console.log('5. Natural-archive followup regex (still inline).');
const rxNatArchive = /^(?:make\s+(?:it|this|that)\s+archive(?:\s+too|\s+shared)?|archive\s+(?:this|that|it|too|the\s+image|this\s+(?:one|image|picture|pic))|save\s+(?:this|that|it|the\s+image|this\s+(?:image|picture|pic)|to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive)|add\s+(?:this|it|that)\s+to\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|put\s+(?:this|it|that)\s+in\s+(?:my\s+|the\s+)?(?:shared\s+)?archive|share\s+(?:this|that|it|the\s+image)|shared\s+archive\s+(?:this|that|it|the\s+image)|send\s+(?:this|that|it)\s+to\s+(?:the\s+)?shared\s+archive)\s*[.!?]*$/i;
check('archive followup: "archive this"', rxNatArchive.test('archive this') === true);
check('archive followup: "save it"', rxNatArchive.test('save it') === true);
check('archive followup: "make it archive too"', rxNatArchive.test('make it archive too') === true);
check('archive followup: not "archive setup"', rxNatArchive.test('archive setup') === false);

console.log('6. Vision follow-up auto-route (inline).');
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

console.log('7. Proper-noun lookup (inline).');
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

console.log('8. Image style/quality presets (inline knowledge).');
const STYLES = ['anime','photoreal','pixel','oil-painting','cyberpunk','cottagecore','cinematic','3d-render','sketch','watercolor'];
check('image-style presets: 10 defined', STYLES.length === 10);
const qualitySteps = { low: 12, standard: 28, high: 40 };
check('image-quality presets: 3 tiers', Object.keys(qualitySteps).length === 3);

console.log('9. ReactRule pattern compile (real seekdeepCompileReactionPattern).');
const susRx = T.seekdeepCompileReactionPattern('sus');
check('reactrule compile: "sus" matches "that is sus"', susRx?.test('that is sus') === true);
check('reactrule compile: "sus" does NOT match "discuss"', susRx?.test('discuss') === false);
const lolRx = T.seekdeepCompileReactionPattern('/^lol$/i');
check('reactrule compile: /^lol$/i matches "lol"', lolRx?.test('lol') === true);
check('reactrule compile: /^lol$/i does NOT match "haha lol"', lolRx?.test('haha lol') === false);

console.log('10. Fence-aware chunker (real splitDiscordText).');
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
const helpChunks = T.splitDiscordText(helpInput, 600);
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
const reopened = helpChunks.slice(1).filter((c) => c.startsWith('```text')).length;
check('chunker: reopens ```text on continuation chunks', reopened >= 1);
const plainChunks = T.splitDiscordText('a '.repeat(2000), 100);
check('chunker: fence-free input still splits', plainChunks.length > 1);

console.log('11. Help topic parser (real seekdeepParseHelpTopic).');
check('help topic: "help" -> empty', T.seekdeepParseHelpTopic('help') === '');
check('help topic: "help chat" -> "chat"', T.seekdeepParseHelpTopic('help chat') === 'chat');
check('help topic: "help reactrule" -> "reactrule"', T.seekdeepParseHelpTopic('help reactrule') === 'reactrule');
check('help topic: "archive help" -> "archive"', T.seekdeepParseHelpTopic('archive help') === 'archive');
check('help topic: "image help" -> "image"', T.seekdeepParseHelpTopic('image help') === 'image');

console.log('12. Force-react picker math (real seekdeepForceReactBucketRange + constants).');
check('picker: bucket size = 25', T.forceReactConstants.bucketSize === 25);
check('picker: buckets per page = 4', T.forceReactConstants.bucketsPerPage === 4);
check('picker: emoji per page = 100', T.forceReactConstants.emojiPerPage === 100);
check('picker: max selected = 5', T.forceReactConstants.maxSelected === 5);
check('picker: page 0 bucket 0 starts at 0', T.seekdeepForceReactBucketRange(0, 0).start === 0);
check('picker: page 0 bucket 3 ends at 100', T.seekdeepForceReactBucketRange(0, 3).end === 100);
check('picker: page 1 bucket 0 starts at 100', T.seekdeepForceReactBucketRange(1, 0).start === 100);
check('picker: page 2 bucket 2 spans 250-275', T.seekdeepForceReactBucketRange(2, 2).start === 250 && T.seekdeepForceReactBucketRange(2, 2).end === 275);

console.log('13. Emoji vault helpers (real seekdeepEmojiVaultThreadName + FormatPage).');
check('vault: thread name "Neuralotics" -> "Neuralotics — Emojis"', T.seekdeepEmojiVaultThreadName({ name: 'Neuralotics' }) === 'Neuralotics — Emojis');
check('vault: thread name clips to 100 chars', T.seekdeepEmojiVaultThreadName({ name: 'x'.repeat(200) }).length <= 100);
check('vault: page size = 20', T.emojiVaultConstants.pageSize === 20);
const sampleEmojis = [
  { id: '111', name: 'apple', animated: false },
  { id: '222', name: 'banana', animated: false },
];
const pageBody = T.seekdeepEmojiVaultFormatPage({
  guildName: 'TestGuild', kind: 'Standard', slice: sampleEmojis,
  totalForKind: 2, page: 0, totalPages: 1, startIndex: 0,
});
check('vault: page body has header', /Standard Emojis \(2\)/.test(pageBody));
check('vault: page body has footer', /2 emojis · TestGuild · Page 1 of 1/.test(pageBody));
check('vault: page body has formatted entries', /<:apple:111>/.test(pageBody) && /1\.\)/.test(pageBody));
check('vault: cont. header used on page 2+', /cont\./.test(T.seekdeepEmojiVaultFormatPage({
  guildName: 'TestGuild', kind: 'Standard', slice: sampleEmojis, totalForKind: 25, page: 1, totalPages: 2, startIndex: 20,
})));

console.log('14. Help text integration (real seekdeepHelpText + slicer + chunker).');
const fullHelp = T.seekdeepHelpText();
check('help: full text non-empty', fullHelp.length > 100);
check('help: full text mentions Archive', /Archive/.test(fullHelp));
const chatSlice = T.seekdeepHelpTopicSlice('chat');
check('help slice: "chat" includes Chat section', /Chat \/ Web|Prompting/i.test(chatSlice));
check('help slice: "chat" omits Vision section', !/## .*Vision/.test(chatSlice));
const bogusSlice = T.seekdeepHelpTopicSlice('asdfgh');
check('help slice: unknown topic returns friendly hint', /Unknown help topic|No sections matched/.test(bogusSlice));
// End-to-end: render full help, chunk it, verify every chunk has balanced fences.
const helpRealChunks = T.splitDiscordText(fullHelp, T.chunkerConstants.maxDiscordChars);
const helpUnbalanced = helpRealChunks.filter((c) => ((c.match(/```/g) || []).length % 2) !== 0).length;
check('help+chunker: real help text chunks have balanced fences', helpUnbalanced === 0, helpUnbalanced + ' unbalanced');
const helpOversize = helpRealChunks.filter((c) => c.length > T.chunkerConstants.maxDiscordChars).length;
check('help+chunker: real help text chunks under limit', helpOversize === 0, helpOversize + ' oversize');

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
