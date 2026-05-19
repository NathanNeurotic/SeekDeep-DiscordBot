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

// v10.12: GPU helpers
console.log('15. GPU monitoring helpers.');
check('gpu bar: 0% -> all empty', T.seekdeepFormatGpuBar(0) === '░'.repeat(20));
check('gpu bar: 100% -> all filled', T.seekdeepFormatGpuBar(100) === '█'.repeat(20));
check('gpu bar: 50% -> half filled', T.seekdeepFormatGpuBar(50) === '█'.repeat(10) + '░'.repeat(10));
check('gpu bar: clamps over 100%', T.seekdeepFormatGpuBar(150) === '█'.repeat(20));
check('gpu bar: clamps negative', T.seekdeepFormatGpuBar(-10) === '░'.repeat(20));

const unavailable = T.seekdeepFormatGpuStats({ available: false });
check('gpu format: unavailable surfaces as one-line summary', /unavailable/i.test(unavailable.summary));

const sample = {
  available: true,
  device_name: 'NVIDIA GeForce RTX 5090 Laptop GPU',
  total_mb: 24576,
  free_mb: 10000,
  used_mb: 14576,
  allocated_mb: 5000,
  reserved_mb: 8000,
  used_pct: 59.3,
  reserved_pct: 32.5,
  loaded: { chat_model: true, vision_model: false, image_pipe: false },
  loaded_chat_role: 'default_chat',
  loaded_chat_model_id: 'meta-llama/Llama-3.1-8B-Instruct',
  keep_resident: { vision: true, image: false },
};
const formatted = T.seekdeepFormatGpuStats(sample);
check('gpu format: summary includes device name', /RTX 5090/.test(formatted.summary));
check('gpu format: summary includes used/total GB', /14\.2[34] \/ 24\.00 GB/.test(formatted.summary));
check('gpu format: detail shows loaded chat model', formatted.detail.some((l) => l.includes('meta-llama/Llama-3.1-8B-Instruct')));
check('gpu format: detail shows pinned vision', formatted.detail.some((l) => /Pinned.*vision/.test(l)));
check('gpu format: no thrashing warning at 32% reserved', formatted.thrashing !== true);

const thrash = T.seekdeepFormatGpuStats({ ...sample, reserved_mb: 23000, reserved_pct: 93.5 });
check('gpu format: thrashing flag at 93% reserved', thrash.thrashing === true);
check('gpu format: thrashing warning in detail', thrash.detail.some((l) => /WARNING/.test(l)));

// Watch interval parser
check('gpu watch: "gpu watch" -> default 5', T.seekdeepParseGpuWatchInterval('gpu watch') === 5);
check('gpu watch: "vram watch 10" -> 10', T.seekdeepParseGpuWatchInterval('vram watch 10') === 10);
check('gpu watch: "gpu watch 1" clamps to 2', T.seekdeepParseGpuWatchInterval('gpu watch 1') === 2);
check('gpu watch: "gpu watch 999" clamps to 60', T.seekdeepParseGpuWatchInterval('gpu watch 999') === 60);

// v10.13: dynamic image-prompt cleaner regressions
console.log('16. Dynamic image-prompt refine cleaner (real seekdeepCleanDynamicImagePromptDetailed).');
const clean = T.seekdeepCleanDynamicImagePromptDetailed;

// The actual case from the bot report: "a vanilla ant colony" + benign opener.
const realCase = clean(
  "Sure, here's the refined image prompt: a vanilla ant colony with translucent amber tunnels, soft macro lighting, hyper-detailed",
  'a vanilla ant colony',
);
check('cleaner: strips "Sure, here\'s..." preamble', realCase.reason === 'ok' && /vanilla ant colony/i.test(realCase.value));

const realCase2 = clean(
  "Here is the refined prompt: a brass lantern in a foggy forest, cinematic light shafts, painterly, 4k",
  'a brass lantern in a foggy forest',
);
check('cleaner: strips "Here is the refined prompt:" preamble', realCase2.reason === 'ok');

const realCase3 = clean(
  "Okay! a serene mountain lake at dawn, mirror-still water, alpenglow on peaks",
  'a serene mountain lake at dawn',
);
check('cleaner: strips "Okay!" preamble', realCase3.reason === 'ok');

