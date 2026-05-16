# SeekDeep / Seekotics routing regression audit
# Non-invasive checkpoint guard.
# - Backs up index.js first.
# - Does not edit index.js or local_ai_server.py.
# - Audits stabilized dispatcher, archive routing, draw-me routing, dedupe exemption, and queue API.
# - Runs required syntax checks:
#     node --check .\index.js
#     .\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

$ErrorActionPreference = "Stop"

try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

function Write-SeekDeepInfo {
  param([string]$Message)
  Write-Host "[SeekDeep audit] $Message" -ForegroundColor Cyan
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

  throw "Could not locate SeekDeep project root. Run this script from C:\Users\natha\SeekDeep-DiscordBot or place it in C:\Users\natha\SeekDeep-DiscordBot\patches."
}

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if (-not $Condition) {
    throw $Message
  }

  Write-SeekDeepPass $Message
}

function Assert-Contains {
  param(
    [string]$Text,
    [string]$Needle,
    [string]$Message
  )

  if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -lt 0) {
    throw $Message
  }

  Write-SeekDeepPass $Message
}

function Assert-NotContains {
  param(
    [string]$Text,
    [string]$Needle,
    [string]$Message
  )

  if ($Text.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0) {
    throw $Message
  }

  Write-SeekDeepPass $Message
}

function Assert-Regex {
  param(
    [string]$Text,
    [string]$Pattern,
    [string]$Message
  )

  if (-not ([regex]::IsMatch($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline))) {
    throw $Message
  }

  Write-SeekDeepPass $Message
}

function Assert-Order {
  param(
    [string]$Text,
    [string[]]$Needles,
    [string]$Message
  )

  $cursor = -1
  foreach ($needle in $Needles) {
    $next = $Text.IndexOf($needle, $cursor + 1, [System.StringComparison]::Ordinal)
    if ($next -lt 0) {
      throw "$Message Missing ordered marker: $needle"
    }
    if ($next -le $cursor) {
      throw "$Message Marker out of order: $needle"
    }
    $cursor = $next
  }

  Write-SeekDeepPass $Message
}

function Get-JsMatchingDelimiterIndex {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [Parameter(Mandatory=$true)][int]$OpenIndex,
    [Parameter(Mandatory=$true)][char]$OpenChar,
    [Parameter(Mandatory=$true)][char]$CloseChar
  )

  $depth = 0
  $inSingle = $false
  $inDouble = $false
  $inTemplate = $false
  $inLineComment = $false
  $inBlockComment = $false
  $escape = $false
  $slash = [char]47
  $single = [char]39
  $double = [char]34
  $backtick = [char]96
  $backslash = [char]92
  $asterisk = [char]42
  $newline = [char]10
  $cr = [char]13

  for ($i = $OpenIndex; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    $n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment) {
      if ($c -eq $newline -or $c -eq $cr) { $inLineComment = $false }
      continue
    }

    if ($inBlockComment) {
      if ($c -eq $asterisk -and $n -eq $slash) {
        $inBlockComment = $false
        $i++
      }
      continue
    }

    if ($inSingle) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $single) {
        $inSingle = $false
      }
      continue
    }

    if ($inDouble) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $double) {
        $inDouble = $false
      }
      continue
    }

    if ($inTemplate) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $backtick) {
        $inTemplate = $false
      }
      continue
    }

    if ($c -eq $slash -and $n -eq $slash) {
      $inLineComment = $true
      $i++
      continue
    }

    if ($c -eq $slash -and $n -eq $asterisk) {
      $inBlockComment = $true
      $i++
      continue
    }

    if ($c -eq $single) {
      $inSingle = $true
      continue
    }

    if ($c -eq $double) {
      $inDouble = $true
      continue
    }

    if ($c -eq $backtick) {
      $inTemplate = $true
      continue
    }

    if ($c -eq $OpenChar) {
      $depth++
      continue
    }

    if ($c -eq $CloseChar) {
      $depth--
      if ($depth -eq 0) {
        return $i
      }
      continue
    }
  }

  throw "Could not find matching '$CloseChar' for '$OpenChar' at index $OpenIndex."
}

