# SeekDeep / Seekotics public-use + regenerate-mode options patch v2
#
# Fixes v1 patch failure:
#   re.PatternError: missing ), unterminated subpattern
#
# Changes:
# - Removes static slash-command default member permission gates so normal users can use normal commands.
# - Adds runtime helper stubs for privileged archive/admin commands.
# - Changes generated image result buttons to:
#     Original / Refined / Both / Download / Archive
# - Adds regenerate mode helper.
#
# Safety:
# - Backs up index.js first.
# - Patches only index.js.
# - Runs node and Python syntax checks.

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Write-Info($m) { Write-Host "[SeekDeep public-regenerate-v2] $m" -ForegroundColor Cyan }
function Write-Pass($m) { Write-Host "[PASS] $m" -ForegroundColor Green }
function Write-Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red }

try {
  $projectRoot = Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "index.js"))) {
    $projectRoot = (Get-Location).Path
  }

  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $backupDir = Join-Path $projectRoot "patches\backups"
  $patchesDir = Join-Path $projectRoot "patches"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not (Test-Path -LiteralPath $indexPath)) { throw "index.js not found." }
  if (-not (Test-Path -LiteralPath $serverPath)) { throw "local_ai_server.py not found." }

  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null

  $backup = Join-Path $backupDir "index.js.public-use-regenerate-modes-v2-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backup -Force
  Write-Pass "Backed up index.js to $backup"

  $patchPy = @'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")

def fail(msg):
    raise SystemExit(msg)

def need(s, label):
    if s not in text:
        fail(f"Required anchor not found: {label}")

def find_brace(src, open_i):
    depth = 0
    i = open_i
    quote = None
    esc = False
    line = False
    block = False
    while i < len(src):
        ch = src[i]
        nx = src[i+1] if i+1 < len(src) else ''
        if line:
            if ch == '\n': line = False
            i += 1
            continue
        if block:
            if ch == '*' and nx == '/':
                block = False
                i += 2
                continue
            i += 1
            continue
        if quote:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == quote:
                quote = None
            i += 1
            continue
        if ch == '/' and nx == '/':
            line = True
            i += 2
            continue
        if ch == '/' and nx == '*':
            block = True
            i += 2
            continue
        if ch in ("'", '"', '`'):
            quote = ch
            i += 1
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return i
        i += 1
    fail("Could not find matching brace")

def get_fn(src, name):
    starts = []
    if name.startswith("function ") or name.startswith("async function "):
        starts.append(src.find(name))
    else:
        starts += [src.find(f"function {name}("), src.find(f"async function {name}(")]
    start = next((x for x in starts if x >= 0), -1)
    if start < 0:
        return None, -1, -1
    brace = src.find("{", start)
    end = find_brace(src, brace) + 1
    return src[start:end], start, end

def replace_fn(src, name, body):
    _, s, e = get_fn(src, name)
    if s < 0:
        fail(f"Could not locate function: {name}")
    return src[:s] + body.rstrip() + src[e:]

need("ButtonBuilder", "Discord button builder")
need("ButtonStyle", "Discord button style")
need("client.on('interactionCreate'", "interaction handler")
need("seekdeepEnqueueImageJob(job, runner)", "queue contract")

if "seekdeepMakeImageQueueJobId" in text:
    fail("Unsafe old queue helper found")
if "job.run" in text:
    fail("Unsafe job.run queue helper found")

# 1) Remove command builder permission gates.
text = re.sub(r"\n\s*\.setDefaultMemberPermissions\(\s*[^)]*\)", "", text)