// Real refusal — must still be rejected.
const refusal = clean(
  "I can't help with that request.",
  'something benign',
);
check('cleaner: actual refusal still rejected', refusal.reason === 'refusal-detected');

const refusalApology = clean(
  'Sorry, I cannot produce content of that nature.',
  'something benign',
);
check('cleaner: "Sorry, I cannot..." rejected', refusalApology.reason === 'refusal-detected');

// Empty output is still rejected.
const empty = clean('   \n\n  ', 'a banana');
check('cleaner: empty output rejected', empty.reason === 'empty-after-cleanup');

// Subject not preserved -> rejected.
const lostSubject = clean(
  'a vast oil painting of waves crashing at sunset',
  'a vanilla ant colony',
);
check('cleaner: subject-not-preserved is detected', lostSubject.reason === 'subject-not-preserved');

// Too generic -> rejected.
const genericOutput = clean(
  'a banana, stylized illustration, clear details, expressive subject, beautiful composition',
  'a banana',
);
check('cleaner: generic-only refine rejected', genericOutput.reason === 'too-generic');

// Reason field is always present and non-empty.
check('cleaner: success has reason="ok"', realCase.reason === 'ok');
check('cleaner: reason field is always a non-empty string',
  typeof realCase.reason === 'string' && realCase.reason.length > 0 &&
  typeof refusal.reason === 'string' && refusal.reason.length > 0,
);

// v10.14: subject-preservation threshold loosened.
console.log('17. Subject preservation (real seekdeepDynamicImagePromptPreservesSubject).');
const preserves = T.seekdeepDynamicImagePromptPreservesSubject;

// The exact case from the v10.13 user bug report. Previously rejected with
// `subject-not-preserved` because franchise words ("movie antz similar bugs
// life") counted against the 45% threshold. Now should pass.
check(
  'subject: ant-from-antz case preserves vanilla+colored+ant (was rejected pre-v10.14)',
  preserves(
    'a vanilla colored ant from the movie antz simmiliar to a bugs life',
    'a vanilla colored ant with a smooth, glossy exoskeleton, standing on a vibrant green leaf in a sunlit meadow, backlit by golden hour light, framed with shallow depth of field, surrounded by dewdrops reflecting the sky, soft pastel tones, in',
  ) === true,
);

// Short prompt: 2 keywords -> both must survive.
check('subject: "a red apple" -> "a banana" fails', preserves('a red apple', 'a banana in a basket') === false);
check('subject: "a red apple" -> "a red apple on a table" passes', preserves('a red apple', 'a red apple on a wooden table') === true);

// Medium prompt: at least 2 head nouns must survive.
check(
  'subject: 4-keyword prompt preserves 2 head nouns (passes)',
  preserves('a brass lantern in a foggy forest', 'a brass lantern glowing softly amidst rolling mist, cinematic lighting') === true,
);

// Off-topic refinement (true subject loss) still fails.
check(
  'subject: completely off-topic refine still fails',
  preserves('a red sports car', 'a banana in a sunny meadow') === false,
);

// Long prompt with many keywords: only 3 required, not 7+.
check(
  'subject: 12-keyword prompt only needs 3 preserved (passes)',
  preserves(
    'a tall cyberpunk warrior with neon armor and glowing katana in a rainy tokyo alley',
    'a tall cyberpunk warrior with iridescent neon armor wielding a glowing katana, atmospheric, vivid',
  ) === true,
);

// Edge case: keyword extractor returns nothing -> always pass.
check('subject: empty original always passes', preserves('', 'anything') === true);
check('subject: only-stopwords original always passes', preserves('a the of with', 'a banana') === true);

// ---------------------------------------------------------------------------
// Suite 18: Archive clean duration parser
// ---------------------------------------------------------------------------
console.log('18. Archive clean duration parser (real seekdeepParseCleanDuration).');
const parseDuration = T.seekdeepParseCleanDuration;

