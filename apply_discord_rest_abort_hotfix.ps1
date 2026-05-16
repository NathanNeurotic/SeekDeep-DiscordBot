$ErrorActionPreference = "Stop"
cd "$env:USERPROFILE\SeekDeep-DiscordBot"

$pyExe = ".\.venv\Scripts\python.exe"
if (!(Test-Path $pyExe)) { $pyExe = "python" }

@'
from pathlib import Path
from datetime import datetime
import re

path = Path('index.js')
text = path.read_text(encoding='utf-8-sig')

stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
backup = Path(f'index.js.bak-discord-rest-abort-hotfix-{stamp}')
backup.write_text(text, encoding='utf-8')
print(f'[SeekDeep] Backup written: {backup}')

client_old = '''const client = new Client({
  intents: ['''
client_new = '''const client = new Client({
  rest: {
    timeout: Math.max(15000, Number(process.env.DISCORD_REST_TIMEOUT_MS || 120000)),
    retries: Math.max(0, Number(process.env.DISCORD_REST_RETRIES || 3)),
  },
  intents: ['''

if client_old in text and "DISCORD_REST_TIMEOUT_MS" not in text:
    text = text.replace(client_old, client_new, 1)
    print('[SeekDeep] Added Discord REST timeout/retry options.')
elif "DISCORD_REST_TIMEOUT_MS" in text:
    print('[SeekDeep] Discord REST timeout options already present.')
else:
    raise SystemExit('Could not find Discord client constructor anchor.')

helpers = r'''
// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_START
function seekdeepIsDiscordAbortError(err) {
  const name = String(err?.name || err?.constructor?.name || '');
  const message = String(err?.message || err || '');
  const stack = String(err?.stack || '');

  return (
    name === 'AbortError' ||
    message.includes('This operation was aborted') ||
    message.toLowerCase().includes('aborterror') ||
    (stack.includes('@discordjs/rest') && stack.includes('AbortController.abort'))
  );
}

function seekdeepLogDiscordAbort(label, err) {
  const message = String(err?.message || err || 'Discord REST request aborted');
  console.warn(`[SeekDeep] ${label}: ${message}. Continuing; Discord API request timed out or was aborted.`);
}
// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_END
'''

if '// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_START' in text:
    start = text.find('// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_START')
    end = text.find('// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_END', start)

    if end == -1:
        raise SystemExit('Found abort hotfix start marker but no end marker.')

    end += len('// SEEKDEEP_DISCORD_REST_ABORT_HOTFIX_END')
    text = text[:start] + helpers.strip() + '\n\n' + text[end:].lstrip()
    print('[SeekDeep] Replaced abort hotfix helpers.')
else:
    anchor = "if (!TOKEN) {"
    pos = text.find(anchor)

    if pos == -1:
        raise SystemExit('Could not find TOKEN check anchor for abort helpers.')

    text = text[:pos] + helpers.strip() + '\n\n' + text[pos:]
    print('[SeekDeep] Inserted abort hotfix helpers.')

unhandled_pat = re.compile(r"process\.on\('unhandledRejection', \(err\) => \{[\s\S]*?\n\}\);", re.M)
unhandled_new = r'''process.on('unhandledRejection', (err) => {
  if (seekdeepIsDiscordAbortError(err)) {
    seekdeepLogDiscordAbort('Unhandled Discord REST abort', err);
    return;
  }

  console.error('Unhandled promise rejection:', err);
});'''

text, count = unhandled_pat.subn(unhandled_new, text, count=1)
if count != 1:
    raise SystemExit('Could not replace unhandledRejection handler.')

print('[SeekDeep] Replaced unhandledRejection handler.')

uncaught_pat = re.compile(r"process\.on\('uncaughtException', \(err\) => \{[\s\S]*?\n\}\);", re.M)
uncaught_new = r'''process.on('uncaughtException', (err) => {
  if (seekdeepIsDiscordAbortError(err)) {
    seekdeepLogDiscordAbort('Uncaught Discord REST abort', err);
    return;
  }

  console.error('Uncaught exception:', err);
});'''

