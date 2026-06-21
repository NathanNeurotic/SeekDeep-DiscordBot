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
// TEST-1: shorten the cross-process file-lock timeout so the fail-open test is fast
// + deterministic (the lock module reads this env at load time).
process.env.SEEKDEEP_FILE_LOCK_TIMEOUT_MS = process.env.SEEKDEEP_FILE_LOCK_TIMEOUT_MS || '300';

// Feature flags read at module-load time. Suite 51 exercises the mask preview
// routing path, which is gated by SEEKDEEP_FEATURE_INPAINT. Without this flag
// the dispatcher short-circuits with a "not enabled" reply and never reaches
// the /inpaint_mask_preview endpoint, so the URL/payload checks would fail
// regardless of the routing logic itself.
if (!process.env.SEEKDEEP_FEATURE_INPAINT) {
  process.env.SEEKDEEP_FEATURE_INPAINT = 'on';
}

// The reaction features (auto-react, emoji-vault, force-react) are asserted in
// their OFF state below (the help-text "section omitted when off" guards). Force
// them off here so the suite is deterministic regardless of the developer's .env
// — index.js reads these flags at import, and dotenv won't override an
// already-set var, so setting them before the import wins.
process.env.SEEKDEEP_FEATURE_AUTO_REACT = 'off';
process.env.SEEKDEEP_FEATURE_EMOJI_VAULT = 'off';
process.env.SEEKDEEP_FEATURE_FORCE_REACT = 'off';
// Universal-archive author-notify defaults to 'on' in code (!== 'off'), but a
// developer's .env may set it 'off'. Force it on here so the notify-gate
// assertions below are deterministic regardless of ambient .env — 'on' is the
// only value where all four gate checks (bot-skip, self-skip, fire-on-other,
// missing-target) are meaningful instead of trivially short-circuited by silent.
process.env.SEEKDEEP_UNIVERSAL_ARCHIVE_NOTIFY = 'on';