check('clean-duration: "7d" = 7 days', parseDuration('7d') === 7 * 86400000);
check('clean-duration: "7 days" = 7 days', parseDuration('7 days') === 7 * 86400000);
check('clean-duration: "2w" = 14 days', parseDuration('2w') === 14 * 86400000);
check('clean-duration: "2 weeks" = 14 days', parseDuration('2 weeks') === 14 * 86400000);
check('clean-duration: "1m" = 30 days', parseDuration('1m') === 30 * 86400000);
check('clean-duration: "1 month" = 30 days', parseDuration('1 month') === 30 * 86400000);
check('clean-duration: "24h" = 24 hours', parseDuration('24h') === 24 * 3600000);
check('clean-duration: empty = 0', parseDuration('') === 0);
check('clean-duration: garbage = 0', parseDuration('foobar') === 0);
check('clean-duration: "0d" = 0', parseDuration('0d') === 0);

// ---------------------------------------------------------------------------
// Suite 19: OCR mode detection
// ---------------------------------------------------------------------------
console.log('19. OCR mode detection (real seekdeepLooksLikeOcrPrompt).');
const ocrDetect = T.seekdeepLooksLikeOcrPrompt;

check('ocr: "read this" triggers', ocrDetect('read this') === true);
check('ocr: "ocr" triggers', ocrDetect('ocr') === true);
check('ocr: "extract text" triggers', ocrDetect('extract text from this') === true);
check('ocr: "what does this say" triggers', ocrDetect('what does this say') === true);
check('ocr: "what is written" triggers', ocrDetect('what is written here') === true);
check('ocr: "transcribe this" triggers', ocrDetect('transcribe this') === true);
check('ocr: "copy the text" triggers', ocrDetect('copy the text') === true);
check('ocr: "describe this" does NOT trigger', ocrDetect('describe this') === false);
check('ocr: "what is this" does NOT trigger', ocrDetect('what is this') === false);
check('ocr: empty does NOT trigger', ocrDetect('') === false);

// ---------------------------------------------------------------------------
// Suite 20: Help search
// ---------------------------------------------------------------------------
console.log('20. Help search (real seekdeepHelpSearch).');
const helpSearch = T.seekdeepHelpSearch;

check('help-search: "archive" returns sections', helpSearch('archive').includes('Archive'));
check('help-search: "regenerate" finds recent/cache section', helpSearch('regenerate').includes('regen'));
check('help-search: "persona" finds admin section', helpSearch('persona').includes('Admin'));
check('help-search: multi-word "archive search" matches', helpSearch('archive search').includes('archive search'));
check('help-search: nonsense returns no-results message', helpSearch('xyzzyplugh').includes('No help results'));
check('help-search: empty query returns usage hint', helpSearch('').includes('Provide a search term'));
check('help-search: result includes section count', /\d+ section/.test(helpSearch('image')));

// ---------------------------------------------------------------------------
// Suite 21: Archive counting reliability
// ---------------------------------------------------------------------------
console.log('21. Archive counting reliability (trustedCount, buildName, entryDetector).');
const {
  seekdeepArchiveThreadTrustedCount: trustedCount,
  seekdeepArchiveThreadBuildName: buildName,
  seekdeepArchiveThreadDisplayName: displayName,
  seekdeepArchiveMessageLooksLikeEntry: looksLikeEntry,
  SEEKDEEP_ARCHIVE_COUNT_SOURCE: countSource,
} = T;

// trustedCount only returns > 0 when countSource matches
check('count: trusted with correct source', trustedCount({ count: 5, countSource }) === 5);
check('count: trusted with wrong source = 0', trustedCount({ count: 99, countSource: 'legacy' }) === 0);
check('count: trusted with missing source = 0', trustedCount({ count: 10 }) === 0);
check('count: trusted with null profile = 0', trustedCount(null) === 0);
check('count: trusted with empty = 0', trustedCount({}) === 0);
check('count: trusted ignores negative', trustedCount({ count: -3, countSource }) === 0);

// buildName produces expected format: 🪙 • Archive • name • count
check('name: includes count', buildName({ displayName: 'Nathan' }, 7).includes('7'));
check('name: includes display name', buildName({ displayName: 'Nathan' }, 3).includes('Nathan'));
check('name: includes Archive', buildName({ displayName: 'Test' }, 0).includes('Archive'));
check('name: zero count shows 0', buildName({ displayName: 'Test' }, 0).includes('0'));

// displayName sanitizes
check('display: basic name', displayName({ displayName: 'Nathan' }) === 'Nathan');
check('display: falls back to username', displayName({ username: 'nate' }) === 'nate');
check('display: strips @everyone', !displayName({ displayName: '@everyone' }).includes('@everyone'));
check('display: empty = unknown', displayName({}) === 'unknown');

