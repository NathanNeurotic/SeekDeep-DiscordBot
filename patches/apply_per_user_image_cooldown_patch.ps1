# SeekDeep / Seekotics per-user image cooldown patch
# Adds a per-user cooldown for image generation routes to prevent spam.
#
# Applies to:
# - text image prompts
# - slash/image paths that use the shared message image queue helper, where present
# - text regenerate, if the prior text-regenerate patch is present
#
# Preserves:
# - stabilized dispatcher
# - post archive hard-command routing
# - model-status routing, if already applied
# - text regenerate routing, if already applied
# - correct image queue contract: seekdeepEnqueueImageJob(job, runner)
#
# Required checks run at end:
#   node --check .\index.js
#   .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py
#
# Configure cooldown seconds via env var:
#   SEEKDEEP_IMAGE_USER_COOLDOWN_SECONDS=30
#
# Default:
#   45 seconds

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-SeekDeepInfo {
  param([string]$Message)
  Write-Host "[SeekDeep patch] $Message" -ForegroundColor Cyan
}

function Write-SeekDeepPass {
  param([string]$Message)
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-SeekDeepFail {
  param([string]$Message)
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Resolve-SeekDeepRoot {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) {
    $scriptPath = $MyInvocation.MyCommand.Path
  }

  $scriptDir = $null
  if ($scriptPath) {
    $scriptDir = Split-Path -Parent $scriptPath
  }

  $candidates = New-Object System.Collections.Generic.List[string]

  if ($scriptDir) {
    if ((Split-Path -Leaf $scriptDir) -ieq "patches") {
      $candidates.Add((Split-Path -Parent $scriptDir))
    }
    $candidates.Add($scriptDir)
  }

  $candidates.Add((Get-Location).Path)
  $candidates.Add((Join-Path $env:USERPROFILE "SeekDeep-DiscordBot"))

  foreach ($candidate in $candidates) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      $index = Join-Path $candidate "index.js"
      $server = Join-Path $candidate "local_ai_server.py"
      if ((Test-Path -LiteralPath $index) -and (Test-Path -LiteralPath $server)) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }

  throw "Could not locate SeekDeep project root. Run this from C:\Users\natha\SeekDeep-DiscordBot or place it in C:\Users\natha\SeekDeep-DiscordBot\patches."
}

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory=$true)][string]$Label,
    [Parameter(Mandatory=$true)][scriptblock]$Command
  )

  Write-SeekDeepInfo "Running $Label"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }

  Write-SeekDeepPass "$Label passed"
}