text, count = uncaught_pat.subn(uncaught_new, text, count=1)
if count != 1:
    raise SystemExit('Could not replace uncaughtException handler.')

print('[SeekDeep] Replaced uncaughtException handler.')

safe_old = '''  } catch (err) {
    console.error('Could not send interaction response:', err);
    return null;
  }
}'''
safe_new = '''  } catch (err) {
    if (seekdeepIsDiscordAbortError(err)) {
      seekdeepLogDiscordAbort('Could not send interaction response', err);
    } else {
      console.error('Could not send interaction response:', err);
    }
    return null;
  }
}'''

if safe_old in text:
    text = text.replace(safe_old, safe_new, 1)
    print('[SeekDeep] Patched safeEditOrReply abort logging.')
else:
    print('[SeekDeep] safeEditOrReply exact catch block not found; skipped.')

message_result_old = '''    let sent = await message.reply({
      content,
      files: [normalized.attachment],
      components: [seekdeepImageActionRow(actionId)],
      allowedMentions: { repliedUser: false },
    });'''
message_result_new = '''    let sent = null;

    try {
      sent = await message.reply({
        content,
        files: [normalized.attachment],
        components: [seekdeepImageActionRow(actionId)],
        allowedMentions: { repliedUser: false },
      });
    } catch (err) {
      if (seekdeepIsDiscordAbortError(err)) {
        seekdeepLogDiscordAbort('Image result reply failed', err);
      } else {
        throw err;
      }
    }'''

if message_result_old in text:
    text = text.replace(message_result_old, message_result_new, 1)
    print('[SeekDeep] Patched queued message image result reply.')
else:
    print('[SeekDeep] queued message image result reply block not found; skipped.')

regen_old = '''        sent = await interaction.channel.send({
          content: seekdeepAppendResponseFooter([
            `Regenerated locally: ${state.prompt}`,
            `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
            `Job ID: ${runningJob.id}`,
          ].join('\\n'), {
            startedAt: runningJob.startedAt,
            modelUsed: seekdeepImageModelLabel(),
          }),
          files: [normalized.attachment],
          components: [seekdeepImageActionRow(newState.id)],
        });'''
regen_new = '''        try {
          sent = await interaction.channel.send({
            content: seekdeepAppendResponseFooter([
              `Regenerated locally: ${state.prompt}`,
              `Queue Wait: ${seekdeepImageQueueWaitSeconds(runningJob)} seconds`,
              `Job ID: ${runningJob.id}`,
            ].join('\\n'), {
              startedAt: runningJob.startedAt,
              modelUsed: seekdeepImageModelLabel(),
            }),
            files: [normalized.attachment],
            components: [seekdeepImageActionRow(newState.id)],
          });
        } catch (err) {
          if (seekdeepIsDiscordAbortError(err)) {
            seekdeepLogDiscordAbort('Regenerated image channel send failed', err);
          } else {
            throw err;
          }
        }'''

if regen_old in text:
    text = text.replace(regen_old, regen_new, 1)
    print('[SeekDeep] Patched queued regenerate channel send.')
else:
    print('[SeekDeep] queued regenerate channel send block not found; skipped.')

required = [
    'DISCORD_REST_TIMEOUT_MS',
    'function seekdeepIsDiscordAbortError(',
    "process.on('unhandledRejection'",
    "process.on('uncaughtException'",
]

missing = [item for item in required if item not in text]
if missing:
    raise SystemExit('Patch failed. Missing: ' + ', '.join(missing))

path.write_text(text, encoding='utf-8')
print('[SeekDeep] Discord REST abort hotfix written.')
'@ | Set-Content .\patch_discord_rest_abort_hotfix.py -Encoding UTF8

& $pyExe .\patch_discord_rest_abort_hotfix.py

node --check .\index.js
.\.venv\Scripts\python.exe -m py_compile .\local_ai_server.py

Write-Host ""
Write-Host "[SeekDeep] Discord REST abort hotfix complete. Restart with launcher option 8." -ForegroundColor Green
