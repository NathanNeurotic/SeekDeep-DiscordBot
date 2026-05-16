# repair_seekdeep_ephemeral_flags_v1.ps1
# Purpose: Modernize Discord interaction ephemeral responses from deprecated `ephemeral: true`
# to flags-based MessageFlags.Ephemeral usage, with backup and validation.

param(
  [string]$ProjectRoot = "C:\Users\natha\SeekDeep-DiscordBot"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step([string]$Message) {
  Write-Host "[seekdeep-ephemeral-flags-v1] $Message"
}

$IndexPath = Join-Path $ProjectRoot "index.js"
$PythonPath = Join-Path $ProjectRoot "local_ai_server.py"
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$PatchDir = Join-Path $ProjectRoot "patches"
$BackupDir = Join-Path $ProjectRoot "backups"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupPath = Join-Path $BackupDir "index.js.before-ephemeral-flags-v1-$Timestamp.bak"
$PatchJsPath = Join-Path $PatchDir "apply_ephemeral_flags_v1.cjs"

if (!(Test-Path -LiteralPath $ProjectRoot)) {
  throw "Project root not found: $ProjectRoot"
}
if (!(Test-Path -LiteralPath $IndexPath)) {
  throw "index.js not found: $IndexPath"
}

New-Item -ItemType Directory -Path $PatchDir -Force | Out-Null
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

Write-Step "Creating backup: $BackupPath"
Copy-Item -LiteralPath $IndexPath -Destination $BackupPath -Force

$PatchJs = @'
const fs = require('fs');
const indexPath = process.argv[2];
if (!indexPath) {
  throw new Error('Missing index.js path argument.');
}

let text = fs.readFileSync(indexPath, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';

function block(lines) {
  return lines.join(eol);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function replaceExact(label, before, after, expected = 1) {
  const count = countOccurrences(text, before);
  if (count !== expected) {
    throw new Error(`${label}: expected ${expected} occurrence(s), found ${count}`);
  }
  text = text.split(before).join(after);
}

const beforeCount = countOccurrences(text, 'ephemeral: true');
if (beforeCount !== 11) {
  throw new Error(`Baseline guard failed: expected 11 deprecated ephemeral usages, found ${beforeCount}. Do not stack this patch blindly; use a fresh checkpoint or inspect the current tree.`);
}

if (!text.includes('  MessageFlags,')) {
  replaceExact(
    'import MessageFlags',
    block([
      '  GatewayIntentBits,',
      '  Partials,',
    ]),
    block([
      '  GatewayIntentBits,',
      '  MessageFlags,',
      '  Partials,',
    ])
  );
}

if (!text.includes('// SEEKDEEP_EPHEMERAL_FLAGS_START')) {
  const anchor = 'const MAX_DISCORD_CHARS = Number(process.env.MAX_DISCORD_CHARS || 1900);';
  if (!text.includes(anchor + eol)) {
    throw new Error('Helper anchor not found after MAX_DISCORD_CHARS.');
  }

  const helper = block([
    '',
    '// SEEKDEEP_EPHEMERAL_FLAGS_START',
    'function seekdeepIsInteractionLikeTarget(target) {',
    '  return !!(',
    '    target &&',
    '    !target.author &&',
    '    (',
    "      typeof target.deferReply === 'function' ||",
    "      typeof target.followUp === 'function' ||",
    "      typeof target.editReply === 'function' ||",
    "      typeof target.isRepliable === 'function' ||",
    "      Object.prototype.hasOwnProperty.call(target, 'deferred') ||",
    "      Object.prototype.hasOwnProperty.call(target, 'replied')",
    '    )',
    '  );',
    '}',
    '',
    'function seekdeepEphemeralPayload(payload = {}) {',
    '  const next = { ...payload };',
    '  delete next.ephemeral;',
    '  next.flags = MessageFlags.Ephemeral;',
    '  return next;',
    '}',
    '',
    'function seekdeepMaybeEphemeralPayload(target, payload = {}) {',
    '  const next = { ...payload };',
    '  delete next.ephemeral;',
    '  if (seekdeepIsInteractionLikeTarget(target)) {',
    '    next.flags = MessageFlags.Ephemeral;',
    '  }',
    '  return next;',
    '}',
    '// SEEKDEEP_EPHEMERAL_FLAGS_END'
  ]);

  text = text.replace(anchor + eol, anchor + eol + helper + eol);
}

replaceExact(
  'prompt choice private followUp',
  block([
    '      await interaction.followUp({',
    '        content,',
    '        ephemeral: true,',
    '      });',
  ]),
  block([
    '      await interaction.followUp(seekdeepEphemeralPayload({',
    '        content,',
    '      }));',
  ])
);

replaceExact(
  'regenerate cooldown followUp',
  block([
    '      return await source.followUp({',
    '        content,',
    '        ephemeral: true,',
    '      });',
  ]),
  block([
    '      return await source.followUp(seekdeepEphemeralPayload({',
    '        content,',
    '      }));',
  ]),
  2
);

replaceExact(
  'regenerate job ambiguous reply',
  block([
    '      return await source.reply({',
    '        content,',
    '        allowedMentions: { repliedUser: false },',
    '        ephemeral: true,',
    '      });',
  ]),
  block([
    '      return await source.reply(seekdeepMaybeEphemeralPayload(source, {',
    '        content,',
    '        allowedMentions: { repliedUser: false },',
    '      }));',
  ])
);

replaceExact(
  'button cooldown fallback payload',
  block([
    '          const payload = {',
    '            content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(remaining), {',
    '              startedAt,',
    '              modelUsed: seekdeepNoModelLabel(),',
    '            }),',
    '            ephemeral: true,',
    '          };',
    '          if (interaction?.replied || interaction?.deferred) {',
    '            await interaction.editReply(payload);',
    '          } else {',
    '            await interaction.reply(payload);',
    '          }',
  ]),
  block([
    '          const payload = {',
    '            content: seekdeepAppendResponseFooter(seekdeepImageCooldownText(remaining), {',
    '              startedAt,',
    '              modelUsed: seekdeepNoModelLabel(),',
    '            }),',
    '          };',
    '          if (interaction?.replied || interaction?.deferred) {',
    '            await interaction.editReply(payload);',
    '          } else {',
    '            await interaction.reply(seekdeepEphemeralPayload(payload));',
    '          }',
  ])
);

replaceExact(
  'interaction deferReply ephemeral flags',
  '    await interaction.deferReply({ ephemeral: true });',
  '    await interaction.deferReply({ flags: MessageFlags.Ephemeral });',
  2
);

replaceExact(
  'emergency prompt choice private followUp',
  '      await interaction.followUp({ content, ephemeral: true });',
  '      await interaction.followUp(seekdeepEphemeralPayload({ content }));'
);

replaceExact(
  'image button failure reply handlers',
  block([
    '        await interaction.reply({',
    '          content: `Image button failed.\\n\\nError:\\n${err?.message || err}`,',
    '          ephemeral: true,',
    '        });',
  ]),
  block([
    '        await interaction.reply(seekdeepEphemeralPayload({',
    '          content: `Image button failed.\\n\\nError:\\n${err?.message || err}`,',
    '        }));',
  ]),
  2
);

replaceExact(
  'emergency regenerate cooldown fallback payload',
  block([
    '          const payload = {',
    "            content: typeof seekdeepAppendResponseFooter === 'function'",
    '              ? seekdeepAppendResponseFooter(',
    "                  typeof seekdeepImageCooldownText === 'function' ? seekdeepImageCooldownText(remaining) : `Image generation cooldown is active. Try again in ${remaining.toFixed ? remaining.toFixed(1) : remaining} seconds.`,",
    '                  {',
    '                    startedAt,',
    "                    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',",
    '                  }',
    '                )',
    '              : `Image generation cooldown is active. Try again in ${remaining} seconds.`,',
    '            ephemeral: true,',
    '          };',
    '',
    '          if (interaction?.replied || interaction?.deferred) {',
    '            await interaction.editReply(payload);',
    '          } else {',
    '            await interaction.reply(payload);',
    '          }',
  ]),
  block([
    '          const payload = {',
    "            content: typeof seekdeepAppendResponseFooter === 'function'",
    '              ? seekdeepAppendResponseFooter(',
    "                  typeof seekdeepImageCooldownText === 'function' ? seekdeepImageCooldownText(remaining) : `Image generation cooldown is active. Try again in ${remaining.toFixed ? remaining.toFixed(1) : remaining} seconds.`,",
    '                  {',
    '                    startedAt,',
    "                    modelUsed: typeof seekdeepNoModelLabel === 'function' ? seekdeepNoModelLabel() : 'local command (no AI model)',",
    '                  }',
    '                )',
    '              : `Image generation cooldown is active. Try again in ${remaining} seconds.`,',
    '          };',
    '',
    '          if (interaction?.replied || interaction?.deferred) {',
    '            await interaction.editReply(payload);',
    '          } else {',
    '            await interaction.reply(seekdeepEphemeralPayload(payload));',
    '          }',
  ])
);

const afterCount = countOccurrences(text, 'ephemeral: true');
if (afterCount !== 0) {
  throw new Error(`Patch incomplete: ${afterCount} deprecated ephemeral usage(s) remain.`);
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log(`Patched ${indexPath}. Removed ${beforeCount} deprecated ephemeral usage(s).`);
'@

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($PatchJsPath, $PatchJs, $Utf8NoBom)

Push-Location $ProjectRoot
try {
  Write-Step "Applying bounded patch to index.js"
  & node $PatchJsPath $IndexPath
  if ($LASTEXITCODE -ne 0) { throw "Node patcher failed with exit code $LASTEXITCODE" }

  Write-Step "Running JS syntax validation: node --check .\index.js"
  & node --check ".\index.js"
  if ($LASTEXITCODE -ne 0) { throw "node --check failed with exit code $LASTEXITCODE" }

  if (Test-Path -LiteralPath $PythonPath) {
    if (Test-Path -LiteralPath $VenvPython) {
      Write-Step "Running Python compile validation: .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py"
      & $VenvPython -m py_compile ".\local_ai_server.py"
      if ($LASTEXITCODE -ne 0) { throw "Python compile check failed with exit code $LASTEXITCODE" }
    } else {
      Write-Warning "Skipped Python compile check because venv Python was not found: $VenvPython"
    }
  }

  Write-Step "Verifying deprecated ephemeral usage count is zero"
  $Remaining = Select-String -LiteralPath $IndexPath -Pattern "ephemeral:\s*true" -AllMatches -ErrorAction SilentlyContinue
  if ($Remaining) {
    throw "Deprecated ephemeral usage remains in index.js. Restore backup and inspect manually."
  }

  Write-Step "Patch complete. Backup kept at: $BackupPath"
  Write-Step "Next: restart the bot and confirm the deprecated ephemeral warning is gone."
}
catch {
  Write-Host "[seekdeep-ephemeral-flags-v1] Patch failed: $($_.Exception.Message)" -ForegroundColor Red
  if (Test-Path -LiteralPath $BackupPath) {
    Write-Step "Restoring index.js from backup: $BackupPath"
    Copy-Item -LiteralPath $BackupPath -Destination $IndexPath -Force
  }
  Pop-Location
  exit 1
}

Pop-Location
exit 0
