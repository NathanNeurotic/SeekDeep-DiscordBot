$ErrorActionPreference = 'Stop'

$root = (Get-Location).Path
$indexPath = Join-Path $root 'index.js'
$localAiPath = Join-Path $root 'local_ai_server.py'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$backupDir = Join-Path $root 'backups'
$patchDir = Join-Path $root 'patches'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $backupDir "index.js.before-research-shims-archive-alias-v1-$stamp.bak"
$patcherPath = Join-Path $patchDir "apply_research_shims_archive_alias_v1_$stamp.cjs"

if (!(Test-Path $indexPath)) {
  throw "index.js not found. Run this from C:\Users\natha\SeekDeep-DiscordBot."
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
New-Item -ItemType Directory -Path $patchDir -Force | Out-Null
Copy-Item $indexPath $backupPath -Force
Write-Host "Backup created: $backupPath"

$patcher = @'
const fs = require('fs');

const indexPath = process.argv[2];
if (!indexPath) throw new Error('Missing index.js path argument.');

let src = fs.readFileSync(indexPath, 'utf8');
let next = src;
let changes = [];

function esc(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDefinition(name) {
  const n = esc(name);
  return new RegExp(`\\bfunction\\s+${n}\\s*\\(`).test(next) ||
    new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*=`).test(next);
}

function addIfMissing(name, code, additions) {
  if (!hasDefinition(name)) {
    additions.push(code.trim());
    return true;
  }
  return false;
}

const additions = [];

addIfMissing('seekdeepCompatResearchText', `
function seekdeepCompatResearchText(value = '') {
  try {
    if (typeof normalizeUserText === 'function') {
      return normalizeUserText(value);
    }
  } catch {}

  return String(value ?? '')
    .replace(/\\s+/g, ' ')
    .trim();
}
`, additions);

addIfMissing('seekdeepCompatResearchLower', `
function seekdeepCompatResearchLower(value = '') {
  return seekdeepCompatResearchText(value).toLowerCase();
}
`, additions);

addIfMissing('seekdeepCleanResearchTopic', `
function seekdeepCleanResearchTopic(topic = '') {
  const original = seekdeepCompatResearchText(topic);
  const cleaned = original
    .replace(/<@!?\\d+>/g, ' ')
    .replace(/\\b@?(?:seekdeep|seekotics)\\b/gi, ' ')
    .replace(/^(?:can\\s+you|could\\s+you|please|pls)\\s+/i, '')
    .replace(/^(?:search|look\\s+up|lookup|research|compare|comparison|make|create|show|give\\s+me|build)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+)?/i, '')
    .replace(/^(?:table|chart|matrix|spreadsheet)\\s+(?:of|for|about)?\\s*/i, '')
    .replace(/\\s+/g, ' ')
    .trim();

  return cleaned || original;
}
`, additions);

addIfMissing('seekdeepResearchSystem', `
function seekdeepResearchSystem(mode = 'research') {
  const selected = String(mode || 'research').toLowerCase();
  const base = [
    'You are SeekDeep, a direct research assistant inside Discord.',
    'Use web/search context when available. Do not invent current facts, prices, specs, or citations.',
    'If sources are weak, stale, or ambiguous, say so plainly.',
    'Keep the answer practical, concise, and easy to compare.'
  ];

  if (selected === 'table') {
    base.push('For table requests, start with a Markdown table, then add only the necessary caveats.');
  } else {
    base.push('For comparisons, preserve the exact items the user asked about and avoid switching to unrelated models.');
  }

  return base.join(' ');
}
`, additions);

addIfMissing('seekdeepBuildFocusedResearchSearchQuery', `
function seekdeepBuildFocusedResearchSearchQuery(topic = '', mode = 'research') {
  const clean = seekdeepCleanResearchTopic(topic);
  const selected = String(mode || 'research').toLowerCase();
  if (!clean) return '';

  if (selected === 'table') return clean + ' comparison specs table review';
  if (selected === 'proscons') return clean + ' pros cons comparison review';
  if (selected === 'recommendation') return clean + ' comparison recommendation review';
  if (selected === 'audit') return clean;
  return clean + ' comparison specs review';
}
`, additions);

addIfMissing('seekdeepIsFrustrationPrompt', `
function seekdeepIsFrustrationPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;

  return (
    /^(?:no|nah|wrong|incorrect|false|bad|terrible|useless|garbage|bullshit|bs|wtf|what\\s+the\\s+fuck)\\b/.test(p) ||
    /\\b(?:not\\s+helpful|did(?:n['’]?t| not)\\s+help|does(?:n['’]?t| not)\\s+help|wrong\\s+answer|bad\\s+answer|made\\s+that\\s+up|hallucinat(?:ed|ing)|you\\s+missed|you\\s+ignored|not\\s+what\\s+i\\s+asked|that\\s+is(?:n['’]?t| not)\\s+right|try\\s+again|redo\\s+that|fix\\s+that)\\b/.test(p)
  );
}
`, additions);

addIfMissing('seekdeepIsVagueWebRequest', `
function seekdeepIsVagueWebRequest(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\\b(?:archive|status|help|queue|image|vision|download|regenerate|refined?|original)\\b/.test(p)) return false;

  return (
    /^(?:search|look\\s+up|lookup|research|google|web\\s+search|find\\s+sources?)\\s*(?:it|that|this)?\\s*$/.test(p) ||
    /^(?:(?:can|could)\\s+you\\s+)?(?:search|look\\s+up|lookup|research|google)\\s*(?:it|that|this)?\\s*$/.test(p) ||
    (/\\b(?:search\\s+the\\s+web|look\\s+it\\s+up|look\\s+that\\s+up|google\\s+it|find\\s+sources?)\\b/.test(p) && p.split(/\\s+/).length <= 10)
  );
}
`, additions);

addIfMissing('seekdeepIsTableRequestPrompt', `
function seekdeepIsTableRequestPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\\b(?:archive|status|help|queue|image|vision|download|regenerate)\\b/.test(p)) return false;

  return (
    /^(?:(?:can|could)\\s+you\\s+|please\\s+)?(?:make|create|build|show|give\\s+me|generate)?\\s*(?:a\\s+)?(?:comparison\\s+)?(?:table|chart|matrix|spreadsheet)\\b/.test(p) ||
    /\\b(?:in|as)\\s+(?:a\\s+)?(?:table|chart|matrix|spreadsheet)\\b/.test(p)
  );
}
`, additions);

addIfMissing('seekdeepLooksLikeComparisonItemsFollowup', `
function seekdeepLooksLikeComparisonItemsFollowup(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\\b(?:archive|status|help|queue|image|vision|download|regenerate)\\b/.test(p)) return false;

  if (/\\b(?:vs\\.?|versus|compared\\s+to)\\b/.test(p)) return true;
  if (/[,|/]/.test(p) && p.split(/[,|/]/).map((x) => x.trim()).filter(Boolean).length >= 2) return true;
  if (/\\b(?:and|or)\\b/.test(p) && /\\b(?:compare|comparison|table|chart|specs?|price|review|model|generation|laptop|phone|gpu|cpu)\\b/.test(p)) return true;
  if (/^[-*]\\s+.+(?:\\n|$)/m.test(String(prompt || ''))) return true;

  return false;
}
`, additions);

addIfMissing('seekdeepIsComparisonResearchPrompt', `
function seekdeepIsComparisonResearchPrompt(prompt = '') {
  const p = seekdeepCompatResearchLower(prompt);
  if (!p) return false;
  if (/\\b(?:archive|archivestatus|status|help|commands|queue|image|vision|download|regenerate|cache)\\b/.test(p)) return false;

  return (
    /^(?:compare|comparison|versus|vs\\.?|pros\\s*\\/?\\s*cons|pros\\s+and\\s+cons)\\b/.test(p) ||
    /\\b(?:compare|comparison|vs\\.?|versus|which\\s+(?:one|is|should)|better|best|recommend|recommendation|ranking|rank|pros\\s*\\/?\\s*cons|pros\\s+and\\s+cons|specs?|benchmarks?|prices?)\\b/.test(p)
  );
}
`, additions);

addIfMissing('seekdeepMultipleCommandText', `
function seekdeepMultipleCommandText() {
  return [
    'I saw more than one SeekDeep mention in that message, so I stopped instead of guessing which command to run.',
    'Use one bot mention, then the command. Example: @SEEKOTICS archive @user'
  ].join('\\n');
}
`, additions);

if (additions.length > 0) {
  if (next.includes('SEEKDEEP_RESEARCH_HELPER_SHIMS_ARCHIVE_ALIAS_V1_START')) {
    throw new Error('Research helper shim marker already exists, but at least one required helper still appears missing. Refusing to stack another shim block.');
  }

  const anchor = 'async function seekdeepHandleResearchTableMessage(message, prompt, key)';
  if (!next.includes(anchor)) {
    throw new Error('Could not find research handler anchor. index.js may have drifted; aborting.');
  }

  const block = [
    '// SEEKDEEP_RESEARCH_HELPER_SHIMS_ARCHIVE_ALIAS_V1_START',
    '// Compatibility helpers for the research/table message route. These are intentionally',
    '// small and bounded so archive/status commands cannot crash by falling through this path.',
    additions.join('\n\n'),
    '// SEEKDEEP_RESEARCH_HELPER_SHIMS_ARCHIVE_ALIAS_V1_END',
    ''
  ].join('\n');

  next = next.replace(anchor, `${block}${anchor}`);
  changes.push(`added ${additions.length} missing research/message helper(s)`);
}

if (!next.includes('SEEKDEEP_ARCHIVE_TARGET_IGNORE_BOT_V1_START')) {
  const mentionPattern = /  let targetUser = message\.author;\r?\n  const mentioned = message\.mentions\?\.users\?\.first\?\.\(\);\r?\n\r?\n  if \(mentioned\) \{/;
  const mentionReplacement = `  let targetUser = message.author;
  // SEEKDEEP_ARCHIVE_TARGET_IGNORE_BOT_V1_START
  const botUserIdForArchiveTarget = typeof seekdeepBotUserId === 'function'
    ? seekdeepBotUserId()
    : String(client?.user?.id || '');
  let mentioned = null;

  try {
    mentioned = message.mentions?.users?.find?.((user) => String(user?.id || '') !== botUserIdForArchiveTarget) || null;
    if (!mentioned && typeof message.mentions?.users?.values === 'function') {
      mentioned = Array.from(message.mentions.users.values()).find((user) => String(user?.id || '') !== botUserIdForArchiveTarget) || null;
    }
  } catch {}
  // SEEKDEEP_ARCHIVE_TARGET_IGNORE_BOT_V1_END

  if (mentioned) {`;

  if (!mentionPattern.test(next)) {
    throw new Error('Could not find archive target mention selection block. Refusing to patch archive target parsing blindly.');
  }

  next = next.replace(mentionPattern, mentionReplacement);
  changes.push('updated archive target parsing to ignore the bot mention');
}

if (!next.includes('SEEKDEEP_ARCHIVE_STRIPPED_RETRY_V1_START')) {
  const archiveOpenPattern = /    const seekdeepArchiveOpenRawContent = String\(message\?\.content \|\| ''\);\r?\n    if \(await seekdeepHandleArchiveOpenMessage\(message, seekdeepArchiveOpenRawContent\)\) \{\r?\n      return;\r?\n    \}/;
  const archiveOpenReplacement = `    const seekdeepArchiveOpenRawContent = String(message?.content || '');
    // SEEKDEEP_ARCHIVE_STRIPPED_RETRY_V1_START
    const seekdeepArchiveOpenStrippedContent = typeof seekdeepStripBotMentions === 'function'
      ? seekdeepStripBotMentions(seekdeepArchiveOpenRawContent)
      : seekdeepArchiveOpenRawContent;

    if (await seekdeepHandleArchiveOpenMessage(message, seekdeepArchiveOpenRawContent)) {
      return;
    }

    if (
      seekdeepArchiveOpenStrippedContent &&
      seekdeepArchiveOpenStrippedContent !== seekdeepArchiveOpenRawContent &&
      await seekdeepHandleArchiveOpenMessage(message, seekdeepArchiveOpenStrippedContent)
    ) {
      return;
    }
    // SEEKDEEP_ARCHIVE_STRIPPED_RETRY_V1_END`;

  if (!archiveOpenPattern.test(next)) {
    throw new Error('Could not find archive-open raw message route block. Refusing to patch archive alias routing blindly.');
  }

  next = next.replace(archiveOpenPattern, archiveOpenReplacement);
  changes.push('added stripped bot-mention retry for archive message route');
}

if (next === src) {
  console.log('No text changes were needed; patch markers/helpers already appear present.');
} else {
  fs.writeFileSync(indexPath, next, 'utf8');
  for (const change of changes) console.log(`Applied: ${change}`);
}
'@

Set-Content -Path $patcherPath -Value $patcher -Encoding UTF8

try {
  Write-Host "Applying patch with: $patcherPath"
  & node $patcherPath $indexPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Host "Running node syntax check..."
  & node --check $indexPath
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if ((Test-Path $venvPython) -and (Test-Path $localAiPath)) {
    Write-Host "Running Python compile check..."
    & $venvPython -m py_compile $localAiPath
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
  } else {
    Write-Host "Python compile check skipped: .venv python or local_ai_server.py not found."
  }

  Write-Host ""
  Write-Host "Patch complete: research helper shims + archive alias route hardening applied."
  Write-Host "Backup kept at: $backupPath"
} catch {
  Write-Host ""
  Write-Host "Patch failed. Restoring backup..." -ForegroundColor Red
  Copy-Item $backupPath $indexPath -Force
  Write-Host "Restored: $backupPath" -ForegroundColor Yellow
  throw
}