function Find-NextJsCodeCharIndex {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [Parameter(Mandatory=$true)][int]$StartIndex,
    [Parameter(Mandatory=$true)][char]$TargetChar
  )

  $inSingle = $false
  $inDouble = $false
  $inTemplate = $false
  $inLineComment = $false
  $inBlockComment = $false
  $escape = $false
  $slash = [char]47
  $single = [char]39
  $double = [char]34
  $backtick = [char]96
  $backslash = [char]92
  $asterisk = [char]42
  $newline = [char]10
  $cr = [char]13

  for ($i = $StartIndex; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    $n = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment) {
      if ($c -eq $newline -or $c -eq $cr) { $inLineComment = $false }
      continue
    }

    if ($inBlockComment) {
      if ($c -eq $asterisk -and $n -eq $slash) {
        $inBlockComment = $false
        $i++
      }
      continue
    }

    if ($inSingle) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $single) {
        $inSingle = $false
      }
      continue
    }

    if ($inDouble) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $double) {
        $inDouble = $false
      }
      continue
    }

    if ($inTemplate) {
      if ($escape) {
        $escape = $false
      } elseif ($c -eq $backslash) {
        $escape = $true
      } elseif ($c -eq $backtick) {
        $inTemplate = $false
      }
      continue
    }

    if ($c -eq $slash -and $n -eq $slash) {
      $inLineComment = $true
      $i++
      continue
    }

    if ($c -eq $slash -and $n -eq $asterisk) {
      $inBlockComment = $true
      $i++
      continue
    }

    if ($c -eq $single) {
      $inSingle = $true
      continue
    }

    if ($c -eq $double) {
      $inDouble = $true
      continue
    }

    if ($c -eq $backtick) {
      $inTemplate = $true
      continue
    }

    if ($c -eq $TargetChar) {
      return $i
    }
  }

  throw "Could not find code char '$TargetChar' after index $StartIndex."
}

function Get-NamedJsFunctionText {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [Parameter(Mandatory=$true)][string]$FunctionName
  )

  $escaped = [regex]::Escape($FunctionName)
  $pattern = "(?m)(?:async\s+)?function\s+$escaped\s*\("
  $match = [regex]::Match($Text, $pattern)
  if (-not $match.Success) {
    throw "Could not find JavaScript function: $FunctionName"
  }

  $openParen = $Text.IndexOf("(", $match.Index, [System.StringComparison]::Ordinal)
  if ($openParen -lt 0) {
    throw "Could not find parameter list for JavaScript function: $FunctionName"
  }

  $closeParen = Get-JsMatchingDelimiterIndex -Text $Text -OpenIndex $openParen -OpenChar ([char]40) -CloseChar ([char]41)
  $openBrace = Find-NextJsCodeCharIndex -Text $Text -StartIndex ($closeParen + 1) -TargetChar ([char]123)
  $closeBrace = Get-JsMatchingDelimiterIndex -Text $Text -OpenIndex $openBrace -OpenChar ([char]123) -CloseChar ([char]125)

  return $Text.Substring($match.Index, ($closeBrace - $match.Index + 1))
}