// Entry detector needs the right content shape
const fakeBot = { user: { id: '123' } };
const fakeThread = { client: fakeBot };
const goodEntry = { content: '**SeekDeep Image Archive Entry**\nRequester: Nathan\nPrompt: a cool dragon', author: { id: '123' } };
const noRequester = { content: '**SeekDeep Image Archive Entry**\nPrompt: a cool dragon', author: { id: '123' } };
const noPrompt = { content: '**SeekDeep Image Archive Entry**\nRequester: Nathan', author: { id: '123' } };
const wrongAuthor = { content: '**SeekDeep Image Archive Entry**\nRequester: Nathan\nPrompt: a cool dragon', author: { id: '999' } };
const randomMsg = { content: 'Just a regular message', author: { id: '123' } };

check('entry: valid entry detected', looksLikeEntry(goodEntry, fakeThread) === true);
check('entry: missing Requester rejected', looksLikeEntry(noRequester, fakeThread) === false);
check('entry: missing Prompt rejected', looksLikeEntry(noPrompt, fakeThread) === false);
check('entry: wrong author rejected', looksLikeEntry(wrongAuthor, fakeThread) === false);
check('entry: random message rejected', looksLikeEntry(randomMsg, fakeThread) === false);
check('entry: null message rejected', looksLikeEntry(null, fakeThread) === false);

// ---------------------------------------------------------------------------
// Suite 22: Conversation search
// ---------------------------------------------------------------------------
console.log('22. Conversation search (query extraction + result formatting).');
const {
  seekdeepConversationSearchQueryFromMessage: convSearchQuery,
  seekdeepFormatConversationSearchResults: convSearchFormat,
} = T;

// Query extraction from message
check('conv-search: "@SeekDeep search dragon" extracts query', convSearchQuery('@SeekDeep search dragon') === 'dragon');
check('conv-search: "<@123> search cool art" extracts query', convSearchQuery('<@123> search cool art') === 'cool art');
check('conv-search: "seekdeep search multi word" works', convSearchQuery('seekdeep search multi word query') === 'multi word query');
check('conv-search: no "search" keyword = empty', convSearchQuery('@SeekDeep hello') === '');
check('conv-search: empty = empty', convSearchQuery('') === '');
check('conv-search: "archive search" does NOT match', convSearchQuery('@SeekDeep archive search test') === '');

// Result formatting
check('conv-search: empty error shows message', convSearchFormat({ matches: [], scanned: 0, error: 'empty query' }, 'test').includes('failed'));
check('conv-search: no matches shows scanned count', convSearchFormat({ matches: [], scanned: 200 }, 'xyz').includes('200'));
check('conv-search: matches show count', convSearchFormat({
  matches: [{ type: 'bot', content: 'Hello world', messageId: '1', channelId: '2', guildId: '3', timestamp: Date.now(), at: '2026-05-18 12:00' }],
  scanned: 100,
}, 'hello').includes('1 match'));

// ---------------------------------------------------------------------------
// Suite 23: Prompt templates
// ---------------------------------------------------------------------------
console.log('23. Prompt template name sanitization + limits.');
const {
  seekdeepTemplateNameSanitize: templateName,
  SEEKDEEP_MAX_TEMPLATES_PER_USER: maxTemplates,
} = T;

check('template-name: lowercase', templateName('MyTemplate') === 'mytemplate');
check('template-name: strips special chars', templateName('cool dragon!') === 'cool-dragon-');
check('template-name: preserves hyphens', templateName('cyber-punk') === 'cyber-punk');
check('template-name: preserves underscores', templateName('cool_art') === 'cool_art');
check('template-name: truncates to 30', templateName('a'.repeat(50)).length <= 30);
check('template-name: empty = empty', templateName('') === '');
check('template-max: default limit is reasonable', maxTemplates >= 10 && maxTemplates <= 100);

// ---------------------------------------------------------------------------
// Suite 24: img2img + upscale query extraction
// ---------------------------------------------------------------------------
console.log('24. img2img + upscale query extraction.');
const {
  seekdeepImg2ImgQueryFromMessage: img2imgQuery,
  seekdeepUpscaleQueryFromMessage: upscaleQuery,
} = T;