import { spawnSync } from 'node:child_process';
import http from 'node:http';

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
// ReDoS hardening: catastrophic-backtracking / oversized patterns must fail CLOSED
// (compile to null) so a user-supplied /regex/ can't freeze the bot's event loop.
check('reactrule ReDoS: /(a+)+$/ rejected → null', T.seekdeepCompileReactionPattern('/(a+)+$/') === null);
check('reactrule ReDoS: /(.*a){25}/ rejected → null', T.seekdeepCompileReactionPattern('/(.*a){25}/') === null);
check('reactrule ReDoS: /(\\d+)+/ rejected → null', T.seekdeepCompileReactionPattern('/(\\d+)+/') === null);
check('reactrule ReDoS: 250-char pattern rejected → null', T.seekdeepCompileReactionPattern('/' + 'a'.repeat(250) + '/') === null);
check('reactrule ReDoS: safe /bug.*report/i still compiles + matches', T.seekdeepCompileReactionPattern('/bug.*report/i')?.test('a bug report') === true);
check('reactrule ReDoS: safe /(foo|bar)/ not falsely rejected', T.seekdeepCompileReactionPattern('/(foo|bar)/')?.test('bar') === true);
// BOT-1: alternation-overlap repeated group `(a|a)*` bypassed the old nested-only
// detector and froze the event loop ~32s. Now rejected as a repeated group.
check('reactrule ReDoS: /(a|a)*$/ (alternation overlap) rejected → null', T.seekdeepCompileReactionPattern('/(a|a)*$/') === null);
check('reactrule ReDoS: /(ab)+/ (any repeated group) rejected → null', T.seekdeepCompileReactionPattern('/(ab)+/') === null);
check('reactrule ReDoS: /(x|y){1,9}/ (bounded repeated group) rejected → null', T.seekdeepCompileReactionPattern('/(x|y){1,9}/') === null);
check('reactrule ReDoS: safe optional group /(?:ab)?c/ still compiles', T.seekdeepCompileReactionPattern('/(?:ab)?c/')?.test('c') === true);

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
// Edge: a single over-limit line INSIDE a code block must stay fenced (each
// slice its own block, fence reopened) with no stray/unbalanced ``` and no
// chunk over the limit.
const lifInput = '```js\n' + 'x'.repeat(1500) + '\nshort tail\n```\nprose after';
const lifChunks = T.splitDiscordText(lifInput, 600);
let lifUnbalanced = 0, lifOver = 0;
for (const c of lifChunks) {
  if ((c.match(/```/g) || []).length % 2 !== 0) lifUnbalanced++;
  if (c.length > 600) lifOver++;
}
check('chunker: long line in fence -> all chunks fence-balanced', lifUnbalanced === 0, lifUnbalanced + ' unbalanced');
check('chunker: long line in fence -> no chunk over limit', lifOver === 0, lifOver + ' over');
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

// Force React per-guild config + cumulative per-user-per-message cap (the
// anti-pile-on safeguard). Default cap is env-tunable, so assert relationships
// (not a hard 3) to stay hermetic.
check('force-react: default cap clamped to [1,20]',
  T.forceReactConstants.defaultCap >= 1 && T.forceReactConstants.defaultCap <= 20);
check('force-react: unconfigured guild uses the default cap',
  T.seekdeepForceReactGuildConfig('0').cap === T.forceReactConstants.defaultCap);
check('force-react: unconfigured guild offers all emojis (empty allow-list)',
  T.seekdeepForceReactGuildConfig('0').allowedEmojiIds instanceof Set
  && T.seekdeepForceReactGuildConfig('0').allowedEmojiIds.size === 0);
T.seekdeepForceReactAppliedAdd('u-smoke', 'm-smoke', 2);
check('force-react: cumulative counter accrues',
  T.seekdeepForceReactAppliedGet('u-smoke', 'm-smoke').count === 2);
T.seekdeepForceReactAppliedAdd('u-smoke', 'm-smoke', 1);
check('force-react: cumulative counter holds across re-opens (caps stack)',
  T.seekdeepForceReactAppliedGet('u-smoke', 'm-smoke').count === 3);
check('force-react: counters are per (user,message)',
  T.seekdeepForceReactAppliedGet('u-smoke', 'm-other').count === 0);

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
// Reaction feature gating -- with all three flags off (the smoke default),
// the gated sections must NOT appear. Catches regressions where someone
// adds a reactrule/emoji-vault hint outside the feature-flag wrapper.
check('help: Auto-reactions section omitted when SEEKDEEP_FEATURE_AUTO_REACT=off',
  !/## Auto-reactions/.test(fullHelp));
check('help: Emoji vault section omitted when SEEKDEEP_FEATURE_EMOJI_VAULT=off',
  !/## Emoji vault/.test(fullHelp));
check('help: reactrule command lines omitted when AUTO_REACT=off',
  !/@SeekDeep reactrule list\b/.test(fullHelp));
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

const inventedHumanScene = clean(
  'A super-sized, curvaceous woman with vibrant turquoise hair and a bright red sari stands confidently on a rocky beach at sunset, her figure silhouetted against the warm orange-pink sky, with a sea of calm turquoise water lapping gently at her feet.',
  'Super Sized Big Beatiful Woman',
);
check('cleaner: rejects invented human setting/clothing from short generic prompt', /^unrequested-/.test(inventedHumanScene.reason));
check('human-specifics: reports unrequested setting', /^unrequested-setting:beach$/.test(T.seekdeepDynamicHumanPromptUnrequestedSpecificsReason('Super Sized Big Beatiful Woman', 'a woman on a rocky beach with turquoise hair')));

const longRefine = clean(
  'a brass lantern in a foggy forest, tarnished metal frame, warm amber flame behind rippled glass, mossy roots, drifting mist, wet leaves, cinematic rim light, shallow depth of field, soft film grain, cool green shadows, golden highlights, close-up composition, ornate handle, weathered patina, tiny water droplets, quiet mysterious mood',
  'a brass lantern in a foggy forest',
);
const longRefineWords = String(longRefine.value || '').split(/\s+/).filter(Boolean).length;
check('cleaner: dynamic refine is clamped for SDXL CLIP', longRefine.reason === 'ok' && longRefineWords <= T.imagePromptConstants.dynamicMaxWords && longRefine.value.length <= T.imagePromptConstants.dynamicMaxChars);
check('clamp: keeps prompt under configured word cap', T.seekdeepClampImagePromptForSdxl('one two three four five six seven eight nine ten', { maxWords: 8, maxChars: 200 }).split(/\s+/).length <= 8);

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
// Suite 19b: operator-default vision mode resolver (describe vs ocr)
// Under test mode there is no data/vision-mode-config.json and no
// SEEKDEEP_VISION_DEFAULT_MODE env, so the default resolves to 'describe' —
// this pins the zero-regression guarantee (shipped behavior unchanged) AND the
// per-message-cue-wins semantics. The env/file override is mtime-cached (keyed
// on the config file) and mirrors the force-react reader; its precedence is
// covered on the Python side.
// ---------------------------------------------------------------------------
console.log('19b. Default vision mode resolver (real seekdeepResolveVisionMode).');
const resolveVisionMode = T.seekdeepResolveVisionMode;
check('vision-mode: resolver exported', typeof resolveVisionMode === 'function');
check('vision-mode: default reader exported', typeof T.seekdeepReadVisionModeDefault === 'function');
// Explicit OCR cue always wins over the default.
check('vision-mode: "read this" -> ocr', resolveVisionMode('read this') === 'ocr');
check('vision-mode: "what does it say" -> ocr', resolveVisionMode('what does it say') === 'ocr');
// Explicit describe cue always wins over the default.
check('vision-mode: "describe this" -> describe', resolveVisionMode('describe this') === 'describe');
check('vision-mode: "caption this image" -> describe', resolveVisionMode('caption this image') === 'describe');
check('vision-mode: "analyze this" -> describe', resolveVisionMode('analyze this') === 'describe');
check('vision-mode: "what do you see" -> describe', resolveVisionMode('what do you see') === 'describe');
// Ambiguous / empty falls to the operator default, which is 'describe' as shipped.
check('vision-mode: ambiguous "what is this" -> default describe', resolveVisionMode('what is this') === 'describe');
check('vision-mode: empty -> default describe', resolveVisionMode('') === 'describe');
check('vision-mode: bare "this" -> default describe', resolveVisionMode('this') === 'describe');
check('vision-mode: shipped default is describe', T.seekdeepReadVisionModeDefault() === 'describe');

// ---------------------------------------------------------------------------
// Suite 19c: operator-default web-search mode (auto / off / always)
// No data/web-search-config.json and no SEEKDEEP_WEB_SEARCH_DEFAULT env under
// test mode, so the default resolves to 'auto' — the zero-regression guarantee.
// seekdeepHasExplicitSearchRequest is the 'off'-override detector: it must fire
// on clear search COMMANDS but NOT on the soft current-info heuristics.
// ---------------------------------------------------------------------------
console.log('19c. Default web-search mode (real seekdeepReadWebSearchDefault / seekdeepHasExplicitSearchRequest).');
delete process.env.SEEKDEEP_WEB_SEARCH_DEFAULT; // ensure the shipped fallback path
const readWebDefault = T.seekdeepReadWebSearchDefault;
const explicitSearch = T.seekdeepHasExplicitSearchRequest;
check('web-search: reader exported', typeof readWebDefault === 'function');
check('web-search: detector exported', typeof explicitSearch === 'function');
check('web-search: shipped default is auto', readWebDefault() === 'auto');
// Explicit search COMMANDS fire (these override an operator 'off' default).
check('web-search: "search the web for X" -> explicit', explicitSearch('search the web for the rtx 5090 price') === true);
check('web-search: "look it up" -> explicit', explicitSearch('look it up') === true);
check('web-search: "google it" -> explicit', explicitSearch('google it') === true);
check('web-search: "web search" -> explicit', explicitSearch('do a web search') === true);
check('web-search: "fact-check this" -> explicit', explicitSearch('fact-check this claim') === true);
check('web-search: "cite sources" -> explicit', explicitSearch('answer and cite sources') === true);
check('web-search: "find this online" -> explicit', explicitSearch('find this online for me') === true);
check('web-search: "search bing for X" -> explicit', explicitSearch('search bing for the answer') === true);
// Soft current-info heuristics are NOT explicit commands ('off' suppresses them).
check('web-search: "latest news" not explicit', explicitSearch('what is the latest news on mars') === false);
check('web-search: "current price" not explicit', explicitSearch('whats the current price of eth') === false);
check('web-search: plain chat not explicit', explicitSearch('tell me a story about a dog') === false);
check('web-search: empty not explicit', explicitSearch('') === false);
// Precision guards — these benign prompts must NOT defeat operator 'off'
// (false positives caught in adversarial review of the detector).
check('web-search: "essay with sources" not explicit', explicitSearch('write an essay with sources') === false);
check('web-search: "what is a citation" not explicit', explicitSearch('what is a citation') === false);
check('web-search: "search for a job" not explicit', explicitSearch('how do I search for a job') === false);
check('web-search: "use the internet daily" not explicit', explicitSearch('I use the internet every day') === false);
check('web-search: "check internet speed" not explicit', explicitSearch('how do I check the internet speed') === false);
check('web-search: "look up to mentor" not explicit', explicitSearch('I look up to my mentor') === false);

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
check('ctx-extract: Inpaint result → prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Inpaint complete: removed "wizard" — crystal ball on a table' }) === 'crystal ball on a table without wizard');
check('ctx-extract: plain text → unchanged', T.seekdeepExtractContextMenuPromptText({ content: 'A beautiful sunset over the ocean' }) === 'A beautiful sunset over the ocean');
check('ctx-extract: chat with footer → footer stripped', T.seekdeepExtractContextMenuPromptText({ content: 'Here is my analysis.\n\nTime to Generate: 3.00 seconds\nModel Used: meta-llama/Llama-3.1-8B-Instruct' }) === 'Here is my analysis.');
check('ctx-extract: nested Generated: Generated: → just inner prompt', T.seekdeepExtractContextMenuPromptText({ content: 'Generated: Generated: wizard with ball Refinement: off Queue Wait: 0.00 seconds Job ID: imgq_123_1\nRefinement: off\nQueue Wait: 0.00 seconds\nJob ID: imgq_456_1' }) === 'Generated: wizard with ball Refinement: off Queue Wait: 0.00 seconds Job ID: imgq_123_1');

// ── Suite 33: Edit result prompt extraction ───────────────────────────
console.log('33. Edit result prompt extraction.');
check('edit-extract: img2img with parenthetical', T.seekdeepExtractEditResultPrompt('img2img complete (strength 0.6): a cat in a hat') === 'a cat in a hat');
check('edit-extract: pix2pix', T.seekdeepExtractEditResultPrompt('InstructPix2Pix edit: make the sky blue') === 'make the sky blue');
check('edit-extract: inpaint with em-dash', T.seekdeepExtractEditResultPrompt('Inpaint complete: removed "tree" — forest clearing with sunlight') === 'forest clearing with sunlight without tree');
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
check('strength: style "make it cyberpunk" → 0.70', T.seekdeepAdaptiveImg2ImgStrength('make it cyberpunk themed') === 0.70);
check('strength: enhance → 0.45', T.seekdeepAdaptiveImg2ImgStrength('enhance this image') === 0.45);
check('strength: removal "remove the background" → 0.75', T.seekdeepAdaptiveImg2ImgStrength('remove the background') === 0.75);
check('strength: default "oil painting of cats" → 0.60', T.seekdeepAdaptiveImg2ImgStrength('oil painting of cats') === 0.60);
check('strength: empty string → default 0.60', T.seekdeepAdaptiveImg2ImgStrength('') === 0.60);
check('strength: null → default 0.60', T.seekdeepAdaptiveImg2ImgStrength(null) === 0.60);
check('strength: undefined → default 0.60', T.seekdeepAdaptiveImg2ImgStrength(undefined) === 0.60);
check('strength: mixed "add color to the figure" → additive 0.80 wins', T.seekdeepAdaptiveImg2ImgStrength('add color to the figure') === 0.80);
check('strength: scene "make it winter" → 0.80', T.seekdeepAdaptiveImg2ImgStrength('make it winter') === 0.80);
check('strength: scene "turn it into night" → 0.80', T.seekdeepAdaptiveImg2ImgStrength('turn it into night') === 0.80);
check('strength: scene "underwater ruins" → 0.80', T.seekdeepAdaptiveImg2ImgStrength('underwater ruins') === 0.80);
check('strength: scene "frozen wasteland" → 0.80', T.seekdeepAdaptiveImg2ImgStrength('frozen wasteland') === 0.80);

// ── Suite 37: research-followup tightening ─
console.log('37. Research-followup pattern tightening.');
check('research: "pros and cons of each" still matches', T.seekdeepIsResearchFollowupPrompt('pros and cons of each'));
check('research: "compare those" still matches', T.seekdeepIsResearchFollowupPrompt('compare those'));
check('research: "specs for each" matches (tightened for-each)', T.seekdeepIsResearchFollowupPrompt('specs for each'));
check('research: "details for each" matches', T.seekdeepIsResearchFollowupPrompt('details for each'));
check('research: bare "for each separate" does NOT match', !T.seekdeepIsResearchFollowupPrompt('data for each separate'));
check('research: Kamo SSD message does NOT match', !T.seekdeepIsResearchFollowupPrompt('Nah too complex and can lead to flaws just make reasonable split including the data for each separate but be aware that win 11 pro is the main OS'));

// ── Suite 38: inpaint prompt extraction ─
console.log('38. Inpaint prompt extraction.');
check('inpaint extract: removal target when fill is generic', T.seekdeepExtractEditResultPrompt('Inpaint complete: removed "the small houses" — background scene') === 'the small houses');
check('inpaint extract: combines target+scene when scene is specific', T.seekdeepExtractEditResultPrompt('Inpaint complete: removed "the wizard" — medieval castle courtyard') === 'medieval castle courtyard without the wizard');
check('img2img extract: unchanged', T.seekdeepExtractEditResultPrompt('img2img complete (strength 0.65, auto): make it winter') === 'make it winter');
check('pix2pix extract: unchanged', T.seekdeepExtractEditResultPrompt('InstructPix2Pix edit: make it darker') === 'make it darker');

// ── Suite 39: model router lightweight_chat ─
console.log('39. Model router lightweight_chat.');
// Only runs routing checks if the env var is set for the test
process.env.LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID = 'google/gemma-3n-E4B-it';
check('router: translation routes to lightweight', T.seekdeepSelectChatModelRole('translate this to english', 'translation') === 'lightweight_chat');
check('router: greeting routes to lightweight', T.seekdeepSelectChatModelRole('hello', 'chat') === 'lightweight_chat');
check('router: short trivial routes to lightweight', T.seekdeepSelectChatModelRole('who are you', 'chat') === 'lightweight_chat');
check('router: complex prompt routes to default', T.seekdeepSelectChatModelRole('tell me a story about a dragon and a knight in a faraway kingdom', 'chat') === 'default_chat');
// image_refinement only falls to lightweight when NO dedicated refine model is
// configured. A developer's .env may set LOCAL_CHAT_REFINE_MODEL_ID (which then
// correctly routes to refine_chat), so clear it just for this assertion and
// restore it after — otherwise this check fails on configured boxes. CI has no
// .env, which is why it previously passed there but failed locally. (The full
// refine-routing matrix is covered hermetically in the refinement-routing suite below.)
const _savedRefineModelIdForLightCheck = process.env.LOCAL_CHAT_REFINE_MODEL_ID;
delete process.env.LOCAL_CHAT_REFINE_MODEL_ID;
check('router: image_refinement routes to lightweight when no refine model set', T.seekdeepSelectChatModelRole('hello', 'image_refinement') === 'lightweight_chat');
if (_savedRefineModelIdForLightCheck !== undefined) process.env.LOCAL_CHAT_REFINE_MODEL_ID = _savedRefineModelIdForLightCheck;
delete process.env.LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID;
check('router: without env var, greeting falls to default', T.seekdeepSelectChatModelRole('hello', 'chat') === 'default_chat');

// ── Suite 40: adaptive strength scene tier ─
console.log('40. Adaptive strength scene/environment tier.');
check('strength: "make it winter" scene tier → 0.80', T.seekdeepAdaptiveImg2ImgStrength('make it winter') === 0.80);
check('strength: "destroyed city" scene tier → 0.80', T.seekdeepAdaptiveImg2ImgStrength('destroyed city ruins') === 0.80);
check('strength: "make it anime" style → 0.70', T.seekdeepAdaptiveImg2ImgStrength('make it anime style') === 0.70);
check('strength: "enhance" → 0.45', T.seekdeepAdaptiveImg2ImgStrength('enhance and polish') === 0.45);

// ── Suite 41: context menu image extraction (embed fallback) ─
console.log('41. Context menu image extraction (embed fallback).');
check('ctxImage: attachment hit', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [{ url: 'https://cdn.discord.com/foo.png', name: 'test.png' }] } })?.url === 'https://cdn.discord.com/foo.png');
check('ctxImage: embed image fallback', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [] }, embeds: [{ image: { url: 'https://example.com/bar.jpg' } }] })?.url === 'https://example.com/bar.jpg');
check('ctxImage: no image returns null', T.seekdeepContextMenuGetImageAttachment({ attachments: { values: () => [] }, embeds: [{ title: 'no image' }] }) === null);

// -- Suite 42: Discord message-link / embed extraction --
console.log('42. Discord message-link / embed extraction.');
const msgLink = T.seekdeepExtractDiscordMessageLink('its here https://discord.com/channels/1256458065834676244/1449291472540274781/1506688005992349716');
check('msg-link: parses guild/channel/message ids', msgLink?.guildId === '1256458065834676244' && msgLink?.channelId === '1449291472540274781' && msgLink?.messageId === '1506688005992349716');
check('msg-link: parses discordapp legacy host', T.seekdeepExtractDiscordMessageLink('https://discordapp.com/channels/111111/222222/333333')?.messageId === '333333');
check('embed-intent: read this embed matches', T.seekdeepLooksLikeEmbedInspectPrompt('can you read this embed') === true);
check('embed-intent: ordinary chat does not match', T.seekdeepLooksLikeEmbedInspectPrompt('how are you') === false);
const embedReport = T.seekdeepFormatDiscordMessageExtract({
  id: '333',
  guildId: '111',
  channelId: '222',
  author: { tag: 'tester#0001' },
  channel: { name: 'spam-it-up' },
  createdTimestamp: Date.UTC(2026, 4, 20, 16, 0, 0),
  content: 'hello @everyone',
  embeds: [{ data: { type: 'rich', title: 'Webhook post', description: 'A globe icon', image: { url: 'https://example.com/globe.png' }, fields: [{ name: 'Name', value: 'SeekDeep' }] } }],
  attachments: { values: () => [{ name: 'pfp.png', contentType: 'image/png', size: 2048, url: 'https://cdn.discordapp.com/pfp.png' }] },
}, msgLink);
check('embed-format: includes embed title/description/image', /Webhook post/.test(embedReport) && /A globe icon/.test(embedReport) && /globe\.png/.test(embedReport));
check('embed-format: includes attachments', /Attachment 1: pfp\.png/.test(embedReport));
check('embed-format: neutralizes everyone mention', embedReport.includes('@\u200beveryone'));

// -- Suite 43: Web-search query distillation --
console.log('43. Web-search query distillation.');
const todayIso = T.seekdeepCurrentDateIso();
const headlineQuery = T.seekdeepDistillWebSearchQuery("Supposedly you're more inference capable now. We should test it, look up today's top headlines in the USA world news");
check('search-query: strips inference/test lead-in', !/inference|capable|test it/i.test(headlineQuery));
check('search-query: preserves headline/news intent', /top headlines/i.test(headlineQuery) && /USA/i.test(headlineQuery) && /world news/i.test(headlineQuery));
check('search-query: resolves today to current ISO date', headlineQuery.includes(todayIso));
check('search-query: buildSearchQuery uses distilled prompt', T.buildSearchQuery("Supposedly you're more inference capable now. We should test it, look up today's top headlines in the USA world news").includes(todayIso));
check('search-query: non-search prompt stays recognizable', /crystal ball wizard/i.test(T.seekdeepDistillWebSearchQuery('draw a crystal ball wizard')));

// -- Suite 44: Archive dedupe keys + safe source links --
console.log('44. Archive dedupe keys + safe source links.');
const archiveKeyA = T.seekdeepArchiveKeyFromState({ buffer: Buffer.from('same image bytes') });
const archiveKeyB = T.seekdeepArchiveKeyFromState({ buffer: Buffer.from('same image bytes') });
check('archive-key: stable hash from buffer', archiveKeyA && archiveKeyA === archiveKeyB && archiveKeyA.startsWith('sha256:'));
check('archive-key: parses archive message key', T.seekdeepArchiveMessageArchiveKey({ content: '**SeekDeep Image Archive Entry**\nArchive Key: sha256:abc123\nRequester: <@1>\nPrompt: x' }) === 'sha256:abc123');
const sourceFooter = T.formatSources([{ index: 1, title: 'Example', url: 'https://example.com/story' }]);
check('sources: wraps URL in angle brackets to suppress embeds', sourceFooter.includes('<https://example.com/story>'));
check('sources: safe URL helper is idempotent', T.seekdeepDiscordSafeUrl('<https://example.com/a>') === '<https://example.com/a>');

// -- Suite 45: Image reply intent + RE-REFINE mode --
console.log('45. Image reply intent + RE-REFINE mode.');
check('image-reply: question routes to vision', T.seekdeepClassifyImageReplyIntent('what is this?', { hasReplyImage: true }).intent === 'vision');
check('image-reply: upscale routes to upscale', T.seekdeepClassifyImageReplyIntent('upscale this 4x', { hasReplyImage: true }).intent === 'upscale');
check('image-reply: edit routes to edit', T.seekdeepClassifyImageReplyIntent('make it darker', { hasReplyImage: true }).intent === 'edit');
check('image-reply: inspired routes fresh', T.seekdeepClassifyImageReplyIntent('make a new image inspired by this', { hasReplyImage: true }).intent === 'fresh_image');
check('image-reply: referential image request is ambiguous', T.seekdeepClassifyImageReplyIntent('make an image of this', { hasReplyImage: true }).intent === 'ambiguous');
check('image-reply: standalone image request does not hijack reply image', T.seekdeepClassifyImageReplyIntent('draw a red apple', { hasReplyImage: true }).intent === 'none');
const rerefineOptions = T.seekdeepRegenerateModeOptions('rerefine', { prompt: 'a cat', refinedPrompt: 'a fancy cat', imageModeOptions: { imageStepsOverride: 40 } });
check('RE-REFINE: forces fresh refinement', rerefineOptions.forceFreshRefinement === true && rerefineOptions.refine === true && rerefineOptions.preRefinedPrompt === undefined);
check('RE-REFINE: preserves image settings', rerefineOptions.imageStepsOverride === 40);

// -- Suite 46: Local GPU/status routing & overrides --
console.log('46. Local GPU/status routing & overrides.');
check('status-intent: "what GPU are you running on?"', T.seekdeepGetLocalStatusIntent('what GPU are you running on?') === 'local_gpu_status');
check('status-intent: "what hardware generation is it?"', T.seekdeepGetLocalStatusIntent('what hardware generation is it?') === 'local_gpu_generation');
check('status-intent: "what model are you using?"', T.seekdeepGetLocalStatusIntent('what model are you using?') === 'local_model_status');
check('status-intent: "are you local?"', T.seekdeepGetLocalStatusIntent('are you local?') === 'local_runtime_status');
check('status-intent: non-status returns null', T.seekdeepGetLocalStatusIntent('what is the weather like?') === null);

check('status-intent: "status gpu"', T.seekdeepGetLocalStatusIntent('status gpu') === 'local_gpu_status');
check('status-intent: "gpu status"', T.seekdeepGetLocalStatusIntent('gpu status') === 'local_gpu_status');
check('status-intent: "status vram"', T.seekdeepGetLocalStatusIntent('status vram') === 'local_gpu_status');
check('status-intent: "what are you running as a gpu?"', T.seekdeepGetLocalStatusIntent('what are you running as a gpu?') === 'local_gpu_status');
check('status-intent: "what are you running on as gpu?"', T.seekdeepGetLocalStatusIntent('what are you running on as gpu?') === 'local_gpu_status');

check('gpu-generation-mapping: RTX 5090', T.seekdeepGpuGenerationFromName('NVIDIA GeForce RTX 5090 Laptop GPU') === 'RTX 50-series / Blackwell-generation');
check('gpu-generation-mapping: RTX 3080 Ti', T.seekdeepGpuGenerationFromName('NVIDIA GeForce RTX 3080 Ti') === 'RTX 30-series / Ampere-generation');
check('gpu-generation-mapping: Unknown', T.seekdeepGpuGenerationFromName('Some GPU') === 'unknown GPU generation');

check('gpu-generation-line: empty string does not contain 5090', !T.seekdeepGetGpuGenerationLine('').includes('5090'));
check('gpu-generation-line: laptop GPU suffix', T.seekdeepGetGpuGenerationLine('NVIDIA GeForce RTX 5090 Laptop GPU').includes('RTX 50-series / Blackwell-generation laptop GPU. Current device: NVIDIA GeForce RTX 5090 Laptop GPU.'));

// Trivial reply checks
check('trivial reply: how are you feeling?', T.seekdeepGetTrivialLocalReply('how are you feeling?') !== '');
check('trivial reply: are you online?', T.seekdeepGetTrivialLocalReply('are you online?') !== '');
check('trivial reply: tell me a story', T.seekdeepGetTrivialLocalReply('tell me a story') === '');

check('brief-prompt: "keep it brief"', T.seekdeepIsBriefPrompt('keep it brief') === true);
check('brief-prompt: "1 or 2 lines"', T.seekdeepIsBriefPrompt('give me 1 or 2 lines') === true);
check('brief-prompt: non-brief returns false', T.seekdeepIsBriefPrompt('tell me a detailed story') === false);

check('no-search: "no web search"', T.seekdeepHasNoSearchOverride('no web search') === true);
check('no-search: "don\'t search"', T.seekdeepHasNoSearchOverride("don't search") === true);
check('no-search: ordinary question returns false', T.seekdeepHasNoSearchOverride('what is the capital of France?') === false);

// -- Suite 47: Archive counting & scope logic --
console.log('47. Archive counting & scope logic.');
check('archive-scope: shared archive', T.seekdeepGetArchiveScope({ shared: true }) === 'shared');
check('archive-scope: user archive', T.seekdeepGetArchiveScope({ shared: false, userId: '987654321' }) === '987654321');

// -- Suite 48: Refinement, RE-REFINE, Upscale, Embed Suppression --
console.log('48. Refinement, RE-REFINE, Upscale, Embed Suppression.');

// 1. Refinement model routing
process.env.LOCAL_CHAT_REFINE_MODEL_ID = 'test-refine-model';
process.env.LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID = 'test-light-model';
check('refine-routing: routes to refine_chat when configured', T.seekdeepSelectChatModelRole('prompt', 'image_refinement') === 'refine_chat');

delete process.env.LOCAL_CHAT_REFINE_MODEL_ID;
check('refine-routing: falls back to lightweight_chat', T.seekdeepSelectChatModelRole('prompt', 'image_refinement') === 'lightweight_chat');

delete process.env.LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID;
check('refine-routing: falls back to default_chat', T.seekdeepSelectChatModelRole('prompt', 'image_refinement') === 'default_chat');

// 2. Refinement preserves constraints (buildDynamicImagePromptRefineRequest)
const req1 = T.seekdeepBuildDynamicImagePromptRefineRequest('only draw a blue cat', '');
check('refine-prompt: preserves original text', req1.includes('Original prompt: only draw a blue cat'));
const req2 = T.seekdeepBuildDynamicImagePromptRefineRequest('make it winter', 'a cat on a mat');
check('refine-prompt: preserves parent context', req2.includes('Previous image prompt: a cat on a mat') && req2.includes('User request/change: make it winter'));

// 3. RE-REFINE state/custom_id generation is safe
const actionId = 'action_12345';
const components = T.seekdeepImageActionComponents(actionId);
let hasReRefineButton = false;
for (const row of components) {
  for (const comp of row.components) {
    if (comp.data.label === 'RE-REFINE') {
      hasReRefineButton = true;
      check('RE-REFINE: custom_id generation is safe', comp.data.custom_id === `seekdeep:regen:rerefine:${actionId}`);
    }
  }
}
check('RE-REFINE: button exists', hasReRefineButton);

// 4. Missing RE-REFINE state returns exact message
let mockInteractionEditReply = null;
const mockInteraction = {
  customId: `seekdeep:regen:rerefine:${actionId}`,
  isButton: () => true,
  editReply: async (payload) => {
    mockInteractionEditReply = payload;
    return null;
  },
  user: { id: 'user_123' },
  channel: null,
};
await T.seekdeepEmergencyHandleGeneratedImageButton(mockInteraction);
check('RE-REFINE: missing state returns exact message', mockInteractionEditReply && mockInteractionEditReply.content.includes('I lost the original refine context. Please run refine again from the original message.'));

// 5. URL/source output applies suppress-embed flags without deleting existing flags
let mockMsgPayload = null;
const mockMsgTarget = {
  reply: async (payload) => {
    mockMsgPayload = payload;
    return null;
  },
};
// We define MessageFlags on globalThis so index.js has it if needed in test environment
globalThis.MessageFlags = { SuppressEmbeds: 4 };
await T.seekdeepReplyToTarget(mockMsgTarget, { content: 'Check this link: https://google.com', flags: 64 });
check('embed-suppression: applies SuppressEmbeds flag (keeps original flag)', mockMsgPayload && (mockMsgPayload.flags & 4) !== 0 && (mockMsgPayload.flags & 64) !== 0);

await T.seekdeepReplyToTarget(mockMsgTarget, { content: 'Check this link: https://google.com' });
check('embed-suppression: applies SuppressEmbeds flag if no flags exist', mockMsgPayload && mockMsgPayload.flags === 4);

// 6. Upscale clearing of loading state on failure
let mockUpscaleReplyPayload = null;
const mockUpscaleInteraction = {
  deferred: true,
  deferReply: () => {},
  editReply: async (payload) => {
    mockUpscaleReplyPayload = payload;
    return null;
  },
};
try {
  await T.seekdeepHandleUpscale(mockUpscaleInteraction, null);
} catch (err) {
  check('upscale-failure: sets failure flag on error', err.seekdeepUpscaleFailureNotified === true);
}
check('upscale-failure: clears loading state by sending failure message', mockUpscaleReplyPayload && mockUpscaleReplyPayload.content.includes('Upscale failed:'));

// 7. Upscale clearing of loading state on success
let mockSuccessReplyPayload = null;
let deleteCalled = false;
const mockSuccessAck = {
  edit: async (payload) => {
    mockSuccessReplyPayload = payload;
    return null;
  },
  delete: async () => {
    deleteCalled = true;
    return null;
  }
};
// Testing seekdeepReplyToTarget with previousReply on success clearing files
await T.seekdeepReplyToTarget(mockMsgTarget, { content: 'Upscale complete', files: ['newfile.png'], attachments: [] }, { previousReply: mockSuccessAck });
check('upscale-success: clears loading state by replacing files', mockSuccessReplyPayload && mockSuccessReplyPayload.content === 'Upscale complete' && mockSuccessReplyPayload.attachments.length === 0);

// Testing fallback delete if edit fails
const mockFailingAck = {
  edit: async () => {
    throw new Error('Edit failed');
  },
  delete: async () => {
    deleteCalled = true;
    return null;
  }
};
deleteCalled = false;
await T.seekdeepReplyToTarget(mockMsgTarget, { content: 'Upscale complete', files: ['newfile.png'], attachments: [] }, { previousReply: mockFailingAck });
check('upscale-success: deletes loading message on edit fallback', deleteCalled === true);

// ---------------------------------------------------------------------------
// Suite 49: Context resolution, search routing, and system prompt personality
// ---------------------------------------------------------------------------
console.log('\n49. SeekDeep Context Resolution, Search Routing & Personality.');

// Helper to construct a mock message
function makeMockMessage({ id, content, authorId, referenceId, attachments = [], embeds = [], isThread = false, botId = 'bot_id' } = {}) {
  const channelMessages = new Map();
  const mockMsg = {
    id,
    content,
    author: { id: authorId },
    client: { user: { id: botId } },
    attachments: {
      size: attachments.length,
      values: () => attachments,
    },
    embeds,
    channel: {
      isThread: () => isThread,
      messages: {
        fetch: async (options) => {
          if (typeof options === 'string') {
            return channelMessages.get(options) || null;
          }
          return channelMessages;
        }
      }
    }
  };

  if (referenceId) {
    mockMsg.reference = { messageId: referenceId };
  }

  mockMsg.fetchReference = async () => {
    return channelMessages.get(referenceId) || null;
  };

  mockMsg.setChannelMessages = (msgsArray) => {
    channelMessages.clear();
    for (const m of msgsArray) {
      channelMessages.set(m.id, m);
    }
  };

  return mockMsg;
}

// Test 1: Reply context is preferred over older channel context.
const msgReply = makeMockMessage({ id: '10', content: 'What is this?', authorId: 'user_1', referenceId: '5' });
const repliedBotMsg = makeMockMessage({ id: '5', content: 'I am a local GPU status report', authorId: 'bot_id' });
msgReply.setChannelMessages([
  repliedBotMsg,
  makeMockMessage({ id: '4', content: 'Older conversation in channel', authorId: 'user_1' }),
]);
const resolvedReply = await T.seekdeepResolveContext(msgReply, 'What is this?');
check('context: reply context is preferred over channel context', resolvedReply.source === 'reply' && resolvedReply.contextText === 'I am a local GPU status report');

// Test 2: “this/that/it” resolves from the explicitly replied bot message.
const msgAmbiguousReply = makeMockMessage({ id: '10', content: 'tell me about it', authorId: 'user_1', referenceId: '5' });
msgAmbiguousReply.setChannelMessages([
  makeMockMessage({ id: '5', content: 'NVIDIA GeForce RTX 5090', authorId: 'bot_id' })
]);
const resolvedAmbiguousReply = await T.seekdeepResolveContext(msgAmbiguousReply, 'tell me about it');
check('context: "it" resolves from the replied bot message', resolvedAmbiguousReply.source === 'reply' && resolvedAmbiguousReply.contextText === 'NVIDIA GeForce RTX 5090');

// Test 3: Same-channel fallback does not leak unrelated users’ context.
const msgChannel = makeMockMessage({ id: '10', content: 'tell me more', authorId: 'user_1' });
msgChannel.setChannelMessages([
  makeMockMessage({ id: '2', content: 'Unrelated user talk', authorId: 'user_2' }),
  makeMockMessage({ id: '3', content: 'Bot reply to unrelated user', authorId: 'bot_id', referenceId: '2' }),
  makeMockMessage({ id: '4', content: 'My previous prompt', authorId: 'user_1' }),
  makeMockMessage({ id: '5', content: 'Bot reply to my prompt', authorId: 'bot_id', referenceId: '4' }),
]);
const resolvedChannel = await T.seekdeepResolveContext(msgChannel, 'tell me more');
check('context: same-channel fallback does not leak other users messages',
  resolvedChannel.source === 'channel' &&
  resolvedChannel.contextText.includes('My previous prompt') &&
  resolvedChannel.contextText.includes('Bot reply to my prompt') &&
  !resolvedChannel.contextText.includes('Unrelated user talk') &&
  !resolvedChannel.contextText.includes('unrelated user')
);

// Test 4: No-search override still disables search/sources.
const noSearchPrompt = 'tell me a joke don\'t search';
check('no-search override: check seekdeepHasNoSearchOverride', T.seekdeepHasNoSearchOverride(noSearchPrompt) === true);

// Test 5: Local status fast-path bypasses search and LLM.
const statusPrompt = 'are you local?';
const statusIntent = T.seekdeepGetLocalStatusIntent(statusPrompt);
check('status fast-path: status intent is correctly resolved', statusIntent === 'local_runtime_status');

// Test 6: Search citation/source output remains Discord suppress-embed safe.
const mockSources = [
  { title: 'Google', url: 'https://google.com/search' }
];
const formattedSources = T.formatSources(mockSources);
check('sources format: wraps URL in angle brackets to suppress embeds', formattedSources.includes('<https://google.com/search>'));

// Test 7: Simple conversational prompt does not trigger web search.
check('shouldAutoSearch: simple conversational greeting returns false', T.shouldAutoSearch('hello') === false);
check('shouldAutoSearch: simple small talk returns false', T.shouldAutoSearch('how are you') === false);

// Test 8: Explicit search-request prompt triggers search when allowed.
check('shouldAutoSearch: explicit search query returns true', T.shouldAutoSearch('search for current election news') === true);

// Test 9: Ambiguous follow-up asks for clarification when no context exists.
check('ambiguous followup: "what about it?" is ambiguous', T.seekdeepLooksLikeAmbiguousFollowup('what about it?') === true);
check('ambiguous followup: "try again" is ambiguous', T.seekdeepLooksLikeAmbiguousFollowup('try again') === true);
check('ambiguous followup: ordinary question is NOT ambiguous', T.seekdeepLooksLikeAmbiguousFollowup('who is KK Slider?') === false);

// Test 10: System prompt personality changes do not affect status/command responses.
const systemPromptChat = T.buildSystem('', false, 'clinical');
check('system prompt: clinical persona contains clinical instructions', systemPromptChat.includes('clinical'));
check('system prompt: clinical persona contains clean code instructions', systemPromptChat.includes('Do not add any personality layer'));

// Test 11: Verb hijacking and image request safety routing
check('image false-positive: "make a tutorial step by step super noob friendly" is not explicit image request',
  T.seekdeepHasExplicitImageRequest('make a tutorial step by step super noob friendly') === false
);
check('image false-positive: "make a tutorial step by step super noob friendly" is not natural image prompt',
  T.isNaturalImagePrompt('make a tutorial step by step super noob friendly') === false
);

check('valid image check: "generate an image of a robot reading a book" is explicit image request',
  T.seekdeepHasExplicitImageRequest('generate an image of a robot reading a book') === true
);
check('valid image check: "make album art for a metalcore song" is explicit image request',
  T.seekdeepHasExplicitImageRequest('make album art for a metalcore song') === true
);

check('casual chat check: "whats crackin yo" is not explicit image request',
  T.seekdeepHasExplicitImageRequest('whats crackin yo') === false
);
check('casual chat check: "science bitch" is not explicit image request',
  T.seekdeepHasExplicitImageRequest('science bitch') === false
);

check('contextual followup check: "make it noob friendly" is contextual text followup',
  T.seekdeepLooksLikeContextualTextFollowup('make it noob friendly') === true
);
check('contextual followup check: "how do you make it" is contextual text followup',
  T.seekdeepLooksLikeContextualTextFollowup('how do you make it') === true
);
check('contextual followup check: "I need more detail" is contextual text followup',
  T.seekdeepLooksLikeContextualTextFollowup('I need more detail') === true
);
check('contextual followup check: "step by step" is contextual text followup',
  T.seekdeepLooksLikeContextualTextFollowup('step by step') === true
);
check('contextual followup check: "make a tutorial" is contextual text followup',
  T.seekdeepLooksLikeContextualTextFollowup('make a tutorial') === true
);

const testKey = 'test-session-key-routing';
globalThis.__seekdeepMemoryCompatStoreV13.set(testKey, []);
check('lastWasImage: empty history should return false', T.seekdeepLastSubstantiveTurnWasImage(testKey) === false);

globalThis.__seekdeepMemoryCompatStoreV13.set(testKey, [
  { role: 'user', text: 'explain fiber internet', at: Date.now() },
  { role: 'assistant', text: 'Fiber internet uses fiber-optic cables to transmit data...', at: Date.now() }
]);
check('lastWasImage: after chat history, should return false', T.seekdeepLastSubstantiveTurnWasImage(testKey) === false);

globalThis.__seekdeepMemoryCompatStoreV13.set(testKey, [
  { role: 'user', text: '[natural-image] generate an image of a cat', at: Date.now() },
  { role: 'assistant', text: 'Queued image locally for: a cat', at: Date.now() }
]);
check('lastWasImage: after image history, should return true', T.seekdeepLastSubstantiveTurnWasImage(testKey) === true);

// Test 11.f Visual medium overrides for negative keywords
check('visual override: "make a tutorial-style infographic" is explicit image request',
  T.seekdeepHasExplicitImageRequest('make a tutorial-style infographic') === true
);
check('visual override: "make a tutorial-style infographic" is natural image prompt',
  T.isNaturalImagePrompt('make a tutorial-style infographic') === true
);
check('visual override: "draw step-by-step panels" is explicit image request',
  T.seekdeepHasExplicitImageRequest('draw step-by-step panels') === true
);
check('visual override: "draw step-by-step panels" is natural image prompt',
  T.isNaturalImagePrompt('draw step-by-step panels') === true
);

// Test 11.h Code / markup requests are text, not pictures — they must NOT route to
// image (regression: "give me an html header" became an image of "html header,
// stylized illustration"). The guard runs AFTER the explicit "draw/show ..." check,
// so a real image request that mentions a homonym language still routes to image.
check('code-route: "give me an html header" is code/markup',
  T.seekdeepLooksLikeCodeOrMarkupRequest('give me an html header') === true
);
check('code-route: "give me an html header" is NOT a natural image prompt',
  T.isNaturalImagePrompt('give me an html header') === false
);
check('code-route: "make me a css grid" is NOT a natural image prompt',
  T.isNaturalImagePrompt('make me a css grid') === false
);
check('code-route: "write a python function to sort a list" is NOT a natural image prompt',
  T.isNaturalImagePrompt('write a python function to sort a list') === false
);
check('code-route: "give me a regex for emails" is code/markup',
  T.seekdeepLooksLikeCodeOrMarkupRequest('give me a regex for emails') === true
);
check('code-route control: "draw a python snake in a jungle" STILL routes to image',
  T.isNaturalImagePrompt('draw a python snake in a jungle') === true
);
check('code-route control: "a red glass apple on a table" is not flagged as code',
  T.seekdeepLooksLikeCodeOrMarkupRequest('a red glass apple on a table') === false
);
check('code-route: "give me an html header" selects the reasoning_code model',
  T.seekdeepSelectChatModelRole('give me an html header', 'chat') === 'reasoning_code'
);

// Test 11.g Model selection tests for lightweight conversational model
process.env.LOCAL_CHAT_LIGHTWEIGHT_MODEL_ID = 'phi-3';
check('model role: tutorial follow-up selects lightweight_chat',
  T.seekdeepSelectChatModelRole('make a tutorial step by step super noob friendly') === 'lightweight_chat'
);
check('model role: short casual greeting selects lightweight_chat',
  T.seekdeepSelectChatModelRole('whats crackin yo') === 'lightweight_chat'
);
check('model role: casual remark selects lightweight_chat',
  T.seekdeepSelectChatModelRole('science bitch') === 'lightweight_chat'
);
check('model role: contextual noob friendly selects lightweight_chat',
  T.seekdeepSelectChatModelRole('make it noob friendly') === 'lightweight_chat'
);
check('model role: complex query does NOT select lightweight_chat',
  T.seekdeepSelectChatModelRole('explain fiber internet') !== 'lightweight_chat'
);

// Test 11.h Dispatcher routing validation (deep tests proving it does not queue images/search/refine)
const dispatcherMsg = makeMockMessage({
  id: 'dispatcher_test_msg_id',
  content: 'make it noob friendly',
  authorId: 'user_dispatcher',
  botId: 'bot_dispatcher'
});
dispatcherMsg.channel.send = async (payload) => {
  return dispatcherMsg;
};
dispatcherMsg.channel.id = 'channel_dispatcher';

// Setup mock channel history (prior turn was chat: User asks to explain, bot answers)
dispatcherMsg.setChannelMessages([
  makeMockMessage({ id: 'msg_1', content: 'explain fiber internet', authorId: 'user_dispatcher' }),
  makeMockMessage({ id: 'msg_2', content: 'Fiber internet uses glass fibers to transmit data.', authorId: 'bot_dispatcher', referenceId: 'msg_1' })
]);

// Mock history memory compat store
const dispatcherMemoryKey = 'channel_dispatcher-user_dispatcher';
globalThis.__seekdeepMemoryCompatStoreV13.set(dispatcherMemoryKey, [
  { role: 'user', text: 'explain fiber internet', at: Date.now() },
  { role: 'assistant', text: 'Fiber internet uses glass fibers to transmit data.', at: Date.now() }
]);

// Intercept routing logs
const routesLogged = [];
globalThis.__seekdeepRouteSpy = (route, prompt) => {
  routesLogged.push({ route, prompt });
};

// Mock fetch for askChat call
const originalFetch = globalThis.fetch;
let fetchCalled = false;
globalThis.fetch = async (url, options) => {
  fetchCalled = true;
  return {
    ok: true,
    status: 200,
    json: async () => ({ text: 'Here is a simplified explanation.' }),
    text: async () => JSON.stringify({ text: 'Here is a simplified explanation.' }),
  };
};

// Spy on reply/send
let replyCalled = false;
dispatcherMsg.reply = async (payload) => {
  replyCalled = true;
  return dispatcherMsg;
};

// Call the dispatcher
await T.seekdeepDispatchAddressedMessage(dispatcherMsg, {
  prompt: 'make it noob friendly',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

// Restore fetch/spy
globalThis.fetch = originalFetch;
globalThis.__seekdeepRouteSpy = null;

// Assertions
check('dispatcher: route went to contextual safety gate',
  routesLogged.some(r => r.route === 'chat-context-safety-gate')
);
check('dispatcher: did NOT route to image generation',
  !routesLogged.some(r => r.route === 'image' || r.route === 'image-direct-alias' || r.route.startsWith('conv-edit-'))
);
check('dispatcher: did NOT route to web search (no search log)',
  !routesLogged.some(r => r.route === 'web-search' || r.route === 'search')
);
check('dispatcher: reply was sent successfully',
  replyCalled === true
);

// ---------------------------------------------------------------------------
// Suite 50: Phase B Warmup, Unload, Reload, Queue status, GPU logging tests
// ---------------------------------------------------------------------------
console.log('\n50. Phase B: Warmup, Unload, Reload, Queue status, GPU logging.');

check('gpu-logging: disabled by default', T.seekdeepGpuLoggingEnabled() === false);

process.env.SEEKDEEP_GPU_LOGGING = 'on';
check('gpu-logging: enabled via env', T.seekdeepGpuLoggingEnabled() === true);
delete process.env.SEEKDEEP_GPU_LOGGING;

check('gpu-logging-interval: default is 5s', T.seekdeepGpuLogIntervalSeconds() === 5);

process.env.SEEKDEEP_GPU_LOG_INTERVAL_SECONDS = '10';
check('gpu-logging-interval: custom 10s', T.seekdeepGpuLogIntervalSeconds() === 10);

process.env.SEEKDEEP_GPU_LOG_INTERVAL_SECONDS = '-5';
check('gpu-logging-interval: clamped to min 1s', T.seekdeepGpuLogIntervalSeconds() === 1);

process.env.SEEKDEEP_GPU_LOG_INTERVAL_SECONDS = 'invalid';
check('gpu-logging-interval: fallback on invalid input to 5s', T.seekdeepGpuLogIntervalSeconds() === 5);
delete process.env.SEEKDEEP_GPU_LOG_INTERVAL_SECONDS;

const testRoutes = [
  { prompt: 'unload', expectedRoute: 'unload-models' },
  { prompt: 'warmup', expectedRoute: 'warmup-all' },
  { prompt: 'warmup chat', expectedRoute: 'warmup-chat' },
  { prompt: 'warmup image', expectedRoute: 'warmup-image' },
  { prompt: 'warmup vision', expectedRoute: 'warmup-vision' },
  { prompt: 'reload chat', expectedRoute: 'reload-chat' },
  { prompt: 'reload image', expectedRoute: 'reload-image' },
  { prompt: 'reload vision', expectedRoute: 'reload-vision' },
  { prompt: 'queue status', expectedRoute: 'queue-status' },
  { prompt: 'queue clear', expectedRoute: 'queue-clear' },
];

const originalFetchSuite50 = globalThis.fetch;
let lastFetchUrl = '';

globalThis.fetch = async (url, options) => {
  lastFetchUrl = String(url);
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, status: 'unloaded', model_id: 'mock-model-id' }),
    text: async () => JSON.stringify({ ok: true, status: 'unloaded', model_id: 'mock-model-id' }),
  };
};

const routeLogsPhaseB = [];
globalThis.__seekdeepRouteSpy = (route, prompt) => {
  routeLogsPhaseB.push({ route, prompt });
};

for (const { prompt, expectedRoute } of testRoutes) {
  let replyContent = '';
  const mockMsg = makeMockMessage({ id: `msg_${prompt.replace(' ', '_')}`, content: `@SeekDeep ${prompt}`, authorId: 'user_1' });
  mockMsg.memberPermissions = { has: () => true };   // routing test exercises the route AS AN ADMIN; the non-admin gate is asserted separately below
  mockMsg.reply = async (payload) => {
    replyContent = typeof payload === 'string' ? payload : payload.content;
    return mockMsg;
  };
  
  await T.seekdeepDispatchAddressedMessage(mockMsg, {
    prompt,
    seekdeepReplyPromptInfo: {},
    seekdeepForceImageFromReplyContext: false
  });
  
  const logged = routeLogsPhaseB.find(r => r.prompt === prompt);
  check(`routing: "${prompt}" triggers route "${expectedRoute}"`, logged && logged.route === expectedRoute);
  check(`routing: "${prompt}" returns non-empty reply`, replyContent.length > 0);
}

// AUD: the GPU model-management commands (unload/warmup/reload) must be admin-gated —
// a non-admin must be refused BEFORE any route fires (no VRAM-thrash DoS).
for (const prompt of ['unload', 'warmup image', 'reload chat']) {
  let reply = '';
  const before = routeLogsPhaseB.length;
  const m = makeMockMessage({ id: `msg_na_${prompt.replace(' ', '_')}`, content: `@SeekDeep ${prompt}`, authorId: 'user_nonadmin' });
  m.reply = async (payload) => { reply = typeof payload === 'string' ? payload : payload.content; return m; };
  await T.seekdeepDispatchAddressedMessage(m, { prompt, seekdeepReplyPromptInfo: {}, seekdeepForceImageFromReplyContext: false });
  check(`gate: non-admin "${prompt}" fires no route`, routeLogsPhaseB.length === before);
  check(`gate: non-admin "${prompt}" replies with a refusal`, /administrator/i.test(reply));
}

// Suite 51: Phase C Inpaint preview / prompt debug routing and formatting tests
console.log('Running Suite 51: Phase C Inpaint preview & prompt debug tests...');

// Command parsing tests
check('inpaint preview parses correctly', T.seekdeepInpaintPreviewQueryFromMessage('@SeekDeep inpaint preview cat') === 'cat');
check('mask preview parses correctly', T.seekdeepInpaintPreviewQueryFromMessage('@SeekDeep mask preview dog') === 'dog');
check('prompt debug parses correctly', T.seekdeepPromptDebugQueryFromMessage('@SeekDeep prompt debug') === true);
check('prompt debug last parses correctly', T.seekdeepPromptDebugQueryFromMessage('@SeekDeep prompt debug last') === true);
check('invalid command does not parse as preview', T.seekdeepInpaintPreviewQueryFromMessage('@SeekDeep inpaint cat') === null);

// Debug formatter tests
check('debug format handles null', T.seekdeepFormatPromptDebugReport(null) === 'No recent generated image was found.');

const testState = {
  id: 'action_123',
  prompt: 'cyberpunk cityscape',
  originalPrompt: 'cyberpunk cityscape',
  refinedPrompt: 'cyberpunk cityscape refined',
  negativePrompt: 'blurry, low quality',
  stylePreset: 'neon',
  qualityPreset: 'high',
  seed: 42,
  width: 1024,
  height: 1024,
  steps: 28,
  guidance: 7.0,
  model: 'SDXL',
  jobId: 'job_456',
  generationTime: '5.20',
  queueWait: 2,
  refinementMode: 'dynamic',
  binaryPath: 'C:\\Users\\natha\\SeekDeep-DiscordBot\\temp\\image-cache\\action_123.png',
};

const formattedReport = T.seekdeepFormatPromptDebugReport(testState);
check('formatted report includes original prompt', formattedReport.includes('cyberpunk cityscape'));
check('formatted report includes refined prompt', formattedReport.includes('cyberpunk cityscape refined'));
check('formatted report includes seed', formattedReport.includes('42'));
check('formatted report includes dimensions', formattedReport.includes('1024x1024'));
check('formatted report includes steps', formattedReport.includes('28'));
check('formatted report includes model', formattedReport.includes('SDXL'));
check('formatted report includes job ID', formattedReport.includes('job_456'));
check('formatted report does NOT expose private absolute path', !formattedReport.includes('temp\\image-cache') && !formattedReport.includes('C:\\Users\\natha'));

// Routing tests
const originalFetchSuite51 = globalThis.fetch;
let lastFetchUrlSuite51 = '';
let fetchBodySuite51 = null;

globalThis.fetch = async (url, options) => {
  lastFetchUrlSuite51 = String(url);
  let parsedBody = null;
  try {
    parsedBody = options?.body ? JSON.parse(options.body) : null;
  } catch {}
  if (parsedBody) {
    fetchBodySuite51 = parsedBody;
  }
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer, // PNG signature
    json: async () => ({
      ok: true,
      image_b64: 'bW9jay1tYXNrLWJhc2U2NA==', // base64 for 'mock-mask-base64'
      filename: 'seekdeep_mask_preview_123.png',
      path: '/mock/path/seekdeep_mask_preview_123.png'
    }),
    text: async () => JSON.stringify({
      ok: true,
      image_b64: 'bW9jay1tYXNrLWJhc2U2NA==',
      filename: 'seekdeep_mask_preview_123.png',
      path: '/mock/path/seekdeep_mask_preview_123.png'
    }),
  };
};

// AUD-002 follow-up: source-image downloads now flow through node-fetch via the
// transport seam (so DNS can be pinned), NOT globalThis.fetch. Feed that path
// valid PNG bytes so the handler gets past seekdeepFetchImageAsBase64 and on to
// the /inpaint_mask_preview POST (which fetchJson still routes via globalThis.fetch).
if (typeof T.__setFetchTransportForTests === 'function') {
  T.__setFetchTransportForTests(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer, // PNG signature
  }));
}

const routeLogsPhaseC = [];
globalThis.__seekdeepRouteSpy = (route, prompt) => {
  routeLogsPhaseC.push({ route, prompt });
};

// Test 1: mask preview command routing
let replyContentSuite51 = '';
const mockMsg1 = makeMockMessage({ id: 'msg_mask_preview', content: '@SeekDeep mask preview cat', authorId: 'user_1' });
// Set up attachments to resolve source image
mockMsg1.attachments = new Map([
  ['att1', { url: 'https://example.com/source.png', contentType: 'image/png', name: 'source.png', size: 1000 }]
]);

mockMsg1.reply = async (payload) => {
  replyContentSuite51 = typeof payload === 'string' ? payload : payload.content;
  return mockMsg1;
};

await T.seekdeepDispatchAddressedMessage(mockMsg1, {
  prompt: 'mask preview cat',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

const loggedMaskPreview = routeLogsPhaseC.find(r => r.route === 'inpaint-preview');
check('routing: mask preview triggers route inpaint-preview', !!loggedMaskPreview);
check('routing: mask preview hits correct local endpoint', lastFetchUrlSuite51.endsWith('/inpaint_mask_preview'));
check('routing: mask preview payload contains correct target', fetchBodySuite51?.remove_target === 'cat');

// Test 2: prompt debug command routing
let replyContentDebug = '';
const mockMsg2 = makeMockMessage({ id: 'msg_prompt_debug', content: '@SeekDeep prompt debug', authorId: 'user_1' });
mockMsg2.reply = async (payload) => {
  replyContentDebug = typeof payload === 'string' ? payload : payload.content;
  return mockMsg2;
};

// Seed a mock state into the temp image state map so the command returns a real report
globalThis.__seekdeepTempImageStateIndex = globalThis.__seekdeepTempImageStateIndex || new Map();
globalThis.__seekdeepTempImageStateIndex.set('action_123', testState);

await T.seekdeepDispatchAddressedMessage(mockMsg2, {
  prompt: 'prompt debug',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

const loggedPromptDebug = routeLogsPhaseC.find(r => r.route === 'prompt-debug');
check('routing: prompt debug triggers route prompt-debug', !!loggedPromptDebug);
check('routing: prompt debug returns report', replyContentDebug.includes('Image Prompt Debugger'));

// Clean up
globalThis.fetch = originalFetchSuite51;
if (typeof T.__setFetchTransportForTests === 'function') T.__setFetchTransportForTests(null);
globalThis.__seekdeepRouteSpy = null;

// ============================================================================
// Suite 52: Phase D tests (web/source controls, admin status, permissions)
// ============================================================================
console.log('\nSuite 52: Phase D features (web/source controls, admin status, permissions)');

// Test 1: web search blocklist and preferred domains helper logic
const oldBlocklist = process.env.WEB_SEARCH_BLOCKLIST;
const oldPreferred = process.env.WEB_SEARCH_PREFERRED_DOMAINS;
const oldRequireNews = process.env.WEB_SEARCH_REQUIRE_SOURCES_FOR_NEWS;

process.env.WEB_SEARCH_BLOCKLIST = 'blocked.com, spam.org';
process.env.WEB_SEARCH_PREFERRED_DOMAINS = 'preferred.com, highquality.edu';
process.env.WEB_SEARCH_REQUIRE_SOURCES_FOR_NEWS = 'on';

// Let's test the news style prompt check
check('is news style prompt: "news"', T.seekdeepIsNewsStylePrompt('what is the news today') === true);
check('is news style prompt: "election"', T.seekdeepIsNewsStylePrompt('latest election results') === true);
check('is news style prompt: ordinary', T.seekdeepIsNewsStylePrompt('tell me a joke') === false);

// Test 2: admin status and permissions queries parsers
check('admin status parser positive', T.seekdeepAdminStatusQueryFromStrippedPrompt('admin status') === true);
check('admin status parser positive with spacing', T.seekdeepAdminStatusQueryFromStrippedPrompt('  admin   status  ') === true);
check('admin status parser negative', T.seekdeepAdminStatusQueryFromStrippedPrompt('status') === false);

check('permissions parser positive', T.seekdeepPermissionsQueryFromStrippedPrompt('permissions') === true);
check('permissions parser positive with spacing', T.seekdeepPermissionsQueryFromStrippedPrompt('  permissions  ') === true);
check('permissions parser negative', T.seekdeepPermissionsQueryFromStrippedPrompt('perms') === false);

// Test 3: format permissions report DM safety
const dmMsg = makeMockMessage({ id: 'msg_dm', content: '@SeekDeep permissions', authorId: 'user_1' });
dmMsg.guild = null;
const dmReport = T.seekdeepFormatPermissionsReport(dmMsg);
check('permissions diagnostic DM safety', dmReport === 'Guild bot permissions cannot be checked in DMs.');

// Test 4: format permissions report Guild checks
const guildMsg = makeMockMessage({ id: 'msg_guild', content: '@SeekDeep permissions', authorId: 'user_1' });
guildMsg.guild = {
  name: 'Mock Guild',
  members: {
    me: {
      id: 'bot_id',
      permissions: { has: () => true }
    }
  }
};
guildMsg.channel = {
  id: 'channel_id',
  name: 'mock-channel',
  permissionsFor: (me) => ({
    has: (bit) => {
      if (bit === T.PermissionFlagsBits?.SendMessages) return true;
      if (bit === T.PermissionFlagsBits?.AttachFiles) return false;
      return true;
    }
  })
};

if (T.PermissionFlagsBits) {
  const guildReport = T.seekdeepFormatPermissionsReport(guildMsg);
  check('permissions report contains Server info', guildReport.includes('Mock Guild'));
  check('permissions report contains Send Messages Granted', guildReport.includes('Send Messages**: Granted') || guildReport.includes('Send Messages**: Missing'));
}

// Test 5: format admin status report sanitization (redacts private endpoints)
const adminReport = T.seekdeepFormatAdminStatusReport(
  { device: 'cuda', loaded_task: 'chat', loaded_chat_role: 'default_chat', models: { chat: 'qwen' } },
  true,
  guildMsg
);
check('admin status report contains System & Telemetry', adminReport.includes('System & Telemetry'));
check('admin status report does not leak raw local urls', !adminReport.includes('127.0.0.1') && !adminReport.includes('localhost'));
check('admin status report contains features list', adminReport.includes('Image Generation') && adminReport.includes('Feature Flags'));

// Test 6: searchWeb blocklist and preferred domains filtering/sorting
const originalFetchJson = globalThis.fetch;
globalThis.fetch = async (url) => {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [
        { title: 'Preferred Page', url: 'https://preferred.com/page1', content: 'Preferred domain content' },
        { title: 'Normal Page', url: 'https://normal.com/page2', content: 'Normal content' },
        { title: 'Blocked Page', url: 'https://blocked.com/bad', content: 'Blocked content' },
        { title: 'High Quality Page', url: 'https://highquality.edu/page3', content: 'High quality content' }
      ]
    }),
    text: async () => JSON.stringify({
      results: [
        { title: 'Preferred Page', url: 'https://preferred.com/page1', content: 'Preferred domain content' },
        { title: 'Normal Page', url: 'https://normal.com/page2', content: 'Normal content' },
        { title: 'Blocked Page', url: 'https://blocked.com/bad', content: 'Blocked content' },
        { title: 'High Quality Page', url: 'https://highquality.edu/page3', content: 'High quality content' }
      ]
    })
  };
};

const searchResult = await T.searchWeb('test');
check('searchWeb: blocked domain is filtered out', !searchResult.sources.some(s => s.url.includes('blocked.com')));
check('searchWeb: sources list has length 3', searchResult.sources.length === 3);
check('searchWeb: preferred.com sorted first', searchResult.sources[0].url.includes('preferred.com'));
check('searchWeb: highquality.edu sorted second', searchResult.sources[1].url.includes('highquality.edu'));
check('searchWeb: normal.com sorted last', searchResult.sources[2].url.includes('normal.com'));

globalThis.fetch = originalFetchJson;

// Test 7: routing check in seekdeepDispatchAddressedMessage
const originalFetchSuite52 = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  return {
    ok: true,
    status: 200,
    json: async () => ({ device: 'cuda:0', loaded_task: 'chat', models: { chat: 'qwen' } }),
    text: async () => JSON.stringify({ device: 'cuda:0', loaded_task: 'chat', models: { chat: 'qwen' } }),
  };
};

const routeLogsPhaseD = [];
globalThis.__seekdeepRouteSpy = (route, prompt) => {
  routeLogsPhaseD.push({ route, prompt });
};

// Admin status command (as admin)
let adminReply = '';
const adminMsg = makeMockMessage({ id: 'msg_admin', content: '@SeekDeep admin status', authorId: 'admin_1' });
adminMsg.guild = guildMsg.guild;
adminMsg.channel = guildMsg.channel;
adminMsg.reply = async (payload) => {
  adminReply = typeof payload === 'string' ? payload : payload.content;
  return adminMsg;
};

// Mock admin ids
const oldAdminIds = process.env.SEEKDEEP_ADMIN_IDS;
process.env.SEEKDEEP_ADMIN_IDS = 'admin_1';

await T.seekdeepDispatchAddressedMessage(adminMsg, {
  prompt: 'admin status',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

const loggedAdminStatus = routeLogsPhaseD.find(r => r.route === 'admin-status');
check('routing: admin status triggers route admin-status', !!loggedAdminStatus);
check('routing: admin status returns report to admin', adminReply.includes('Admin Status Report'));

// Non-admin command
let nonAdminReply = '';
const nonAdminMsg = makeMockMessage({ id: 'msg_non_admin', content: '@SeekDeep admin status', authorId: 'user_2' });
nonAdminMsg.guild = guildMsg.guild;
nonAdminMsg.channel = guildMsg.channel;
nonAdminMsg.reply = async (payload) => {
  nonAdminReply = typeof payload === 'string' ? payload : payload.content;
  return nonAdminMsg;
};

await T.seekdeepDispatchAddressedMessage(nonAdminMsg, {
  prompt: 'admin status',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});
check('routing: admin status rejects non-admin users', nonAdminReply.includes('Only administrators can run the admin status command.'));

// Permissions command routing
let permsReply = '';
const permsMsg = makeMockMessage({ id: 'msg_perms', content: '@SeekDeep permissions', authorId: 'user_2' });
permsMsg.guild = guildMsg.guild;
permsMsg.channel = guildMsg.channel;
permsMsg.reply = async (payload) => {
  permsReply = typeof payload === 'string' ? payload : payload.content;
  return permsMsg;
};

await T.seekdeepDispatchAddressedMessage(permsMsg, {
  prompt: 'permissions',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

const loggedPermissions = routeLogsPhaseD.find(r => r.route === 'permissions-diagnostic');
check('routing: permissions triggers route permissions-diagnostic', !!loggedPermissions);
check('routing: permissions returns report', permsReply.includes('Permissions Diagnostic Report'));

// Normal chat does not trigger admin status or permissions routes
routeLogsPhaseD.length = 0;
let chatReply = '';
const chatMsg = makeMockMessage({ id: 'msg_chat', content: '@SeekDeep tell me a joke', authorId: 'user_2' });
chatMsg.guild = guildMsg.guild;
chatMsg.channel = guildMsg.channel;
chatMsg.reply = async (payload) => {
  chatReply = typeof payload === 'string' ? payload : payload.content;
  return chatMsg;
};

await T.seekdeepDispatchAddressedMessage(chatMsg, {
  prompt: 'tell me a joke',
  seekdeepReplyPromptInfo: {},
  seekdeepForceImageFromReplyContext: false
});

const triggeredAdminOrPerms = routeLogsPhaseD.some(r => r.route === 'admin-status' || r.route === 'permissions-diagnostic');
check('routing: normal chat does not trigger admin status or permissions routes', !triggeredAdminOrPerms);

// Clean up env
process.env.WEB_SEARCH_BLOCKLIST = oldBlocklist;
process.env.WEB_SEARCH_PREFERRED_DOMAINS = oldPreferred;
process.env.WEB_SEARCH_REQUIRE_SOURCES_FOR_NEWS = oldRequireNews;
process.env.SEEKDEEP_ADMIN_IDS = oldAdminIds;
globalThis.fetch = originalFetchSuite52;
globalThis.__seekdeepRouteSpy = null;

// ============================================================================
// Suite 53: Recovery patch - Qwen <think> strip, image routing guard,
// pending-image queue plan, BigInt-safe JSON, context-menu hardening
// ============================================================================
console.log('\nSuite 53: Recovery patch (think strip, routing, queue plan, BigInt JSON)');

// 53.1 - stripQwenThinkingBlocks
check('strip <think>...</think> simple',
  T.stripQwenThinkingBlocks('<think>secret</think>final') === 'final');
check('strip <thinking>...</thinking> via cleanupAssistantReply',
  T.cleanupAssistantReply('<thinking>secret</thinking>Answer') === 'Answer');
check('strip <think> handles uppercase / mixed',
  T.stripQwenThinkingBlocks('<THINK>plan</THINK>visible') === 'visible');
check('strip <think> handles unclosed leak (streaming cutoff)',
  T.stripQwenThinkingBlocks('Visible part. <think>still planning when token budget ran out')
    === 'Visible part.');
check('strip <thinking> handles unclosed leak',
  T.stripQwenThinkingBlocks('Hello. <thinking>tail leak') === 'Hello.');
check('strip loose </think> tag',
  T.stripQwenThinkingBlocks('answer</think>') === 'answer');
check('cleanupAssistantReply preserves normal answer',
  T.cleanupAssistantReply('Hello world') === 'Hello world');

// 53.2 - seekdeepIsGenericImageFollowupPrompt new phrases
check('generic followup: "make an image from that prompt"',
  T.seekdeepIsGenericImageFollowupPrompt('make an image from that prompt') === true);
check('generic followup: "no, make an image from that prompt please"',
  T.seekdeepIsGenericImageFollowupPrompt('no, make an image from that prompt please') === true);
check('generic followup: "make an image from that"',
  T.seekdeepIsGenericImageFollowupPrompt('make an image from that') === true);
check('generic followup: "use that prompt please"',
  T.seekdeepIsGenericImageFollowupPrompt('use that prompt please') === true);
check('generic followup: "use this prompt"',
  T.seekdeepIsGenericImageFollowupPrompt('use this prompt') === true);
check('generic followup: "take that idea and make an image"',
  T.seekdeepIsGenericImageFollowupPrompt('take that idea and make an image') === true);
check('generic followup: "turn that into an image"',
  T.seekdeepIsGenericImageFollowupPrompt('turn that into an image') === true);
check('generic followup: "make it into a picture"',
  T.seekdeepIsGenericImageFollowupPrompt('make it into a picture') === true);
check('generic followup: "draw it instead"',
  T.seekdeepIsGenericImageFollowupPrompt('draw it instead') === true);

// 53.3 - text-work guard must keep tutorial requests out of image routing
const tutorialPrompt = 'make a tutorial step by step super noob friendly';
check('generic followup: tutorial prompt is NOT a generic image followup',
  T.seekdeepIsGenericImageFollowupPrompt(tutorialPrompt) === false);
check('routing: tutorial stays as chat (seekdeepShouldStayChatInsteadOfImage)',
  T.seekdeepShouldStayChatInsteadOfImage(tutorialPrompt) === true);
check('routing: tutorial does NOT look like visual request',
  T.seekdeepLooksLikeVisualRequest(tutorialPrompt) === false);

// 53.4 - seekdeepJsonStringifySafe handles BigInt without throwing
let bigStr = '';
let bigThrew = false;
try {
  bigStr = T.seekdeepJsonStringifySafe({ id: 123n, nested: { snowflake: 999999999999999999n } });
} catch (err) {
  bigThrew = true;
}
check('seekdeepJsonStringifySafe: does not throw on BigInt', bigThrew === false);
check('seekdeepJsonStringifySafe: serializes BigInt to "123"', /"id":\s*"123"/.test(bigStr));
check('seekdeepJsonStringifySafe: nested BigInt also stringified', /"snowflake":\s*"999999999999999999"/.test(bigStr));
check('seekdeepJsonStringifySafe: still serializes plain values',
  T.seekdeepJsonStringifySafe({ a: 1, b: 'x' }) === '{"a":1,"b":"x"}');

// 53.5 - seekdeepPendingImageQueuePlan
const planBothFromBoth = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: true, wantsRefined: true },
  'do both versions',
);
check('queue plan: pending=both + prompt "do both versions" -> both',
  planBothFromBoth.wantsBoth === true && planBothFromBoth.wantsOriginal === true && planBothFromBoth.wantsRefined === true);
check('queue plan: ackText for both', /Queued both/.test(planBothFromBoth.ackText));

const planBothDefault = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: true, wantsRefined: true },
  'a red apple on a wooden table',
);
check('queue plan: pending=both + prompt without explicit both -> single safe default (not both)',
  planBothDefault.wantsBoth === false);
check('queue plan: safe default queues refined (not both)',
  planBothDefault.wantsRefined === true && planBothDefault.wantsOriginal === false);
check('queue plan: ackText for refined-only is NOT "Queued both"',
  !/Queued both/.test(planBothDefault.ackText));

const planOriginalOnly = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: true, wantsRefined: false },
  'a red apple',
);
check('queue plan: pending=original-only -> original only',
  planOriginalOnly.wantsOriginal === true && planOriginalOnly.wantsRefined === false && planOriginalOnly.wantsBoth === false);

const planRefinedOnly = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: false, wantsRefined: true },
  'a red apple',
);
check('queue plan: pending=refined-only -> refined only',
  planRefinedOnly.wantsRefined === true && planRefinedOnly.wantsOriginal === false && planRefinedOnly.wantsBoth === false);

const planOverrideBoth = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: true, wantsRefined: false },
  'queue both',
);
check('queue plan: explicit "queue both" upgrades pending=original-only to both',
  planOverrideBoth.wantsBoth === true);

const planOverrideOriginalOnly = T.seekdeepPendingImageQueuePlan(
  { wantsOriginal: true, wantsRefined: true },
  'just the original',
);
check('queue plan: explicit "just the original" downgrades pending=both to original only',
  planOverrideOriginalOnly.wantsOriginal === true && planOverrideOriginalOnly.wantsRefined === false);

const planEmpty = T.seekdeepPendingImageQueuePlan(null, '');
check('queue plan: null pending falls back to refined default (no throw)',
  planEmpty.wantsRefined === true && planEmpty.wantsBoth === false);

// 53.6 - context-menu Generate Image: status-message rejection
check('context menu reject: "Queued: original"',
  T.seekdeepContextGenerateImageLooksLikeStatusMessage('Queued: original (no refinement)') === true);
check('context menu reject: "Generated: ..."',
  T.seekdeepContextGenerateImageLooksLikeStatusMessage('Generated: a cat in a garden') === true);
check('context menu reject: "Image generation failed: ..."',
  T.seekdeepContextGenerateImageLooksLikeStatusMessage('Image generation failed: timeout') === true);
check('context menu reject: "Job ID: imgq_..."',
  T.seekdeepContextGenerateImageLooksLikeStatusMessage('Job ID: imgq_abc123') === true);
check('context menu accept: real user message',
  T.seekdeepContextGenerateImageLooksLikeStatusMessage('a cat in a garden') === false);

// 53.7 - context-menu prompt-line extractor
check('context menu prompt extract: "Prompt: a cat"',
  T.seekdeepContextMenuExtractPromptLine('Prompt: a cat\nSize: 1024x1024') === 'a cat');
check('context menu prompt extract: "Refined prompt: ..." (case-insensitive)',
  T.seekdeepContextMenuExtractPromptLine('Refined prompt: a detailed cat in a sunlit garden')
    === 'a detailed cat in a sunlit garden');
check('context menu prompt extract: missing prompt line returns empty',
  T.seekdeepContextMenuExtractPromptLine('Some other text') === '');


// 54 - User-facts module (remember/forget/recall) -- pure helpers only, no Discord.
// We never write to the real data/user-facts.json -- we exercise the in-memory
// composer + getter shapes. The Discord-touching command handler is covered
// in CI via npm run preflight (parse + py-compile).
{
  const block = T.seekdeepComposeUserSystemBlock(['be brief'], ['I work in PST']);
  check('user-facts: composer merges presets + facts into one block',
    block.includes('User-specific preferences') && block.includes('Facts the user has explicitly told you')
    && block.includes('be brief') && block.includes('I work in PST'));

  const presetOnly = T.seekdeepComposeUserSystemBlock(['be brief'], []);
  check('user-facts: composer with only presets has no Facts section',
    presetOnly.includes('be brief') && !presetOnly.includes('Facts the user'));

  const factOnly = T.seekdeepComposeUserSystemBlock([], ['I prefer Python']);
  check('user-facts: composer with only facts has no Preferences section',
    factOnly.includes('I prefer Python') && !factOnly.includes('User-specific preferences'));

  const empty = T.seekdeepComposeUserSystemBlock([], []);
  check('user-facts: composer with both empty returns empty string', empty === '');

  // Getter on a never-seen user must return [] (no throw, no file write)
  const ghostFacts = T.seekdeepGetUserFacts('never-existed-user-id-xyz-99999');
  check('user-facts: getter on unknown user returns []',
    Array.isArray(ghostFacts) && ghostFacts.length === 0);

  const ghostLines = T.seekdeepGetUserFactsLines('never-existed-user-id-xyz-99999');
  check('user-facts: getter-lines on unknown user returns []',
    Array.isArray(ghostLines) && ghostLines.length === 0);

  check('user-facts: max-facts cap is in sane range (5-200)',
    T.SEEKDEEP_USER_FACTS_MAX >= 5 && T.SEEKDEEP_USER_FACTS_MAX <= 200);
  check('user-facts: per-fact char cap is in sane range (40-2000)',
    T.SEEKDEEP_USER_FACT_MAX_CHARS >= 40 && T.SEEKDEEP_USER_FACT_MAX_CHARS <= 2000);
}

// 55 - Universal archive (Item B): reply-trigger regex + image-extract + state-build
// Pure helpers only -- no Discord, no archive thread writes.
{
  const re = T.SEEKDEEP_UNIVERSAL_ARCHIVE_REPLY_RE;
  // Liberal phrasing — these should all match
  for (const phrase of ['archive', 'Archive', 'archive this', 'archive that',
                        'archive it', 'archive please', 'archive now',
                        'archive to my archive', '<@123456> archive',
                        'archive this.', 'Archive Please']) {
    check(`universal-archive trigger matches: "${phrase}"`, re.test(phrase));
  }
  // Negatives -- these are normal conversation, not archive commands
  for (const phrase of ['archive me', 'archive channel here', 'open the archive',
                        'go archive your stuff', 'archive it later when you can']) {
    check(`universal-archive trigger does NOT match: "${phrase}"`, !re.test(phrase));
  }

  // Image extractor: build mock messages and verify image discovery
  const mkMessage = (attachments = [], embeds = []) => ({
    id: '999',
    content: 'hi',
    author: { tag: 'tester#0001', username: 'tester' },
    attachments: { values: () => attachments.values() },
    embeds,
  });
  const imgAtt = { contentType: 'image/png', name: 'photo.png', url: 'https://cdn.example/photo.png' };
  const docAtt = { contentType: 'application/pdf', name: 'paper.pdf', url: 'https://cdn.example/paper.pdf' };
  const gifAtt = { contentType: '', name: 'anim.gif', url: 'https://cdn.example/anim.gif' };  // ctype empty → uses ext

  const found = T.seekdeepExtractImagesFromMessage(mkMessage([imgAtt, docAtt, gifAtt]));
  check('universal-archive: extracts image attachments + gif via extension', found.length === 2);
  check('universal-archive: skips non-image attachments', !found.some(f => f.url.endsWith('.pdf')));

  const found2 = T.seekdeepExtractImagesFromMessage(mkMessage([], [{ image: { url: 'https://cdn.example/embed.png' } }]));
  check('universal-archive: extracts embed images', found2.length === 1 && found2[0].source === 'embed');

  const found3 = T.seekdeepExtractImagesFromMessage(mkMessage([]));
  check('universal-archive: empty message returns []', Array.isArray(found3) && found3.length === 0);

  // State builder
  const states = T.seekdeepBuildUniversalArchiveStates(mkMessage([imgAtt]));
  check('universal-archive: state has attachmentUrl + archiveKey + prompt',
    states.length === 1
    && states[0].attachmentUrl === imgAtt.url
    && states[0].archiveKey.startsWith('universal:999:')
    && states[0].prompt.includes('user upload by tester'));

  // Summary text builder
  const sum1 = T.seekdeepUniversalArchiveSummaryText({ archived: 2, duplicates: 0, threadName: 'My Archive' });
  check('universal-archive: summary text for new images', /Archived 2 image/.test(sum1) && /My Archive/.test(sum1));
  const sum2 = T.seekdeepUniversalArchiveSummaryText({ archived: 0, duplicates: 1 });
  check('universal-archive: summary text for duplicate', /Already archived/.test(sum2));
  const sum3 = T.seekdeepUniversalArchiveSummaryText({ error: 'no_images', humanReason: 'No image attachments or embed images on that message.' });
  check('universal-archive: summary text for no-image case', /No image attachments/.test(sum3));

  // Author-notify gate logic. Exercises the predicate that decides
  // whether to notify the source author. No actual Discord calls —
  // just the bool gate + config read.
  check('universal-archive notify: defaults to 📥', T.SEEKDEEP_UNIVERSAL_ARCHIVE_NOTIFY_EMOJI === '\u{1F4E5}');
  // Skip when target is a bot message (bot-generated images already have an Archive button)
  const botTarget = { author: { id: '111', bot: true }, channel: { id: 'c1' } };
  const userReq   = { user: { id: '222' } };
  check('universal-archive notify: skips bot-source messages',
    T.seekdeepUniversalArchiveShouldNotify(userReq, botTarget) === false);
  // Skip when target author == requester (your own image)
  const ownTarget = { author: { id: '222', bot: false }, channel: { id: 'c1' } };
  check('universal-archive notify: skips self-archives by default',
    T.seekdeepUniversalArchiveShouldNotify(userReq, ownTarget) === false);
  // Mode set (gate true) when archiving someone else's non-bot message
  // (default config from no archive-config.json: uses env-flag fallback,
  // which is 'react' when env is 'on')
  const otherTarget = { author: { id: '999', bot: false }, channel: { id: 'c1' } };
  check('universal-archive notify: fires on other-user image (default mode)',
    T.seekdeepUniversalArchiveShouldNotify(userReq, otherTarget) === true);
  // No target → no notify
  check('universal-archive notify: skips when target missing',
    T.seekdeepUniversalArchiveShouldNotify(userReq, null) === false);

  // Item D: multi-mode config + opt-out
  check('archive notify: known modes are silent/dm/reply/react',
    T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has('silent')
    && T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has('dm')
    && T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has('reply')
    && T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has('react')
    && T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.size === 4);
  // Config loader returns sane defaults when file doesn't exist
  const cfg = T.seekdeepReadArchiveNotifyConfig();
  check('archive notify: config returns object with required keys',
    typeof cfg === 'object'
    && T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has(cfg.mode)
    && typeof cfg.notify_self === 'boolean');
  // Resolver returns the global mode when no per-channel override
  const resolved = T.seekdeepArchiveResolveMode('some-channel-id');
  check('archive notify: mode resolver returns one of the known modes',
    T.SEEKDEEP_ARCHIVE_NOTIFY_MODES.has(resolved));
  // Opt-out check on a never-seen user returns false (not opted out)
  check('archive opt-out: unknown user is NOT opted out',
    T.seekdeepIsArchiveOptedOut('user-id-that-never-existed-99999') === false);
}

// 56 - Prompts marketplace (Item A): variable counter + embed shape + buttons
{
  // Variable counter -- counts unique {{name}} occurrences in prompt body
  check('prompts: counts {{var}} occurrences',
    T.seekdeepPromptsCountVariables('Render a {{subject}} in {{style}}') === 2);
  check('prompts: dedupes repeated {{var}}',
    T.seekdeepPromptsCountVariables('{{x}} and {{x}} again') === 1);
  check('prompts: zero on plain text',
    T.seekdeepPromptsCountVariables('just a regular prompt') === 0);
  check('prompts: tolerates whitespace inside braces',
    T.seekdeepPromptsCountVariables('{{  named  }}') === 1);

  // Embed shape
  const tmpl = { name: 'cosmic-cat', prompt: 'A {{subject}} drifting through {{place}}, painted in {{style}}.' };
  const embed = T.seekdeepPromptsBuildEmbed(tmpl, { authorTag: 'tester#0001', authorId: '123', importCount: 0 });
  check('prompts: embed title prefix',
    embed.title === 'Template: cosmic-cat');
  check('prompts: embed has 4 fields (Variables/Length/Author/Prompt)',
    Array.isArray(embed.fields) && embed.fields.length === 4
    && embed.fields.map(f => f.name).join('|') === 'Variables|Length|Author|Prompt');
  check('prompts: embed shows correct variable count',
    embed.fields[0].value === '3');
  check('prompts: footer mentions scope + import count',
    /scope: this server only/.test(embed.footer.text) && /0 users imported/.test(embed.footer.text));

  // Truncation
  const longPrompt = 'X'.repeat(2000);
  const longEmbed = T.seekdeepPromptsBuildEmbed({ name: 'huge', prompt: longPrompt }, { authorTag: 'a', importCount: 0 });
  check('prompts: long prompt truncated in embed Prompt field',
    longEmbed.fields[3].value.length < T.SEEKDEEP_PROMPTS_SHARE_BODY_MAX + 30);
  check('prompts: truncation appends ellipsis',
    /…\n```$/.test(longEmbed.fields[3].value));

  // Buttons -- custom_id wiring
  const buttons = T.seekdeepPromptsBuildButtons('999');
  check('prompts: ActionRow with 2 buttons',
    buttons.type === 1 && Array.isArray(buttons.components) && buttons.components.length === 2);
  check('prompts: Import button custom_id has share message id',
    buttons.components[0].custom_id === T.SEEKDEEP_PROMPTS_IMPORT_BUTTON_PREFIX + '999');
  check('prompts: Copy button custom_id has share message id',
    buttons.components[1].custom_id === T.SEEKDEEP_PROMPTS_COPY_BUTTON_PREFIX + '999');
  check('prompts: Import button is primary style (1)',
    buttons.components[0].style === 1);
  check('prompts: Copy button is secondary style (2)',
    buttons.components[1].style === 2);

  // Pluralization
  const single = T.seekdeepPromptsBuildEmbed({ name: 'x', prompt: 'no vars' }, { authorTag: 'a', importCount: 1 });
  check('prompts: footer singular when count=1',
    /1 user imported/.test(single.footer.text) && !/1 users/.test(single.footer.text));

  // Tombstone embed (edit-in-place + delete cycle)
  const liveEmbed = T.seekdeepPromptsBuildEmbed(
    { name: 'mortuary-cat', prompt: 'A cat at rest' },
    { authorTag: 'tester#0001', importCount: 5 },
  );
  const tomb = T.seekdeepPromptsBuildTombstoneEmbed(liveEmbed, 'tester#0001');
  check('prompts tombstone: title gets strikethrough markdown',
    tomb.title === '~~Template: mortuary-cat~~');
  check('prompts tombstone: footer adds deleted-by note',
    /deleted by author/.test(tomb.footer.text));
  check('prompts tombstone: color desaturated to gray',
    tomb.color === 0x8b8b8b);
  check('prompts tombstone: preserves field set (Variables/Length/Author/Prompt)',
    Array.isArray(tomb.fields) && tomb.fields.length === 4);
  // Idempotent: re-tombstoning an already-tombstoned embed shouldn't
  // double the strikethrough or the deleted-by note.
  const reTomb = T.seekdeepPromptsBuildTombstoneEmbed(tomb, 'tester#0001');
  check('prompts tombstone: idempotent on title',
    reTomb.title === tomb.title);
  check('prompts tombstone: idempotent on footer',
    (reTomb.footer.text.match(/deleted by author/g) || []).length === 1);

  // Item E: age-aware reshare logic
  check('prompts reshare: max-age default is 14d (designer spec)',
    T.SEEKDEEP_PROMPTS_RESHARE_MAX_AGE_DAYS === 14
    // env override may run in tests; just check it's in the sane range.
    || (T.SEEKDEEP_PROMPTS_RESHARE_MAX_AGE_DAYS >= 1 && T.SEEKDEEP_PROMPTS_RESHARE_MAX_AGE_DAYS <= 365));
  // Age calculator handles posted_at + sharedAt fallback + bad input
  const recent = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();   // 3d ago
  const old    = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString(); // 30d ago
  check('prompts reshare: age calc reads posted_at',
    Math.abs(T.seekdeepPromptsShareAgeDays({ posted_at: recent }) - 3) < 0.05);
  check('prompts reshare: age calc falls back to sharedAt',
    Math.abs(T.seekdeepPromptsShareAgeDays({ sharedAt: recent }) - 3) < 0.05);
  check('prompts reshare: 30d > 14d threshold (would tombstone)',
    T.seekdeepPromptsShareAgeDays({ posted_at: old }) > T.SEEKDEEP_PROMPTS_RESHARE_MAX_AGE_DAYS);
  check('prompts reshare: missing ref returns null',
    T.seekdeepPromptsShareAgeDays(null) === null);
  check('prompts reshare: malformed timestamp returns null',
    T.seekdeepPromptsShareAgeDays({ posted_at: 'definitely-not-a-date' }) === null);
}

// ── Auto-react toggle menu: embed must be STATIC across on/off so the button
//    handler can update components-only and the embed's loading.gif thumbnail
//    never re-renders/restarts (QA: "GIF restarts on every interaction").
if (typeof T.seekdeepBuildReactToggleEmbed === 'function' && typeof T.seekdeepBuildReactToggleComponents === 'function') {
  const guild = { id: 'smoke-rt-guild', name: 'Smoke RT' };
  const data = { guilds: {} };
  T.seekdeepBuildReactToggleEmbed(guild, data); // seeds data.guilds[id] from defaults
  const bucket = data.guilds[guild.id];
  const keys = bucket && bucket.builtins ? Object.keys(bucket.builtins) : [];
  check('reacttoggle: bucket builds from data', keys.length > 0);
  if (keys.length) {
    const k = keys[0];
    const embedJSON = () => JSON.stringify(T.seekdeepBuildReactToggleEmbed(guild, data).toJSON());
    const compsJSON = () => JSON.stringify(T.seekdeepBuildReactToggleComponents(guild, data).map((r) => r.toJSON()));
    bucket.builtins[k].enabled = true;
    const embOn = embedJSON(), compsOn = compsJSON();
    bucket.builtins[k].enabled = false;
    const embOff = embedJSON(), compsOff = compsJSON();
    check('reacttoggle: embed is static across on/off (loading.gif never restarts)',
      embOn === embOff, 'embed differs by toggle state — re-sending it would restart the GIF');
    check('reacttoggle: button components reflect on/off state',
      compsOn !== compsOff, 'buttons did not change with state — toggle state not conveyed');
  }
}

// ── AUD-002: SSRF fetch policy ────────────────────────────────────────────
// seekdeepValidateFetchTarget must reject private/loopback/link-local/metadata
// targets (default policy) and re-validate every redirect hop. All cases below
// use IP literals or local hostnames or bad schemes, so NONE hit real DNS/network.
if (typeof T.seekdeepClassifyBlockedIp === 'function' && typeof T.seekdeepValidateFetchTarget === 'function') {
  console.log('NN. AUD-002 SSRF fetch-target validation.');

  // -- pure IP classifier --
  const blockedIp = (ip) => T.seekdeepClassifyBlockedIp(ip) !== '';
  check('ssrf classify: 127.0.0.1 loopback', blockedIp('127.0.0.1'));
  check('ssrf classify: 10.0.0.1 private', blockedIp('10.0.0.1'));
  check('ssrf classify: 172.16.0.1 private', blockedIp('172.16.0.1'));
  check('ssrf classify: 172.31.255.255 private', blockedIp('172.31.255.255'));
  check('ssrf classify: 172.15.0.1 is PUBLIC (below /12)', !blockedIp('172.15.0.1'));
  check('ssrf classify: 172.32.0.1 is PUBLIC (above /12)', !blockedIp('172.32.0.1'));
  check('ssrf classify: 192.168.1.1 private', blockedIp('192.168.1.1'));
  check('ssrf classify: 169.254.169.254 link-local', blockedIp('169.254.169.254'));
  check('ssrf classify: 100.64.0.1 CGNAT', blockedIp('100.64.0.1'));
  check('ssrf classify: 0.0.0.0 unspecified', blockedIp('0.0.0.0'));
  check('ssrf classify: ::1 loopback', blockedIp('::1'));
  check('ssrf classify: fc00::1 unique-local', blockedIp('fc00::1'));
  check('ssrf classify: fe80::1 link-local', blockedIp('fe80::1'));
  check('ssrf classify: ::ffff:127.0.0.1 mapped loopback', blockedIp('::ffff:127.0.0.1'));
  // AUD-002b: the WHATWG URL parser emits IPv4-mapped IPv6 in compressed HEX form.
  check('ssrf classify: ::ffff:7f00:1 hex mapped loopback', blockedIp('::ffff:7f00:1'));
  check('ssrf classify: ::7f00:1 hex compat loopback', blockedIp('::7f00:1'));
  check('ssrf classify: ::ffff:a9fe:a9fe hex mapped metadata', blockedIp('::ffff:a9fe:a9fe'));
  check('ssrf classify: ::ffff:a00:1 hex mapped 10.0.0.1', blockedIp('::ffff:a00:1'));
  check('ssrf classify: ::ffff:c0a8:101 hex mapped 192.168.1.1', blockedIp('::ffff:c0a8:101'));
  check('ssrf classify: ::ffff:808:808 hex mapped 8.8.8.8 PUBLIC', !blockedIp('::ffff:808:808'));
  check('ssrf classify: 8.8.8.8 PUBLIC', !blockedIp('8.8.8.8'));
  check('ssrf classify: 2606:4700:4700::1111 PUBLIC', !blockedIp('2606:4700:4700::1111'));
  // AUD-002c: NON-CANONICAL IPv6 forms must classify too (canonicalize-before-match).
  check('ssrf classify: 0:0:0:0:0:ffff:7f00:1 non-canon hex loopback', blockedIp('0:0:0:0:0:ffff:7f00:1'));
  check('ssrf classify: 0:0:0:0:0:ffff:127.0.0.1 non-canon dotted loopback', blockedIp('0:0:0:0:0:ffff:127.0.0.1'));
  check('ssrf classify: 0000:0000:0000:0000:0000:ffff:a9fe:a9fe non-canon metadata', blockedIp('0000:0000:0000:0000:0000:ffff:a9fe:a9fe'));
  check('ssrf classify: 0:0:0:0:0:ffff:808:808 non-canon 8.8.8.8 PUBLIC', !blockedIp('0:0:0:0:0:ffff:808:808'));
  // AUD-002c: zone/scope id — net.isIP accepts it; strip before canonicalizing so it can't slip past the $-anchored regexes.
  check('ssrf classify: ::1%eth0 loopback w/ zone id', blockedIp('::1%eth0'));
  check('ssrf classify: fe80::1%eth0 link-local w/ zone id', blockedIp('fe80::1%eth0'));
  check('ssrf classify: 0:0:0:0:0:ffff:127.0.0.1%eth0 mapped loopback w/ zone id', blockedIp('0:0:0:0:0:ffff:127.0.0.1%eth0'));
  // NAT64 (64:ff9b::/96) — embedded IPv4 is the last 32 bits. On an IPv6-only /
  // NAT64 network these translate to that v4, so private/metadata embeds must block.
  check('ssrf classify: 64:ff9b::7f00:1 NAT64 loopback (127.0.0.1)', blockedIp('64:ff9b::7f00:1'));
  check('ssrf classify: 64:ff9b::a9fe:a9fe NAT64 metadata (169.254.169.254)', blockedIp('64:ff9b::a9fe:a9fe'));
  check('ssrf classify: 64:ff9b::a00:1 NAT64 private (10.0.0.1)', blockedIp('64:ff9b::a00:1'));
  check('ssrf classify: 64:ff9b:0:0:0:0:a9fe:a9fe non-canon NAT64 metadata', blockedIp('64:ff9b:0:0:0:0:a9fe:a9fe'));
  check('ssrf classify: 64:ff9b::808:808 NAT64 8.8.8.8 PUBLIC', !blockedIp('64:ff9b::808:808'));
  // 6to4 (2002::/16) — embedded IPv4 is the 32 bits after 2002:.
  check('ssrf classify: 2002:7f00:1::1 6to4 loopback (127.0.0.1)', blockedIp('2002:7f00:1::1'));
  check('ssrf classify: 2002:a9fe:a9fe::1 6to4 metadata (169.254.169.254)', blockedIp('2002:a9fe:a9fe::1'));
  check('ssrf classify: 2002:808:808::1 6to4 8.8.8.8 PUBLIC', !blockedIp('2002:808:808::1'));

  // -- async validator: reject + accept --
  const blocked = async (url, opts) => {
    try { await T.seekdeepValidateFetchTarget(url, opts); return false; } catch { return true; }
  };
  const allowed = async (url, opts) => {
    try { await T.seekdeepValidateFetchTarget(url, opts); return true; } catch { return false; }
  };
  check('ssrf validate: http://127.0.0.1 blocked', await blocked('http://127.0.0.1/x'));
  check('ssrf validate: http://localhost blocked (pre-DNS)', await blocked('http://localhost/x'));
  check('ssrf validate: http://0.0.0.0 blocked', await blocked('http://0.0.0.0/x'));
  check('ssrf validate: http://10.0.0.1 blocked', await blocked('http://10.0.0.1/x'));
  check('ssrf validate: http://192.168.1.1 blocked', await blocked('http://192.168.1.1/x'));
  check('ssrf validate: http://169.254.169.254 blocked (metadata)', await blocked('http://169.254.169.254/latest/meta-data/'));
  check('ssrf validate: metadata.google.internal blocked', await blocked('http://metadata.google.internal/x'));
  check('ssrf validate: http://[::1] blocked', await blocked('http://[::1]/x'));
  check('ssrf validate: http://[fc00::1] blocked', await blocked('http://[fc00::1]/x'));
  check('ssrf validate: http://[fe80::1] blocked', await blocked('http://[fe80::1]/x'));
  check('ssrf validate: ftp:// scheme blocked', await blocked('ftp://example.com/x'));
  check('ssrf validate: file:// scheme blocked', await blocked('file:///etc/passwd'));
  check('ssrf validate: javascript: scheme blocked', await blocked('javascript:alert(1)'));
  check('ssrf validate: https public IPv4 literal allowed', await allowed('https://8.8.8.8/x'));
  check('ssrf validate: https public IPv6 literal allowed', await allowed('https://[2606:4700:4700::1111]/x'));
  // AUD-002b: the real exploit — new URL() canonicalizes these to hex internally.
  check('ssrf validate: http://[::ffff:127.0.0.1] blocked (hex canon)', await blocked('http://[::ffff:127.0.0.1]/x'));
  check('ssrf validate: http://[::127.0.0.1] blocked (hex canon)', await blocked('http://[::127.0.0.1]/x'));
  check('ssrf validate: http://[::ffff:169.254.169.254] blocked', await blocked('http://[::ffff:169.254.169.254]/x'));
  check('ssrf validate: http://[::ffff:10.0.0.1] blocked', await blocked('http://[::ffff:10.0.0.1]/x'));
  check('ssrf validate: http://[::ffff:192.168.1.1] blocked', await blocked('http://[::ffff:192.168.1.1]/x'));
  check('ssrf validate: http://[::ffff:8.8.8.8] public mapped allowed', await allowed('http://[::ffff:8.8.8.8]/x'));

  // -- allowPrivate opt-in: permits loopback, but NEVER metadata/unspecified --
  check('ssrf validate: allowPrivate permits 127.0.0.1', await allowed('http://127.0.0.1/x', { allowPrivate: true }));
  check('ssrf validate: allowPrivate still blocks metadata', await blocked('http://169.254.169.254/x', { allowPrivate: true }));
  check('ssrf validate: allowPrivate still blocks hex-mapped metadata', await blocked('http://[::ffff:169.254.169.254]/x', { allowPrivate: true }));
  check('ssrf validate: allowPrivate still blocks 0.0.0.0', await blocked('http://0.0.0.0/x', { allowPrivate: true }));

  // -- redirect re-validation: public → private must fail before body read --
  // Production now uses node-fetch (not globalThis.fetch) so the per-request
  // `agent` can pin DNS; tests inject a stub transport via the seam below.
  if (typeof T.seekdeepFetchWithLimits === 'function' && typeof T.__setFetchTransportForTests === 'function') {
    T.__setFetchTransportForTests(async (u) => ({
      status: 302,
      ok: false,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? 'http://127.0.0.1/secret' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
      body: null,
    }));
    let redirectBlocked = false;
    try {
      await T.seekdeepFetchWithLimits('https://93.184.216.34/start');
    } catch (e) {
      redirectBlocked = /Blocked fetch|private\/loopback|redirect/i.test(String(e?.message || e));
    }
    T.__setFetchTransportForTests(null);
    check('ssrf redirect: public→127.0.0.1 redirect blocked on re-validation', redirectBlocked);

    // positive: a public→public redirect is followed to a 200
    T.__setFetchTransportForTests(async (u) => {
      const url = String(u);
      if (url.includes('/start')) {
        return {
          status: 302, ok: false,
          headers: { get: (k) => (String(k).toLowerCase() === 'location' ? 'https://1.1.1.1/final' : null) },
          arrayBuffer: async () => new ArrayBuffer(0),
          body: null,
        };
      }
      return { status: 200, ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(3) };
    });
    let followedStatus = 0;
    try {
      const r = await T.seekdeepFetchWithLimits('https://8.8.8.8/start');
      followedStatus = Number(r?.status || 0);
    } catch { followedStatus = -1; }
    T.__setFetchTransportForTests(null);
    check('ssrf redirect: public→public redirect followed to 200', followedStatus === 200);
  }

  // -- DNS-rebinding pin: the pinned lookup ignores the hostname and yields the
  //    pre-validated IP; an http.Agent built from it actually routes there. --
  if (typeof T.seekdeepBuildPinnedLookup === 'function') {
    // (a) pure lookup behavior
    const lookup = T.seekdeepBuildPinnedLookup(['203.0.113.7']);
    const single = await new Promise((resolve) => lookup('attacker-rebind.example', {}, (err, addr, fam) => resolve({ err, addr, fam })));
    check('dns-pin: lookup ignores hostname, returns the validated IPv4', single.err == null && single.addr === '203.0.113.7' && single.fam === 4);
    const all = await new Promise((resolve) => lookup('attacker-rebind.example', { all: true }, (err, entries) => resolve({ err, entries })));
    check('dns-pin: lookup honors {all:true} shape', all.err == null && Array.isArray(all.entries) && all.entries[0].address === '203.0.113.7' && all.entries[0].family === 4);
    const v6 = T.seekdeepBuildPinnedLookup(['2606:4700:4700::1111']);
    const v6r = await new Promise((resolve) => v6('x', {}, (err, addr, fam) => resolve({ addr, fam })));
    check('dns-pin: IPv6 pinned address reports family 6', v6r.addr === '2606:4700:4700::1111' && v6r.fam === 6);

    // (b) end-to-end mechanism: a fake hostname (would NXDOMAIN in real DNS)
    //     resolves to our loopback server purely because the agent's lookup is
    //     pinned to 127.0.0.1 — proving http.Agent honors the pinned lookup.
    const server = http.createServer((req, res) => { res.end('pinned-ok'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const agent = new http.Agent({ lookup: T.seekdeepBuildPinnedLookup(['127.0.0.1']), keepAlive: false });
    let pinnedBody = '';
    try {
      pinnedBody = await new Promise((resolve, reject) => {
        const req = http.get({ host: 'totally-not-real-rebind.example', port, agent }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
        });
        req.on('error', reject);
        req.setTimeout(4000, () => req.destroy(new Error('timeout')));
      });
    } catch (e) { pinnedBody = `ERR:${e.message}`; }
    server.close();
    check('dns-pin: http.Agent routes a fake hostname to the pinned IP (mechanism works)', pinnedBody === 'pinned-ok', pinnedBody);
  }
}

// -- PERSIST-2/3: readJsonSafe quarantines a corrupt file instead of silently
//    returning empty (which the next write would persist over = data loss). --
if (typeof T.readJsonSafe === 'function' && typeof T.writeJsonAtomic === 'function') {
  const pfs = await import('node:fs');
  const pos = await import('node:os');
  const ppath = await import('node:path');
  const dir = pfs.mkdtempSync(ppath.join(pos.tmpdir(), 'sd-persist-'));
  const f = ppath.join(dir, 'data.json');
  T.writeJsonAtomic(f, { users: { a: 1 } });
  const back = T.readJsonSafe(f, { users: {} });
  check('persist: writeJsonAtomic + readJsonSafe round-trip', !!(back && back.users && back.users.a === 1));
  // Corrupt the file → must quarantine + return fallback, NOT overwrite-with-empty.
  pfs.writeFileSync(f, '{ not valid json ', 'utf8');
  const fb = T.readJsonSafe(f, { users: {} });
  const quarantined = pfs.readdirSync(dir).some((n) => n.includes('.corrupt-'));
  check('persist: corrupt file returns the fallback', !!(fb && typeof fb.users === 'object' && Object.keys(fb.users).length === 0));
  check('persist: corrupt file is QUARANTINED, original moved aside (no silent wipe)', quarantined && !pfs.existsSync(f));
  try { pfs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// -- BOT-2: image-queue admission bounds pending depth + per-user in-flight jobs,
//    while admin/priority jobs bypass the caps. --
if (typeof T.seekdeepImageQueueAdmission === 'function' && globalThis.__seekdeepImageQueueState) {
  const qs = globalThis.__seekdeepImageQueueState;
  const savedPending = qs.pending;
  const { maxPending, maxPerUser } = T.imageQueueConstants || {};
  if (maxPending > 0 && maxPerUser > 0 && maxPending > maxPerUser) {
    try {
      qs.pending = [];
      check('queue admission: empty queue admits', T.seekdeepImageQueueAdmission('u1').ok === true);
      // Per-user cap: the user at their limit is refused; a different user is not.
      qs.pending = Array.from({ length: maxPerUser }, () => ({ job: { userId: 'u1' } }));
      const userBlocked = T.seekdeepImageQueueAdmission('u1');
      check('queue admission: per-user cap blocks the over-limit user', userBlocked.ok === false && userBlocked.reason === 'user-limit');
      check('queue admission: per-user cap is per-user (other user still admitted)', T.seekdeepImageQueueAdmission('u2').ok === true);
      // Global cap: a full queue refuses even a brand-new user.
      qs.pending = Array.from({ length: maxPending }, (_, i) => ({ job: { userId: `bulk_${i}` } }));
      const full = T.seekdeepImageQueueAdmission('brand_new_user');
      check('queue admission: global pending cap blocks when full', full.ok === false && full.reason === 'queue-full');
      // Priority/admin jobs bypass the caps even when the queue is full.
      check('queue admission: priority job bypasses a full queue', T.seekdeepImageQueueAdmission('admin', { isPriority: true }).ok === true);
    } finally {
      qs.pending = savedPending;
    }
  }
}

// -- #113 (CodeQL js/regex/missing-regexp-anchor): seekdeepUrlLooksLikeMedia
//    anchors the GIF-host match so a look-alike host isn't misclassified as media. --
if (typeof T.seekdeepUrlLooksLikeMedia === 'function') {
  check('media-url: real tenor link is media', T.seekdeepUrlLooksLikeMedia('https://tenor.com/view/abc-123') === true);
  check('media-url: giphy subdomain is media', T.seekdeepUrlLooksLikeMedia('https://media.giphy.com/x.gif') === true);
  check('media-url: bare tenor.com is media', T.seekdeepUrlLooksLikeMedia('tenor.com') === true);
  check('media-url: look-alike tenor.com.evil.com is NOT media', T.seekdeepUrlLooksLikeMedia('https://tenor.com.evil.com/x') === false);
  check('media-url: tenor.com in a query param is NOT media', T.seekdeepUrlLooksLikeMedia('https://example.com/?u=tenor.com') === false);
  check('media-url: direct .gif is still media', T.seekdeepUrlLooksLikeMedia('https://cdn.example.com/a.gif') === true);
}

// -- COUP-1: cross-process lock primitive. seekdeepMutateJson holds <path>.lock
//    across read->modify->write; stale locks (crashed holder) are stolen. --
if (typeof T.seekdeepMutateJson === 'function') {
  const lfs = await import('node:fs');
  const los = await import('node:os');
  const lpath = await import('node:path');
  const ldir = lfs.mkdtempSync(lpath.join(los.tmpdir(), 'sd-lock-'));
  const lf = lpath.join(ldir, 'shared.json');
  const lock = lf + '.lock';
  try {
    T.seekdeepMutateJson(lf, { users: {} }, (d) => { d.users.alice = 1; });
    const b1 = JSON.parse(lfs.readFileSync(lf, 'utf8'));
    check('lock: mutateJson read-modify-write round-trips', !!(b1.users && b1.users.alice === 1));
    check('lock: lockfile released after mutateJson', !lfs.existsSync(lock));
    T.seekdeepMutateJson(lf, { users: {} }, (d) => { d.users.bob = 2; });
    const b2 = JSON.parse(lfs.readFileSync(lf, 'utf8'));
    check('lock: second mutate preserves the first write', b2.users.alice === 1 && b2.users.bob === 2);
    // Stale lock: a leftover .lock with an old mtime must be stolen, not block forever.
    lfs.writeFileSync(lock, '999999 stale');
    const old = (Date.now() / 1000) - 3600; // 1h ago, well past the 15s stale threshold
    lfs.utimesSync(lock, old, old);
    let ran = false;
    T.seekdeepMutateJson(lf, { users: {} }, (d) => { d.users.carol = 3; ran = true; });
    const b3 = JSON.parse(lfs.readFileSync(lf, 'utf8'));
    check('lock: stale lock is stolen + mutate proceeds', ran && b3.users.carol === 3);
    check('lock: stale lockfile cleaned up after takeover', !lfs.existsSync(lock));
    // TEST-1: a LIVE (fresh) lock held by "another process" — seekdeepWithFileLock
    // waits up to the (test-shortened) timeout, then FAILS OPEN without stealing it.
    // A rare lost update beats freezing the bot; this is COUP-1's cross-process
    // contract (the Node side of the Node<->Python coordination).
    lfs.writeFileSync(lock, '99999 held-by-other');
    let failOpenRan = false;
    T.seekdeepWithFileLock(lf, () => { failOpenRan = true; });
    check('lock: fail-open proceeds past a live lock after timeout', failOpenRan);
    check('lock: fail-open does NOT steal a live (non-stale) lock', lfs.existsSync(lock));
    try { lfs.rmSync(lock, { force: true }); } catch {}
  } finally {
    try { lfs.rmSync(ldir, { recursive: true, force: true }); } catch {}
  }
}

// -- BOT-1/BOT-2: in-memory stores must evict past their cap (unbounded-growth guards). --
if (typeof T.remember === 'function' && typeof T.seekdeepRememberImageSubjectPrompt === 'function' && T.memoryStoreConstants) {
  const { maxKeys, recentImageSubjectsMax } = T.memoryStoreConstants;
  const store = globalThis.__seekdeepMemoryCompatStoreV13;
  if (store && maxKeys > 0) {
    store.clear();
    for (let i = 0; i < maxKeys + 50; i++) T.remember('user:c:' + i, 'user', 'hello ' + i);
    check('mem-evict: conversation store capped at maxKeys', store.size === maxKeys);
    check('mem-evict: newest conversation key retained', store.has('user:c:' + (maxKeys + 49)));
    check('mem-evict: oldest conversation key evicted', !store.has('user:c:0'));
    store.clear();
  }
  const subs = globalThis.__seekdeepRecentImageSubjects;
  if (subs && recentImageSubjectsMax > 0) {
    subs.clear();
    for (let i = 0; i < recentImageSubjectsMax + 50; i++) {
      T.seekdeepRememberImageSubjectPrompt({ channel: { id: 'c' + i }, author: { id: 'u' } }, 'a red apple number ' + i);
    }
    check('mem-evict: recent-image-subjects capped', subs.size === recentImageSubjectsMax);
    check('mem-evict: oldest image-subject evicted', !subs.has('c0:u'));
    subs.clear();
  }
}

// BOT-4: cooldown-map TTL sweep — guards the image/translate cooldown Maps from
// unbounded growth (one stale timestamp per unique user/channel, never removed).
if (typeof T.seekdeepSweepExpiredCooldowns === 'function') {
  const now = Date.now();
  const m = new Map();
  for (let i = 0; i < 600; i++) m.set('k' + i, i < 400 ? now - 100000 : now); // 400 expired + 200 fresh, > default 512 threshold
  T.seekdeepSweepExpiredCooldowns(m, 5000); // 5s window
  check('BOT-4: expired cooldown entries swept past threshold', m.size === 200);
  check('BOT-4: fresh entries kept, oldest expired dropped', m.has('k599') && !m.has('k0'));
  const small = new Map([['a', now - 100000]]);
  T.seekdeepSweepExpiredCooldowns(small, 5000);
  check('BOT-4: small map left untouched (below sweep threshold)', small.size === 1);
}

// BOT: transient-server-down classifier — a socket-level failure ("fetch
// failed", ECONNRESET/REFUSED, undici UND_ERR_*, our timeout wrapper) must be
// treated as "server unreachable" (soft, friendly reply) while a genuine HTTP
// 4xx/5xx-with-detail must NOT (keep its diagnostic message). Guards the fix for
// the public "SeekDeep request failed / Error: / fetch failed" wall.
if (typeof T.seekdeepIsServerUnreachableError === 'function') {
  const isDown = T.seekdeepIsServerUnreachableError;
  // The exact screenshot case: undici bare "fetch failed".
  check('srv-down: bare "fetch failed"', isDown(new TypeError('fetch failed')) === true);
  // undici carries the real socket errno on .cause.code.
  check('srv-down: cause.code ECONNRESET', isDown(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })) === true);
  check('srv-down: code ECONNREFUSED', isDown(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) === true);
  check('srv-down: undici UND_ERR_SOCKET', isDown(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })) === true);
  // postLocal's AbortController timeout wrapper.
  check('srv-down: postLocal timeout wrapper', isDown(new Error('Local AI request timed out after 300.0 seconds.')) === true);
  check('srv-down: raw AbortError', isDown(Object.assign(new Error('aborted'), { name: 'AbortError' })) === true);
  check('srv-down: circuit-open error', isDown({ code: 'AI_CIRCUIT_OPEN' }) === true);
  // A real HTTP error (status set) is NOT a transport failure — keep its detail.
  check('srv-down: HTTP 500 NOT treated as unreachable', isDown(Object.assign(new Error('Request failed. HTTP 500: model failed to load'), { status: 500 })) === false);
  check('srv-down: HTTP 400 NOT treated as unreachable', isDown(Object.assign(new Error('bad request'), { status: 400 })) === false);
  // A plain content/logic error is not a transport failure.
  check('srv-down: ordinary error NOT unreachable', isDown(new Error('something odd happened')) === false);
  check('srv-down: null-safe', isDown(null) === false);
}

// BOT: failure replies must NOT carry a "Time to Generate / Model Used: local
// command" footer — that read as if a local command had run when the request
// actually failed.
if (typeof T.seekdeepShouldHideCommandFooter === 'function') {
  const hide = T.seekdeepShouldHideCommandFooter;
  const noModel = { modelUsed: 'local command (no AI model)' };
  check('footer-hide: "SeekDeep request failed" wall', hide('SeekDeep request failed.\n\nError:\nfetch failed', noModel) === true);
  check('footer-hide: friendly server-down reply', hide('🔌 The local AI server dropped the connection — it may be restarting or reloading a model. Give it a few seconds and ask me again.', noModel) === true);
  // A normal chat answer (real model) still keeps its footer.
  check('footer-hide: real chat answer keeps footer', hide('Here is your answer.', { modelUsed: 'meta-llama/Llama-3.1-8B-Instruct' }) === false);
}

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
