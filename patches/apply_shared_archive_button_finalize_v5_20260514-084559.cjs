const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function findBalancedEnd(src, openIndex, openChar, closeChar) {
  let i = openIndex;
  let depth = 0;
  let state = 'code';
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (ch === openChar) depth += 1;
      else if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) return i;
      } else if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (ch === '/' && next === '/') { state = 'linecomment'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'blockcomment'; i += 1; }
    } else if (state === 'single') {
      if (ch === '\\') i += 1;
      else if (ch === "'") state = 'code';
    } else if (state === 'double') {
      if (ch === '\\') i += 1;
      else if (ch === '"') state = 'code';
    } else if (state === 'template') {
      if (ch === '\\') i += 1;
      else if (ch === '`') state = 'code';
    } else if (state === 'linecomment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'blockcomment') {
      if (ch === '*' && next === '/') { state = 'code'; i += 1; }
    }
    i += 1;
  }
  return -1;
}

function findFunctionRange(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const braceStart = src.indexOf('{', m.index + m[0].length - 1);
  if (braceStart < 0) throw new Error('Could not find opening brace for ' + name);
  const braceEnd = findBalancedEnd(src, braceStart, '{', '}');
  if (braceEnd < 0) throw new Error('Could not find closing brace for ' + name);
  return { start: m.index, end: braceEnd + 1 };
}

function replaceFunction(name, replacement) {
  const range = findFunctionRange(out, name);
  if (!range) throw new Error('Could not find function ' + name);
  out = out.slice(0, range.start) + replacement + out.slice(range.end);
  changes.push('replaced ' + name);
}

function insertBeforeFunction(name, block, marker) {
  if (out.includes(marker)) {
    changes.push(marker + ' already present');
    return;
  }
  const range = findFunctionRange(out, name);
  if (!range) throw new Error('Could not find function insertion point ' + name);
  out = out.slice(0, range.start) + block + '\n\n' + out.slice(range.start);
  changes.push('inserted ' + marker);
}

if (!out.includes('SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_START')) {
  throw new Error('Shared Archive ack v4 was not found. Apply repair_seekdeep_shared_archive_button_ack_v4.ps1 first.');
}
if (!out.includes('SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START')) {
  throw new Error('Shared Archive button v1 handler was not found. Apply repair_seekdeep_shared_archive_button_v1.ps1 first.');
}

const guardBlock = String.raw`// SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5_START
const SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5 = globalThis.__seekdeepSharedArchiveInteractionGuardV5 || new Map();
globalThis.__seekdeepSharedArchiveInteractionGuardV5 = SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5;

function seekdeepSharedArchiveInteractionKeyV5(interaction) {
  return String(interaction?.id || interaction?.customId || '') + ':' + String(interaction?.user?.id || interaction?.member?.user?.id || 'unknown');
}

function seekdeepReserveSharedArchiveInteractionV5(interaction) {
  const key = seekdeepSharedArchiveInteractionKeyV5(interaction);
  if (!key || key === ':unknown') return true;
  const now = Date.now();
  const existing = SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5.get(key);
  if (existing && Number(existing.expiresAt || 0) > now) return false;
  SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5.set(key, { createdAt: now, expiresAt: now + 5 * 60 * 1000 });
  return true;
}

function seekdeepWasSharedArchiveInteractionReservedV5(interaction) {
  const key = seekdeepSharedArchiveInteractionKeyV5(interaction);
  const entry = key ? SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5.get(key) : null;
  return Boolean(entry && Number(entry.expiresAt || 0) > Date.now());
}

function seekdeepSharedArchiveCountFromThreadNameV5(name = '') {
  const match = String(name || '').match(/(?:^|\s|â€¢)(\d+)\s*$/u);
  return match ? Math.max(0, Number(match[1]) || 0) : 0;
}

function seekdeepSharedArchiveFastNextCountV5(sharedArchive, thread, guildId = '') {
  const profile = guildId && typeof seekdeepSharedArchiveGetProfile === 'function'
    ? seekdeepSharedArchiveGetProfile(guildId)
    : {};
  const trusted = typeof seekdeepSharedArchiveTrustedCount === 'function'
    ? seekdeepSharedArchiveTrustedCount(profile)
    : Math.max(0, Number(profile?.count || 0) || 0);
  const archiveInfoCount = Math.max(0, Number(sharedArchive?.count || 0) || 0);
  const profileRaw = Math.max(0, Number(profile?.count || 0) || 0);
  const nameCount = seekdeepSharedArchiveCountFromThreadNameV5(thread?.name || sharedArchive?.threadName || profile?.threadName || '');
  return Math.max(trusted, archiveInfoCount, profileRaw, nameCount) + 1;
}

async function seekdeepSharedArchiveMaybeFastRenameV5(thread, count) {
  if (!thread) return '';
  const threadName = typeof seekdeepSharedArchiveThreadBuildName === 'function'
    ? seekdeepSharedArchiveThreadBuildName(count)
    : ('ðŸª™ â€¢ Shared Archive â€¢ ' + String(count)).slice(0, 96);
  if (thread.name !== threadName) {
    if (typeof seekdeepMaybeRenameArchiveThread === 'function') await seekdeepMaybeRenameArchiveThread(thread, threadName);
    else if (typeof thread.setName === 'function') await thread.setName(threadName, 'SeekDeep shared archive count update').catch(() => null);
  }
  return threadName;
}
// SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5_END`;