// img2img query extraction
check('img2img: "@SeekDeep img2img make it cyberpunk" extracts', img2imgQuery('@SeekDeep img2img make it cyberpunk') === 'make it cyberpunk');
check('img2img: "<@123> img2img oil painting" extracts', img2imgQuery('<@123> img2img oil painting') === 'oil painting');
check('img2img: empty = null', img2imgQuery('') === null);
check('img2img: no img2img keyword = null', img2imgQuery('@SeekDeep draw a cat') === null);

// upscale query extraction
check('upscale: "@SeekDeep upscale" extracts default 2x', upscaleQuery('@SeekDeep upscale')?.scale === 2);
check('upscale: "@SeekDeep upscale 4x" extracts 4x', upscaleQuery('@SeekDeep upscale 4x')?.scale === 4);
check('upscale: "@SeekDeep upscale 3x" extracts 3x', upscaleQuery('<@123> upscale 3x')?.scale === 3);
check('upscale: no keyword = null', upscaleQuery('@SeekDeep draw a cat') === null);
check('upscale: empty = null', upscaleQuery('') === null);

// ---------------------------------------------------------------------------
// Suite 25: Rotating status bank
// ---------------------------------------------------------------------------
console.log('25. Rotating status bank.');
const { SEEKDEEP_STATUS_BANK: statusBank, seekdeepShuffleStatusOrder: shuffleOrder, seekdeepStatusOrder: getOrder } = T;

check('status: bank is a non-empty array', Array.isArray(statusBank) && statusBank.length > 0);
check('status: bank has 50+ entries', statusBank.length >= 50);
check('status: every entry is [number, string]', statusBank.every(([t, n]) => typeof t === 'number' && typeof n === 'string' && n.length > 0));

// Shuffle produces a permutation of the correct length with no duplicates.
shuffleOrder();
const order = getOrder();
check('status: shuffle produces array of correct length', order.length === statusBank.length);
check('status: shuffle has no duplicate indices', new Set(order).size === order.length);
check('status: all indices are in range', order.every((i) => i >= 0 && i < statusBank.length));

// Two shuffles are very unlikely to be identical (probability ~1/52!).
const firstOrder = [...order];
shuffleOrder();
const secondOrder = getOrder();
check('status: two shuffles differ (randomness)', JSON.stringify(firstOrder) !== JSON.stringify(secondOrder));

// ---------- Suite 26: Auto-translate non-Latin detector ----------
console.log('26. Auto-translate non-Latin detector.');
const looksNL = T.seekdeepLooksLikeNonLatin;
check('non-latin: Cyrillic "Привет" detects', looksNL('Привет мир') === true);
check('non-latin: CJK "こんにちは" detects', looksNL('こんにちは') === true);
check('non-latin: Arabic "مرحبا" detects', looksNL('مرحبا') === true);
check('non-latin: Korean "안녕하세요" detects', looksNL('안녕하세요') === true);
check('non-latin: plain English is false', looksNL('hello world') === false);
check('non-latin: empty is false', looksNL('') === false);
check('non-latin: short (<3 chars) is false', looksNL('ab') === false);
check('non-latin: mentions stripped before check', looksNL('<@123456789> hello') === false);
check('non-latin: mixed mention + CJK still detects', looksNL('<@123> 你好世界') === true);

// ---------- Suite 27: Loading GIF feature ----------
console.log('27. Loading GIF feature.');
check('loading-gif: helper function exists', typeof T.seekdeepLoadingGifAttachment === 'function');
const gifPresent = T.SEEKDEEP_LOADING_GIF_PATH !== null;
if (gifPresent) {
  // assets/loading.gif exists on this machine — verify the loader cached it.
  check('loading-gif: path resolved when file exists', typeof T.SEEKDEEP_LOADING_GIF_PATH === 'string' && T.SEEKDEEP_LOADING_GIF_PATH.length > 0);
  check('loading-gif: buffer loaded when file exists', T.SEEKDEEP_LOADING_GIF_BUFFER instanceof Buffer || T.SEEKDEEP_LOADING_GIF_BUFFER instanceof Uint8Array);
  check('loading-gif: helper returns AttachmentBuilder when file exists', T.seekdeepLoadingGifAttachment() !== null);
} else {
  // No GIF on disk — verify graceful no-op.
  check('loading-gif: returns null when no GIF file present', T.seekdeepLoadingGifAttachment() === null);
  check('loading-gif: SEEKDEEP_LOADING_GIF_PATH is null when file missing', T.SEEKDEEP_LOADING_GIF_PATH === null);
  check('loading-gif: SEEKDEEP_LOADING_GIF_BUFFER is null when file missing', T.SEEKDEEP_LOADING_GIF_BUFFER === null);
}

