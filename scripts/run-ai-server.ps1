# SeekDeep AI-server supervisor.
#
# Runs `python local_ai_server.py` and RESTARTS it if it crashes or if the
# server's in-process loop-watchdog force-exits a wedge (exit code 70). This is
# the external half of the self-healing pair: the server detects its own wedge
# and exits; this loop brings it back. Backs off and gives up after repeated
# RAPID crashes so a fatal config error doesn't spin forever.
#
# Launched by seekdeep_launcher.bat (replaces the inline one-shot python call).
# Escape hatch: set SEEKDEEP_NO_SERVER_SUPERVISOR=1 to run python once, no restart.

$ErrorActionPreference = 'Continue'

# Repo root = parent of this script's dir, regardless of the caller's cwd.
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo

# Activate the project venv if present (matches the old launcher behaviour).
$activate = Join-Path $repo '.venv\Scripts\Activate.ps1'
if (Test-Path -LiteralPath $activate) {
    try { . $activate } catch { Write-Host "[launcher] venv activate skipped: $($_.Exception.Message)" }
}

# Record THIS supervisor's PID (parity with the previous launcher, which wrote
# the PowerShell PID) so the launcher's stale-server cleanup can find it.
try { $PID | Set-Content -LiteralPath (Join-Path $repo 'logs\local-ai.pid') } catch {}

$bypass = @('1', 'true', 'yes', 'on') -contains ("$env:SEEKDEEP_NO_SERVER_SUPERVISOR").Trim().ToLower()
if ($bypass) {
    python local_ai_server.py
    exit $LASTEXITCODE
}

$fails = 0
while ($true) {
    $t0 = Get-Date
    python local_ai_server.py
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        Write-Host '[launcher] AI server exited cleanly (code 0) - not restarting.'
        break
    }
    $ran = ((Get-Date) - $t0).TotalSeconds
    if ($ran -lt 15) { $fails++ } else { $fails = 0 }
    if ($fails -ge 5) {
        Write-Host '[launcher] AI server crash-looped 5x in under 15s - stopping supervisor. Check logs\local-ai.err.log for the cause.'
        break
    }
    Write-Host ("[launcher] AI server exited (code {0}) after {1}s - restarting in 3s (fail streak {2}/5)..." -f $code, [int]$ran, $fails)
    Start-Sleep -Seconds 3
}