insertBeforeFunction('seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4', guardBlock, 'SEEKDEEP_SHARED_ARCHIVE_INTERACTION_GUARD_V5_START');

const manualV5 = String.raw`async function seekdeepSharedArchiveButtonManualArchiveV4(interaction) {
  const message = interaction?.message || null;
  const guild = interaction?.guild || message?.guild || interaction?.channel?.guild || null;
  if (!guild) {
    await seekdeepSharedArchiveButtonRespondV4(interaction, 'Shared Archive only works inside a server.');
    return true;
  }

  let sharedArchive;
  if (typeof seekdeepGetOrCreateSharedArchiveThread === 'function') {
    sharedArchive = await seekdeepGetOrCreateSharedArchiveThread(interaction);
  } else if (typeof seekdeepEnsureSharedArchiveThreadForChannel === 'function' && typeof seekdeepGetOrCreateGuildArchiveChannel === 'function') {
    const archiveChannel = await seekdeepGetOrCreateGuildArchiveChannel(interaction);
    sharedArchive = await seekdeepEnsureSharedArchiveThreadForChannel(archiveChannel, interaction, {
      source: 'shared-archive-button-count-finalize-v5',
      reason: 'SeekDeep shared archive button recovery',
    });
  } else {
    throw new Error('Shared Archive helper functions are missing. Re-run the Shared Archive setup/bootstrap patch.');
  }

  const thread = sharedArchive?.thread || sharedArchive;
  if (!thread || typeof thread.send !== 'function') {
    throw new Error('Shared Archive thread could not be resolved. Run `@SeekDeep archive setup here` and retry.');
  }

  if (thread.archived && typeof thread.setArchived === 'function') {
    await thread.setArchived(false, 'SeekDeep shared archive button recovery').catch(() => null);
  }

  const files = seekdeepSharedArchiveCollectImageFilesV4(message);
  if (!files.length) {
    await seekdeepSharedArchiveButtonRespondV4(interaction, 'Shared Archive could not find an image attachment on this Discord message. Nothing was archived.');
    return true;
  }

  const prompt = seekdeepSharedArchiveExtractPromptFromMessageV4(message);
  const requester = interaction?.user ? '<@' + interaction.user.id + '>' : 'unknown';
  const archivedAt = new Date().toISOString();
  const guildId = String(guild?.id || thread?.guild?.id || thread?.parent?.guild?.id || '').trim();
  const nextCount = seekdeepSharedArchiveFastNextCountV5(sharedArchive, thread, guildId);

  const entryContent = [
    'SeekDeep Shared Archive Entry',
    'Saved by: ' + requester,
    'Prompt: ' + prompt,
    'Images: ' + files.length,
    'Archived: ' + archivedAt,
  ].join('\n').slice(0, 1900);

  await thread.send({
    content: entryContent,
    files,
    allowedMentions: { parse: [] },
  });

  let finalCount = nextCount;
  if (String(process.env.SEEKDEEP_SHARED_ARCHIVE_RECOUNT_ON_WRITE || '').trim().toLowerCase() === 'true') {
    try {
      if (typeof seekdeepScanThreadArchiveEntryCount === 'function') {
        const scanned = await seekdeepScanThreadArchiveEntryCount(thread, 'SeekDeep Shared Archive Entry');
        if (Number(scanned) > 0) finalCount = Math.max(finalCount, Number(scanned));
      }
    } catch (scanErr) {
      console.error('[SeekDeep] shared archive count recount failed:', scanErr);
    }
  }

  let threadName = '';
  try {
    threadName = await seekdeepSharedArchiveMaybeFastRenameV5(thread, finalCount);
    if (guildId && typeof seekdeepSharedArchiveSaveProfile === 'function') {
      seekdeepSharedArchiveSaveProfile(guildId, {
        threadId: thread.id,
        threadName,
        count: finalCount,
        countSource: typeof SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE !== 'undefined' ? SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE : 'shared-archive-button-count-finalize-v5',
        lastArchivedAt: archivedAt,
        lastArchivedBy: interaction?.user?.id || '',
        lastArchiveSource: 'shared-archive-button-count-finalize-v5',
      });
    }
  } catch (countErr) {
    console.error('[SeekDeep] shared archive count/name update failed:', countErr);
  }

  await seekdeepSharedArchiveButtonRespondV4(
    interaction,
    'Archived to shared archive.\nThread: <#' + thread.id + '>\nShared archive count: ' + finalCount + '\nImages: ' + files.length
  );

  return true;
}`;
replaceFunction('seekdeepSharedArchiveButtonManualArchiveV4', manualV5);