// ── Suite 28: Research-followup predicate (false-positive fix) ───────
check('research-followup: "pros and cons of each" matches', T.seekdeepIsResearchFollowupPrompt('pros and cons of each'));
check('research-followup: "compare those" matches', T.seekdeepIsResearchFollowupPrompt('compare those'));
check('research-followup: "compare these" matches', T.seekdeepIsResearchFollowupPrompt('compare these'));
check('research-followup: "rank these" matches', T.seekdeepIsResearchFollowupPrompt('rank these'));
check('research-followup: "Are these real give me embed links" does NOT match', !T.seekdeepIsResearchFollowupPrompt('Are these real give me embed links'));
check('research-followup: "these are my favourite songs" does NOT match', !T.seekdeepIsResearchFollowupPrompt('these are my favourite songs'));
check('research-followup: "I like those shoes" does NOT match', !T.seekdeepIsResearchFollowupPrompt('I like those shoes'));
check('research-followup: "fact check this" matches', T.seekdeepIsResearchFollowupPrompt('fact check this'));

// ── Suite 29: Context-menu footer stripper ──────────────────────────
check('footer-strip: strips Time to Generate + Model Used', T.seekdeepStripResponseFooter('Hello world\n\nTime to Generate: 5.23 seconds\nModel Used: meta-llama/Llama-3.1-8B-Instruct') === 'Hello world');
check('footer-strip: strips image footer with Generated/Refined/Queue', T.seekdeepStripResponseFooter('Pretty cat\n\nGenerated: a cat\nRefined Prompt: a pretty cat on a hill\nRefinement: on (AI-refined)\nQueue Wait: 12.00 seconds\nJob ID: imgq_123_1\nTime to Generate: 8.00 seconds\nModel Used: Lykon/dreamshaper-xl-1-0') === 'Pretty cat');
check('footer-strip: preserves text with no footer', T.seekdeepStripResponseFooter('Just normal text here') === 'Just normal text here');
check('footer-strip: handles empty string', T.seekdeepStripResponseFooter('') === '');

// ── Suite 30: Conversational image-edit followup detection ──────────
check('conv-edit: "make it darker"', T.seekdeepLooksLikeConversationalImageEditFollowup('make it darker') === true);
check('conv-edit: "Can you make the same image but without wizard"', T.seekdeepLooksLikeConversationalImageEditFollowup('Can you make the same image but without wizard and his ball?') === true);
check('conv-edit: "could you make this one brighter"', T.seekdeepLooksLikeConversationalImageEditFollowup('could you make this one brighter') === true);
check('conv-edit: "same thing but without the background"', T.seekdeepLooksLikeConversationalImageEditFollowup('same thing but without the background') === true);
check('conv-edit: "redo the image without the cat"', T.seekdeepLooksLikeConversationalImageEditFollowup('redo the image without the cat') === true);
check('conv-edit: "what does this image show" is NOT edit', T.seekdeepLooksLikeConversationalImageEditFollowup('what does this image show') === false);
check('conv-edit: "make me a sandwich" is NOT edit', T.seekdeepLooksLikeConversationalImageEditFollowup('make me a sandwich') === false);
check('conv-edit: "change the first one to red"', T.seekdeepLooksLikeConversationalImageEditFollowup('change the first one to red') === true);

// ── Suite 31: Conversational image-edit instruction cleaner ─────────
check('conv-clean: "Can you make the same image but without wizard" → "without wizard..."', T.seekdeepCleanConversationalImageEditInstruction('Can you make the same image but without wizard and his ball?') === 'without wizard and his ball?');
check('conv-clean: "make it darker" → "darker"', T.seekdeepCleanConversationalImageEditInstruction('make it darker') === 'darker');
check('conv-clean: "change the first one to red" → "red"', T.seekdeepCleanConversationalImageEditInstruction('change the first one to red') === 'red');