try {
  $projectRoot = Resolve-SeekDeepRoot
  $indexPath = Join-Path $projectRoot "index.js"
  $serverPath = Join-Path $projectRoot "local_ai_server.py"
  $patchesDir = Join-Path $projectRoot "patches"
  $backupDir = Join-Path $patchesDir "backups"
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"

  New-Item -ItemType Directory -Path $patchesDir -Force | Out-Null
  New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

  Write-SeekDeepInfo "Project root: $projectRoot"

  $backupPath = Join-Path $backupDir "index.js.per-user-image-cooldown-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $patchPy = @'
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch_per_user_image_cooldown.py <index.js>")

path = Path(sys.argv[1])
raw = path.read_bytes()
newline = "\r\n" if b"\r\n" in raw else "\n"
text = raw.decode("utf-8-sig")
text = text.replace("\r\n", "\n").replace("\r", "\n")

def require_contains(haystack, needle, label):
    if needle not in haystack:
        raise SystemExit(f"Required anchor not found: {label}")

def replace_once(haystack, old, new, label):
    count = haystack.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one anchor for {label}, found {count}.")
    return haystack.replace(old, new, 1)

def insert_before(haystack, anchor, insertion, label):
    require_contains(haystack, anchor, label)
    return haystack.replace(anchor, insertion + "\n" + anchor, 1)

def insert_after(haystack, anchor, insertion, label):
    require_contains(haystack, anchor, label)
    return haystack.replace(anchor, anchor + "\n" + insertion, 1)

require_contains(text, "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START", "stabilized dispatcher marker")
require_contains(text, "function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract")
require_contains(text, "function isNaturalImagePrompt(prompt)", "natural image prompt detector")
require_contains(text, "client.on('messageCreate'", "message dispatcher")
require_contains(text, "const userId = message.author.id;", "message userId anchor")

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found")

cooldown_block = r"""
// SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START
const SEEKDEEP_IMAGE_USER_COOLDOWN_MS = Math.max(
  0,
  Number(process.env.SEEKDEEP_IMAGE_USER_COOLDOWN_SECONDS || '45') * 1000
);

const seekdeepImageUserCooldowns = new Map();

function seekdeepImageCooldownKeyFromSource(source) {
  return String(source?.author?.id || source?.user?.id || source?.member?.user?.id || 'unknown').trim() || 'unknown';
}

function seekdeepIsImageCooldownBypassed(source) {
  try {
    const member = source?.member;
    const permissions = member?.permissions;

    if (permissions && typeof permissions.has === 'function') {
      if (permissions.has('Administrator') || permissions.has('ManageGuild') || permissions.has('ManageMessages')) {
        return true;
      }
    }
  } catch {}

  return false;
}

function seekdeepCheckImageUserCooldown(source, now = Date.now()) {
  if (!SEEKDEEP_IMAGE_USER_COOLDOWN_MS) {
    return { allowed: true, remainingMs: 0, cooldownMs: 0, key: seekdeepImageCooldownKeyFromSource(source) };
  }

  if (seekdeepIsImageCooldownBypassed(source)) {
    return { allowed: true, remainingMs: 0, cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS, key: seekdeepImageCooldownKeyFromSource(source), bypassed: true };
  }

  const key = seekdeepImageCooldownKeyFromSource(source);
  const lastAt = Number(seekdeepImageUserCooldowns.get(key) || 0);
  const elapsed = now - lastAt;
  const remainingMs = SEEKDEEP_IMAGE_USER_COOLDOWN_MS - elapsed;

  if (lastAt && remainingMs > 0) {
    return {
      allowed: false,
      remainingMs,
      cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS,
      key,
    };
  }

  return {
    allowed: true,
    remainingMs: 0,
    cooldownMs: SEEKDEEP_IMAGE_USER_COOLDOWN_MS,
    key,
  };
}

function seekdeepClaimImageUserCooldown(source, now = Date.now()) {
  const check = seekdeepCheckImageUserCooldown(source, now);

  if (!check.allowed) return check;

  if (check.cooldownMs && !check.bypassed) {
    seekdeepImageUserCooldowns.set(check.key, now);
  }

  return check;
}

function seekdeepResetImageUserCooldown(source) {
  const key = seekdeepImageCooldownKeyFromSource(source);
  seekdeepImageUserCooldowns.delete(key);
}

function seekdeepImageCooldownReplyText(check) {
  const seconds = Math.max(1, Math.ceil(Number(check?.remainingMs || 0) / 1000));
  return `Image cooldown active. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

async function seekdeepReplyImageCooldown(source, check) {
  const content = seekdeepAppendResponseFooter(seekdeepImageCooldownReplyText(check), {
    startedAt: source?.__seekdeepRequestStartedAt,
    modelUsed: seekdeepNoModelLabel(),
  });

  if (typeof source?.reply === 'function') {
    return await source.reply({
      content,
      allowedMentions: { repliedUser: false },
      ephemeral: true,
    });
  }

  if (source?.channel && typeof source.channel.send === 'function') {
    return await source.channel.send({ content });
  }

  return null;
}
// SEEKDEEP_PER_USER_IMAGE_COOLDOWN_END
"""

if "SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START" not in text:
    # Prefer placing before queue helpers if available.
    if "function seekdeepEnqueueImageJob(job, runner)" in text:
        text = insert_before(
            text,
            "function seekdeepEnqueueImageJob(job, runner)",
            cooldown_block,
            "image queue helper insertion point",
        )
    else:
        text = insert_after(
            text,
            "const client = new Client",
            cooldown_block,
            "client insertion fallback",
        )

# Main natural image route cooldown.
natural_anchor = """    if (isNaturalImagePrompt(prompt)) {
      seekdeepLogRoute('image', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Queued local image generation.');
      const imagePrompt = prompt.replace(/^draw\\s+me\\s+/i, '').trim() || prompt;
      await handleImagePrompt(message, imagePrompt);
      return;
    }"""

natural_replacement = """    if (isNaturalImagePrompt(prompt)) {
      seekdeepLogRoute('image', prompt);
      const cooldown = seekdeepClaimImageUserCooldown(message);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(message, cooldown);
        return;
      }
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Queued local image generation.');
      const imagePrompt = prompt
        .replace(/^(?:draw|sketch|paint|illustrate|render)\\s+me\\s+/i, '')
        .replace(/^(?:draw|sketch|paint|illustrate|render)\\s+/i, '')
        .trim() || prompt;
      try {
        await handleImagePrompt(message, imagePrompt);
      } catch (err) {
        seekdeepResetImageUserCooldown(message);
        throw err;
      }
      return;
    }"""

if "seekdeepClaimImageUserCooldown(message)" not in text:
    text = replace_once(text, natural_anchor, natural_replacement, "natural image route cooldown")

# Text regenerate cooldown, if that patch exists.
regen_anchor = """    if (utilityKind === 'regenerate-image') {
      seekdeepLogRoute('regenerate-image', prompt);
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Regenerating latest cached image.');
      await seekdeepRegenerateLatestImageFromMessage(message);
      return;
    }"""

regen_replacement = """    if (utilityKind === 'regenerate-image') {
      seekdeepLogRoute('regenerate-image', prompt);
      const cooldown = seekdeepClaimImageUserCooldown(message);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(message, cooldown);
        return;
      }
      remember(key, 'user', prompt);
      remember(key, 'assistant', 'Regenerating latest cached image.');
      try {
        await seekdeepRegenerateLatestImageFromMessage(message);
      } catch (err) {
        seekdeepResetImageUserCooldown(message);
        throw err;
      }
      return;
    }"""

if "utilityKind === 'regenerate-image'" in text and "seekdeepRegenerateLatestImageFromMessage(message)" in text and "Regenerating latest cached image." in text:
    if "seekdeepClaimImageUserCooldown(message);\n      if (!cooldown.allowed)" not in text:
        text = replace_once(text, regen_anchor, regen_replacement, "text regenerate cooldown")

# Slash command / interaction image cooldown, if there is a direct interaction image branch.
# This is intentionally conservative: it only patches common, obvious direct /image handling.
interaction_patterns = [
    (
        """    if (commandName === 'image') {
      const prompt = interaction.options.getString('prompt', true);""",
        """    if (commandName === 'image') {
      const cooldown = seekdeepClaimImageUserCooldown(interaction);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(interaction, cooldown);
        return;
      }
      const prompt = interaction.options.getString('prompt', true);""",
        "slash image cooldown commandName image"
    ),
    (
        """    if (interaction.commandName === 'image') {
      const prompt = interaction.options.getString('prompt', true);""",
        """    if (interaction.commandName === 'image') {
      const cooldown = seekdeepClaimImageUserCooldown(interaction);
      if (!cooldown.allowed) {
        await seekdeepReplyImageCooldown(interaction, cooldown);
        return;
      }
      const prompt = interaction.options.getString('prompt', true);""",
        "slash image cooldown interaction.commandName image"
    ),
]

for old, new, label in interaction_patterns:
    if old in text and new not in text:
        text = replace_once(text, old, new, label)

# Help text, if recognizable.
if "Image cooldown:" not in text:
    for target in [
        "    'Buttons: Regenerate / Download / Archive',\n",
        "    'Text: @SEEKOTICS regenerate / regen',\n",
    ]:
        if target in text:
            text = text.replace(
                target,
                target + "    `Image cooldown: ${Math.round(SEEKDEEP_IMAGE_USER_COOLDOWN_MS / 1000)}s per user`,\n",
                1,
            )
            break

for needle, label in [
    ("SEEKDEEP_PER_USER_IMAGE_COOLDOWN_START", "per-user cooldown helper block"),
    ("const SEEKDEEP_IMAGE_USER_COOLDOWN_MS", "cooldown duration constant"),
    ("const seekdeepImageUserCooldowns = new Map();", "cooldown user map"),
    ("function seekdeepClaimImageUserCooldown", "cooldown claim helper"),
    ("function seekdeepReplyImageCooldown", "cooldown reply helper"),
    ("seekdeepClaimImageUserCooldown(message)", "message image route cooldown claim"),
    ("function seekdeepEnqueueImageJob(job, runner)", "correct image queue contract"),
]:
    require_contains(text, needle, label)

if "seekdeepMakeImageQueueJobId" in text:
    raise SystemExit("Unsafe old queue helper found after patch: seekdeepMakeImageQueueJobId")
if "job.run" in text:
    raise SystemExit("Unsafe job.run-style queue logic found after patch")

out = text if newline == "\n" else text.replace("\n", "\r\n")
path.write_bytes(out.encode("utf-8"))
print("Patched index.js with per-user image cooldown support.")
'@

  $patchPyPath = Join-Path $patchesDir "patch_per_user_image_cooldown.py"
  [System.IO.File]::WriteAllText($patchPyPath, $patchPy, [System.Text.UTF8Encoding]::new($false))
  Write-SeekDeepPass "Wrote UTF-8 patch helper to $patchPyPath"

  Push-Location $projectRoot
  try {
    Write-SeekDeepInfo "Applying per-user image cooldown patch"
    & ".\.venv\Scripts\python.exe" $patchPyPath $indexPath
    if ($LASTEXITCODE -ne 0) {
      throw "Python patch helper failed with exit code $LASTEXITCODE."
    }
    Write-SeekDeepPass "Applied per-user image cooldown patch"

    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }

    if (Test-Path ".\patches\apply_routing_regression_audit.ps1") {
      Write-SeekDeepInfo "Running existing routing regression audit"
      & ".\patches\apply_routing_regression_audit.ps1"
      if ($LASTEXITCODE -ne 0) {
        throw "Existing routing regression audit failed with exit code $LASTEXITCODE."
      }
      Write-SeekDeepPass "Existing routing regression audit passed"
    } else {
      Write-SeekDeepInfo "Routing regression audit script not found; skipped optional audit."
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Host "SeekDeep per-user image cooldown patch completed successfully." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Green
  Write-Host "Default cooldown: 45 seconds per user" -ForegroundColor Yellow
  Write-Host "Optional .env setting: SEEKDEEP_IMAGE_USER_COOLDOWN_SECONDS=30" -ForegroundColor Yellow
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "index.js backup is available here if you need to restore:" -ForegroundColor Yellow
  if ($backupPath) {
    Write-Host $backupPath -ForegroundColor Yellow
  }
  exit 1
}