# 2) Add public-use helper block.
if "function seekdeepIsPrivilegedArchiveCommand" not in text:
    block = r"""
function seekdeepIsPrivilegedArchiveCommand(commandName = '') {
  return /^(?:purgearchive|setarchive|archiveconfig|archiveadmin|cleararchive)$/i.test(String(commandName || ''));
}

function seekdeepUserCanRunPrivilegedSeekDeepCommand(interactionOrMessage = {}) {
  const memberPermissions = interactionOrMessage?.memberPermissions || interactionOrMessage?.member?.permissions || null;
  if (!memberPermissions || typeof memberPermissions.has !== 'function') return false;
  try {
    return Boolean(
      memberPermissions.has(PermissionFlagsBits.Administrator) ||
      memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
      memberPermissions.has(PermissionFlagsBits.ManageChannels)
    );
  } catch {
    return false;
  }
}

function seekdeepNormalUsersMayUseCommand(commandName = '') {
  return !seekdeepIsPrivilegedArchiveCommand(commandName);
}

"""
    pos = text.find("client.on('interactionCreate'")
    text = text[:pos] + block + text[pos:]

# 3) Replace image action row if present.
fn, s, e = get_fn(text, "seekdeepImageActionRow")
if s >= 0:
    row = r"""function seekdeepImageActionRow(actionId, filePath = '') {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:original:${actionId}`)
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:refined:${actionId}`)
      .setLabel('Refined')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`seekdeep:regen:both:${actionId}`)
      .setLabel('Both')
      .setStyle(ButtonStyle.Success),
  );

  if (filePath) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`seekdeep:download:${actionId}`)
        .setLabel('Download')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`seekdeep:archive:${actionId}`)
      .setLabel('Archive')
      .setStyle(ButtonStyle.Success),
  );

  return row;
}"""
    text = text[:s] + row + text[e:]

# 4) Add regenerate mode helper.
if "function seekdeepRegenerateModeOptions" not in text:
    helper = r"""
function seekdeepRegenerateModeOptions(mode = 'submitted', action = null) {
  const normalized = String(mode || 'submitted').toLowerCase();
  const basePrompt = action?.originalPrompt || action?.prompt || action?.rawPrompt || 'image';
  const base = {
    ground: action?.ground !== false,
    cleanPrompt: basePrompt,
    silentAck: true,
    skipCooldown: true,
  };

  if (normalized === 'original' || normalized === 'raw') {
    return { ...base, refine: false };
  }

  if (normalized === 'refined') {
    return { ...base, refine: true };
  }

  const originallyRaw = action?.refine === false || action?.imageModeOptions?.refine === false || action?.refinement === false;
  return { ...base, refine: !originallyRaw };
}

"""
    pos = text.find("async function seekdeepHandleImageButton")
    if pos < 0:
        pos = text.find("client.on('interactionCreate'")
    text = text[:pos] + helper + text[pos:]