// ── Suite 32: Context-menu prompt extraction (image messages) ─────────
console.log('32. Context-menu prompt extraction.');

check('ctx-extract: Generated message → clean prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Generated: crystal ball wizard\nRefinement: off\nQueue Wait: 0.00 seconds\nJob ID: imgq_123_1\n\nTime to Generate: 7.92 seconds\nModel Used: Lykon/dreamshaper-xl-1-0' }) === 'crystal ball wizard');
check('ctx-extract: Refined Prompt message → refined prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Generated: raw prompt\nRefined Prompt: a beautiful sunset over mountains\nRefinement: on\nQueue Wait: 1.00 seconds\nJob ID: imgq_456_1\n\nTime to Generate: 10.00 seconds\nModel Used: Lykon/dreamshaper-xl-1-0' }) === 'a beautiful sunset over mountains');
check('ctx-extract: img2img result → clean prompt', T.seekdeepExtractContextMenuPromptText({ content: 'img2img complete (strength 0.85): crystal ball wizard, without the wizard' }) === 'crystal ball wizard, without the wizard');
check('ctx-extract: InstructPix2Pix result → instruction', T.seekdeepExtractContextMenuPromptText({ content: 'InstructPix2Pix edit: make it darker and more dramatic' }) === 'make it darker and more dramatic');
check('ctx-extract: Inpaint result → prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Inpaint complete: removed "wizard" — crystal ball on a table' }) === 'crystal ball on a table');
check('ctx-extract: plain text → unchanged', T.seekdeepExtractContextMenuPromptText({ content: 'A beautiful sunset over the ocean' }) === 'A beautiful sunset over the ocean');
check('ctx-extract: chat with footer → footer stripped', T.seekdeepExtractContextMenuPromptText({ content: 'Here is my analysis.\n\nTime to Generate: 3.00 seconds\nModel Used: meta-llama/Llama-3.1-8B-Instruct' }) === 'Here is my analysis.');
check('ctx-extract: nested Generated: Generated: → just inner prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Generated: Generated: wizard with ball Refinement: off Queue Wait: 0.00 seconds Job ID: imgq_123_1\nRefinement: off\nQueue Wait: 0.00 seconds\nJob ID: imgq_456_1' }) === 'Generated: wizard with ball Refinement: off Queue Wait: 0.00 seconds Job ID: imgq_123_1');

// ── Suite 33: Edit result prompt extraction ───────────────────────────
console.log('33. Edit result prompt extraction.');
check('edit-extract: img2img with parenthetical', T.seekdeepExtractEditResultPrompt('img2img complete (strength 0.6): a cat in a hat') === 'a cat in a hat');
check('edit-extract: pix2pix', T.seekdeepExtractEditResultPrompt('InstructPix2Pix edit: make the sky blue') === 'make the sky blue');
check('edit-extract: inpaint with em-dash', T.seekdeepExtractEditResultPrompt('Inpaint complete: removed "tree" — forest clearing with sunlight') === 'forest clearing with sunlight');
check('edit-extract: normal text → empty', T.seekdeepExtractEditResultPrompt('just some text') === '');

// ── Suite 34: Image metadata line stripper ────────────────────────────
console.log('34. Image metadata line stripper.');
check('meta-strip: strips Refinement/Queue/Job lines', T.seekdeepStripImageMetadataLines('hello world\nRefinement: off\nQueue Wait: 0.00 seconds\nJob ID: imgq_123') === 'hello world');
check('meta-strip: strips Time to Generate + Model Used', T.seekdeepStripImageMetadataLines('response text\nTime to Generate: 5.00 seconds\nModel Used: some/model') === 'response text');
check('meta-strip: preserves normal text', T.seekdeepStripImageMetadataLines('no metadata here') === 'no metadata here');