const handleV5 = String.raw`async function seekdeepHandleSharedArchiveButtonInteractionV4(interaction) {
  if (!interaction || !interaction.isButton || !interaction.isButton()) return false;
  if (!seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(interaction.customId)) return false;

  if (!seekdeepReserveSharedArchiveInteractionV5(interaction)) {
    console.log('[SeekDeep] shared-archive-button-v5 duplicate ignored customId=' + String(interaction.customId || ''));
    return true;
  }

  const start = Date.now();
  console.log('[SeekDeep] route=shared-archive-button-v5 customId=' + String(interaction.customId || ''));

  await seekdeepSharedArchiveButtonAckV4(interaction);

  await seekdeepSharedArchiveButtonRespondV4(
    interaction,
    'Shared Archive queued.\nQueue position: 1 of 1\nStatus: copying image into the shared archive thread...'
  );

  try {
    await seekdeepSharedArchiveButtonManualArchiveV4(interaction);
  } catch (err) {
    console.error('[SeekDeep] shared archive button failed:', err);
    const reason = String(err?.message || err || 'unknown error').slice(0, 1000);
    await seekdeepSharedArchiveButtonRespondV4(
      interaction,
      'Shared Archive failed after the button was acknowledged.\nReason: ' + reason + '\nRun `@SeekDeep archive setup here`, then retry. Check the console for `[SeekDeep] shared archive button failed`.'
    );
  } finally {
    console.log('[SeekDeep] shared-archive-button-v5 done in ' + (Date.now() - start) + 'ms');
  }

  return true;
}`;
replaceFunction('seekdeepHandleSharedArchiveButtonInteractionV4', handleV5);

if (!out.includes('SEEKDEEP_SHARED_ARCHIVE_DUPLICATE_GUARD_V5')) {
  const oldHandlerNeedle = "  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START\n  if (action === 'sharedarchive') {";
  if (!out.includes(oldHandlerNeedle)) throw new Error('Could not find old Shared Archive button handler block to install duplicate guard.');
  out = out.replace(
    oldHandlerNeedle,
    "  // SEEKDEEP_SHARED_ARCHIVE_BUTTON_HANDLER_START\n  // SEEKDEEP_SHARED_ARCHIVE_DUPLICATE_GUARD_V5\n  if (action === 'sharedarchive' && typeof seekdeepWasSharedArchiveInteractionReservedV5 === 'function' && seekdeepWasSharedArchiveInteractionReservedV5(interaction)) {\n    return true;\n  }\n\n  if (action === 'sharedarchive') {"
  );
  changes.push('guarded old Shared Archive handler against duplicate processing');
} else {
  changes.push('old Shared Archive duplicate guard already present');
}

if (out === source) throw new Error('Patch made no changes; refusing to continue.');

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