function Get-JsBlockAfterLiteral {
  param(
    [Parameter(Mandatory=$true)][string]$Text,
    [Parameter(Mandatory=$true)][string]$Literal,
    [Parameter(Mandatory=$true)][string]$Label
  )

  $idx = $Text.IndexOf($Literal, [System.StringComparison]::Ordinal)
  if ($idx -lt 0) {
    throw "Could not find block anchor: $Label"
  }

  $openBrace = Find-NextJsCodeCharIndex -Text $Text -StartIndex $idx -TargetChar ([char]123)
  $closeBrace = Get-JsMatchingDelimiterIndex -Text $Text -OpenIndex $openBrace -OpenChar ([char]123) -CloseChar ([char]125)

  return $Text.Substring($openBrace, ($closeBrace - $openBrace + 1))
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

  $backupPath = Join-Path $backupDir "index.js.routing-regression-audit-$stamp.bak"
  Copy-Item -LiteralPath $indexPath -Destination $backupPath -Force
  Write-SeekDeepPass "Backed up index.js to $backupPath"

  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $indexText = [System.IO.File]::ReadAllText($indexPath, $utf8NoBom)
  $serverText = [System.IO.File]::ReadAllText($serverPath, $utf8NoBom)

  Write-SeekDeepInfo "Auditing stabilized dispatcher and routing invariants"

  Assert-Contains $indexText "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_START" "Stabilized dispatcher helper marker is present"
  Assert-Contains $indexText "SEEKDEEP_STABILIZED_DISPATCH_HELPERS_END" "Stabilized dispatcher helper end marker is present"
  Assert-Contains $indexText "SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_START" "Hard-command dedupe exemption marker is present"
  Assert-Contains $indexText "SEEKDEEP_HARD_COMMAND_DEDUPE_EXEMPT_END" "Hard-command dedupe exemption end marker is present"

  $utilityFn = Get-NamedJsFunctionText -Text $indexText -FunctionName "seekdeepUtilityPromptKind"
  Assert-Contains $utilityFn "return 'post-archive'" "post archive maps to utility kind before model routing"
  Assert-Contains $utilityFn "isPostArchivePrompt" "post archive uses existing archive prompt detector when available"
  Assert-Regex $utilityFn "\^\(post\|show\|dump\|upload\|send\).*archive" "post/show/dump/upload/send archive fallback regex is present"
  Assert-Regex $utilityFn "\^\(queue\|que\)\\s\+status" "queue status typo route remains present"

  $dedupeFn = Get-NamedJsFunctionText -Text $indexText -FunctionName "seekdeepIsPromptDedupeExempt"
  Assert-Contains $dedupeFn "seekdeepUtilityPromptKind" "hard-command dedupe exemption delegates to utility prompt routing"
  Assert-Contains $dedupeFn "queue|que" "hard-command dedupe exemption includes queue/que status"
  Assert-Contains $dedupeFn "post" "hard-command dedupe exemption includes post archive fallback"
  Assert-Contains $dedupeFn "recent" "hard-command dedupe exemption includes recent image/prompt commands"

  $explicitImageFn = Get-NamedJsFunctionText -Text $indexText -FunctionName "seekdeepHasExplicitImageRequest"
  Assert-Regex $explicitImageFn "draw\|sketch\|paint\|illustrate" "explicit image trigger includes draw/sketch/paint/illustrate"
  Assert-Regex $explicitImageFn "\\s\+me\\s\+" "explicit image trigger includes draw-me style wording"

  $naturalImageFn = Get-NamedJsFunctionText -Text $indexText -FunctionName "isNaturalImagePrompt"
  Assert-Contains $naturalImageFn "seekdeepHasExplicitImageRequest" "natural image prompt routing delegates to explicit image trigger"

  $dispatcher = Get-JsBlockAfterLiteral -Text $indexText -Literal "client.on('messageCreate'" -Label "messageCreate dispatcher"
  Assert-Contains $dispatcher "const utilityKind = seekdeepUtilityPromptKind(prompt);" "dispatcher computes utilityKind once before AI routing"
  Assert-Contains $dispatcher "if (utilityKind === 'post-archive')" "dispatcher has dedicated post-archive branch"
  Assert-Contains $dispatcher "await seekdeepPostArchiveFromMessage(message);" "post archive branch calls archive poster directly"
  Assert-Contains $dispatcher "if (isNaturalImagePrompt(prompt))" "dispatcher has natural image branch"
  Assert-Contains $dispatcher "seekdeepLogRoute('chat', prompt);" "dispatcher still has chat fallback"
  Assert-Order $dispatcher @(
    "const utilityKind = seekdeepUtilityPromptKind(prompt);",
    "if (utilityKind === 'post-archive')",
    "if (utilityKind)",
    "if (isNaturalStatusPrompt(prompt) || isExplicitStatusRequest(prompt))",
    "if (shouldUseVision)",
    "if (isNaturalImagePrompt(prompt))",
    "seekdeepLogRoute('chat', prompt);"
  ) "dispatcher route order keeps hard commands before status/vision/image/chat"
  Assert-Regex $dispatcher "!seekdeepIsPromptDedupeExempt\(prompt\).*seekdeepClaimPromptOnce" "prompt dedupe is bypassed for hard commands"

  Assert-Contains $indexText "function seekdeepEnqueueImageJob(job, runner)" "correct image queue contract is present: seekdeepEnqueueImageJob(job, runner)"
  Assert-NotContains $indexText "seekdeepMakeImageQueueJobId" "old broken queue helper is absent"
  Assert-NotContains $indexText "job.run" "job.run-style queue logic is absent"

  Assert-Regex $serverText "num_inference_steps\s*=\s*2|`"num_inference_steps`"\s*:\s*2|'num_inference_steps'\s*:\s*2" "Sana Sprint two-step image-generation rule is present in local_ai_server.py"

  Push-Location $projectRoot
  try {
    Invoke-CheckedCommand "node --check .\index.js" {
      & node --check ".\index.js"
    }

    Invoke-CheckedCommand ".\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py" {
      & ".\.venv\Scripts\python.exe" -m py_compile ".\local_ai_server.py"
    }
  } finally {
    Pop-Location
  }

  Write-Host ""
  Write-Host "SeekDeep routing regression audit completed successfully." -ForegroundColor Green
  Write-Host "No runtime files were modified." -ForegroundColor Green
  Write-Host "Backup created: $backupPath" -ForegroundColor Green
  exit 0
} catch {
  Write-Host ""
  Write-SeekDeepFail $_.Exception.Message
  Write-Host "No runtime files were intentionally modified. If a future edit script failed, restore from the backup printed above or from patches/backups." -ForegroundColor Yellow
  exit 1
}