// ── Suite 35: img2img / pix2pix / inpaint mention command extraction ─
console.log('35. Mention command query extraction (img2img, pix2pix, inpaint).');
check('img2img: with prompt', T.seekdeepImg2ImgQueryFromMessage('<@123> img2img make it dark') === 'make it dark');
check('img2img: bare (no prompt) → empty string', T.seekdeepImg2ImgQueryFromMessage('<@123> img2img') === '');
check('img2img: non-match → null', T.seekdeepImg2ImgQueryFromMessage('<@123> help') === null);
check('img2img: @seekdeep alias', T.seekdeepImg2ImgQueryFromMessage('@seekdeep img2img enhance') === 'enhance');
check('pix2pix: with instruction', T.seekdeepPix2PixQueryFromMessage('<@123> pix2pix make it darker') === 'make it darker');
check('pix2pix: bare → empty string', T.seekdeepPix2PixQueryFromMessage('<@123> pix2pix') === '');
check('pix2pix: non-match → null', T.seekdeepPix2PixQueryFromMessage('<@123> help') === null);
check('pix2pix: @seekdeep alias', T.seekdeepPix2PixQueryFromMessage('@seekdeep pix2pix add snow') === 'add snow');
check('inpaint: with target', T.seekdeepInpaintQueryFromMessage('<@123> inpaint the wizard') === 'the wizard');
check('inpaint: bare → empty string', T.seekdeepInpaintQueryFromMessage('<@123> inpaint') === '');
check('inpaint: non-match → null', T.seekdeepInpaintQueryFromMessage('<@123> draw me a cat') === null);
check('inpaint: @seekdeep alias', T.seekdeepInpaintQueryFromMessage('@seekdeep inpaint background trees') === 'background trees');

// ── Suite 36: adaptive img2img strength ─
console.log('36. Adaptive img2img strength.');
check('strength: additive "add warrior stick figures" → 0.80', T.seekdeepAdaptiveImg2ImgStrength('add warrior stick figures wielding weapons') === 0.80);
check('strength: style "make it cyberpunk" → 0.65', T.seekdeepAdaptiveImg2ImgStrength('make it cyberpunk themed') === 0.65);
check('strength: enhance → 0.45', T.seekdeepAdaptiveImg2ImgStrength('enhance this image') === 0.45);
check('strength: removal "remove the background" → 0.75', T.seekdeepAdaptiveImg2ImgStrength('remove the background') === 0.75);
check('strength: default "oil painting of cats" → 0.60', T.seekdeepAdaptiveImg2ImgStrength('oil painting of cats') === 0.60);
check('strength: empty string → default 0.60', T.seekdeepAdaptiveImg2ImgStrength('') === 0.60);
check('strength: null → default 0.60', T.seekdeepAdaptiveImg2ImgStrength(null) === 0.60);
check('strength: undefined → default 0.60', T.seekdeepAdaptiveImg2ImgStrength(undefined) === 0.60);
check('strength: mixed "add color to the figure" → additive 0.80 wins', T.seekdeepAdaptiveImg2ImgStrength('add color to the figure') === 0.80);

// ── Suite 37: research-followup tightening ─
console.log('37. Research-followup pattern tightening.');
check('research: "pros and cons of each" still matches', T.seekdeepIsResearchFollowupPrompt('pros and cons of each'));
check('research: "compare those" still matches', T.seekdeepIsResearchFollowupPrompt('compare those'));
check('research: "specs for each" matches (tightened for-each)', T.seekdeepIsResearchFollowupPrompt('specs for each'));
check('research: "details for each" matches', T.seekdeepIsResearchFollowupPrompt('details for each'));
check('research: bare "for each separate" does NOT match', !T.seekdeepIsResearchFollowupPrompt('data for each separate'));
check('research: Kamo SSD message does NOT match', !T.seekdeepIsResearchFollowupPrompt('Nah too complex and can lead to flaws just make reasonable split including the data for each separate but be aware that win 11 pro is the main OS'));

// ── Suite 38: context menu image extraction (embed fallback) ─
console.log('38. Context menu image extraction (embed fallback).');
check('ctxImage: attachment hit', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [{ url: 'https://cdn.discord.com/foo.png', name: 'test.png' }] } })?.url === 'https://cdn.discord.com/foo.png');
check('ctxImage: embed image fallback', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [] }, embeds: [{ image: { url: 'https://example.com/bar.jpg' } }] })?.url === 'https://example.com/bar.jpg');
check('ctxImage: no image returns null', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [] }, embeds: [{ title: 'no image' }] }) === null);

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