# 5) Patch image button handler conservatively.
handler, hs, he = get_fn(text, "seekdeepHandleImageButton")
if hs >= 0:
    if "const seekdeepImageButtonParsed =" not in handler:
        open_i = handler.find("{")
        parser = r"""
  const seekdeepImageButtonParsed =
    customId.match(/^seekdeep:(regen):(original|refined|both):(.+)$/) ||
    customId.match(/^seekdeep:(regenerate|download|archive):(.+)$/);

  if (!seekdeepImageButtonParsed) return false;

  let buttonAction = seekdeepImageButtonParsed[1];
  let regenMode = 'submitted';
  let actionId = '';

  if (buttonAction === 'regen') {
    regenMode = seekdeepImageButtonParsed[2] || 'submitted';
    actionId = seekdeepImageButtonParsed[3] || '';
    buttonAction = 'regenerate';
  } else {
    actionId = seekdeepImageButtonParsed[2] || '';
  }

  const action = buttonAction;

"""
        handler = handler[:open_i+1] + parser + handler[open_i+1:]

    # Remove simple old parser lines that would redeclare action/actionId.
    handler = re.sub(r"\n\s*const\s+match\s*=\s*customId\.match\([^\n;]+;\s*", "\n", handler)
    handler = re.sub(r"\n\s*if\s*\(!match\)\s*return\s+false;\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+action\s*=\s*match\[[^\]]+\];\s*", "\n", handler)
    handler = re.sub(r"\n\s*const\s+actionId\s*=\s*match\[[^\]]+\];\s*", "\n", handler)

    if "regenMode === 'both'" not in handler:
        marker = "if (action === 'regenerate')"
        idx = handler.find(marker)
        if idx >= 0:
            both = r"""
  if (action === 'regenerate' && regenMode === 'both') {
    const recordForBoth = actionRecord || record || item || actionData || imageAction || null;
    const basePromptForBoth = recordForBoth?.originalPrompt || recordForBoth?.prompt || recordForBoth?.rawPrompt || 'image';
    const widthForBoth = recordForBoth?.width || 1024;
    const heightForBoth = recordForBoth?.height || 1024;
    const seedForBoth = recordForBoth?.seed ?? null;

    await interaction.reply({
      content: seekdeepAppendResponseFooter('Queued both regenerate versions.\n\nJobs queued:\n1. Original prompt\n2. Refined prompt', {
        startedAt: seekdeepNowMs(),
        modelUsed: seekdeepNoModelLabel(),
      }),
      ephemeral: true,
    });

    const proxyOriginal = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-original')
      : { author: { id: interaction?.user?.id || 'unknown' }, channel: interaction?.channel, id: interaction?.id || 'regen-original', reply: async (payload) => interaction?.channel?.send ? interaction.channel.send(payload) : null };

    const proxyRefined = typeof seekdeepPromptChoiceProxyMessage === 'function'
      ? seekdeepPromptChoiceProxyMessage(interaction, interaction?.user?.id || '', 'regen-refined')
      : { author: { id: interaction?.user?.id || 'unknown' }, channel: interaction?.channel, id: `${interaction?.id || 'regen'}:refined`, reply: async (payload) => interaction?.channel?.send ? interaction.channel.send(payload) : null };

    void seekdeepSendImageWithButtonsMessage(proxyOriginal, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('original', recordForBoth));
    void seekdeepSendImageWithButtonsMessage(proxyRefined, basePromptForBoth, widthForBoth, heightForBoth, seedForBoth, seekdeepRegenerateModeOptions('refined', recordForBoth));
    return true;
  }

"""
            handler = handler[:idx] + both + handler[idx:]

    text = text[:hs] + handler + text[he:]

# 6) Preserve original prompt metadata in common record literal, if present.
if "originalPrompt: prompt" not in text:
    text = text.replace("prompt: prompt,", "prompt: prompt,\n    originalPrompt: prompt,", 1)

need("function seekdeepRegenerateModeOptions", "regenerate helper")
need("function seekdeepIsPrivilegedArchiveCommand", "public-use helper")
need("seekdeepEnqueueImageJob(job, runner)", "queue contract")

if "function seekdeepImageActionRow" in text:
    need("setLabel('Original')", "Original button")
    need("setLabel('Refined')", "Refined button")
    need("setLabel('Both')", "Both button")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched public-use and regenerate mode options v2.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_public_use_regenerate_modes_v2.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))

  Push-Location $projectRoot
  try {
    Write-Info "Applying public-use + regenerate-mode patch v2"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) { throw "Patch helper failed with exit code $LASTEXITCODE." }
    Write-Pass "Applied public-use + regenerate-mode patch v2"

    Write-Info "Running node --check .\index.js"
    & node --check ".\index.js"
    if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE." }
    Write-Pass "node --check passed"

    Write-Info "Running Python compile check"
    & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE." }
    Write-Pass "Python compile check passed"
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Pass "Public-use + regenerate-mode patch v2 completed."
  Write-Host "Backup created: $backup" -ForegroundColor Yellow
  Write-Host "Restart the bot and re-register commands if your launcher has that option." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Retest:" -ForegroundColor Cyan
  Write-Host "1) Have a non-admin user run /status or @SEEKOTICS status." -ForegroundColor White
  Write-Host "2) Generate an image and confirm result buttons show Original / Refined / Both / Download / Archive." -ForegroundColor White
  exit 0
} catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host "Backup available:" -ForegroundColor Yellow
  if ($backup) { Write-Host $backup -ForegroundColor Yellow }
  exit 1
}
