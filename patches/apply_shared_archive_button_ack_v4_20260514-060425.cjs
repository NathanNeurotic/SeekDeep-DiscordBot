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

function findClientInteractionCreateHandler(src) {
  const patterns = [
    /client\s*\.\s*on\s*\(\s*['"]interactionCreate['"]\s*,\s*async\s*\(?\s*interaction\s*\)?\s*=>\s*\{/m,
    /client\s*\.\s*on\s*\(\s*['"]interactionCreate['"]\s*,\s*async\s*function\s*\(\s*interaction\s*\)\s*\{/m,
    /client\s*\.\s*on\s*\(\s*['"]interactionCreate['"]\s*,\s*\(?\s*interaction\s*\)?\s*=>\s*\{/m,
    /client\s*\.\s*on\s*\(\s*['"]interactionCreate['"]\s*,\s*function\s*\(\s*interaction\s*\)\s*\{/m,
  ];

  for (const re of patterns) {
    const m = re.exec(src);
    if (m) return { start: m.index, openBrace: m.index + m[0].length - 1 };
  }

  return null;
}

function insertBeforeIndex(index, block) {
  out = out.slice(0, index) + block + out.slice(index);
}

if (!out.includes('seekdeepGetOrCreateSharedArchiveThread') && !out.includes('seekdeepEnsureSharedArchiveThreadForChannel')) {
  throw new Error('Shared Archive helpers were not found. Apply the Shared Archive button/setup patches first, then run this ack v3 patch.');
}

const helperMarker = 'SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_START';
const helperBlock = String.raw`
// SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_START
function seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(customId) {
  const id = String(customId || '').toLowerCase();
  if (!id) return false;
  if (id.includes('shared_archive')) return true;
  if (id.includes('archive_shared')) return true;
  if (id.includes('shared-archive')) return true;
  if (id.includes('archive-shared')) return true;
  if (id.includes('shared') && id.includes('archive')) return true;
  return false;
}

async function seekdeepSharedArchiveButtonAckV4(interaction) {
  if (!interaction || !interaction.isButton || !interaction.isButton()) return false;
  if (!seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(interaction.customId)) return false;

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }
  } catch (ackErr) {
    console.error('[SeekDeep] shared archive button defer failed:', ackErr);
  }

  return true;
}

async function seekdeepSharedArchiveButtonRespondV4(interaction, content) {
  const payload = { content: String(content || '').slice(0, 1900), allowedMentions: { parse: [] } };
  try {
    if (interaction?.deferred) return await interaction.editReply(payload);
    if (interaction?.replied) return await interaction.followUp({ ...payload, ephemeral: true });
    return await interaction.reply({ ...payload, ephemeral: true });
  } catch (err) {
    console.error('[SeekDeep] shared archive button response failed:', err);
    try { return await interaction.followUp({ ...payload, ephemeral: true }); } catch (_) {}
  }
}

function seekdeepSharedArchiveExtractPromptFromMessageV4(message) {
  const content = String(message?.content || '').trim();
  if (!content) return 'unknown prompt';

  const generated = content.match(/Generated:\s*([^\n]+)/i);
  if (generated && generated[1]) return generated[1].trim();

  const original = content.match(/Original Prompt:\s*([^\n]+)/i);
  if (original && original[1]) return original[1].trim();

  const prompt = content.match(/Prompt:\s*([^\n]+)/i);
  if (prompt && prompt[1]) return prompt[1].trim();

  return content.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' / ').slice(0, 280) || 'unknown prompt';
}

function seekdeepSharedArchiveCollectImageFilesV4(message) {
  const files = [];
  const seen = new Set();

  for (const attachment of message?.attachments?.values?.() || []) {
    const url = String(attachment?.url || attachment?.proxyURL || '').trim();
    const name = String(attachment?.name || attachment?.filename || '').toLowerCase();
    const contentType = String(attachment?.contentType || '').toLowerCase();
    const looksImage = contentType.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(name) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
    if (url && looksImage && !seen.has(url)) {
      seen.add(url);
      files.push({ attachment: url, name: attachment?.name || attachment?.filename || 'seekdeep-image.png' });
    }
  }

  for (const embed of message?.embeds || []) {
    const url = String(embed?.image?.url || embed?.thumbnail?.url || '').trim();
    if (url && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) && !seen.has(url)) {
      seen.add(url);
      files.push({ attachment: url, name: 'seekdeep-embed-image.png' });
    }
  }

  return files;
}

async function seekdeepSharedArchiveButtonManualArchiveV4(interaction) {
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
      source: 'shared-archive-button-ack-v4',
      reason: 'SeekDeep shared archive button recovery',
    });
  } else {
    throw new Error('Shared Archive helper functions are missing. Re-run the Shared Archive setup/bootstrap patch.');
  }

  const thread = sharedArchive?.thread || sharedArchive;
  if (!thread || typeof thread.send !== 'function') {
    throw new Error('Shared Archive thread could not be resolved. Run \`@SeekDeep archive setup here\` and retry.');
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

  let count = Math.max(0, Number(sharedArchive?.count || 0) || 0) + 1;

  try {
    if (typeof seekdeepScanThreadArchiveEntryCount === 'function') {
      count = await seekdeepScanThreadArchiveEntryCount(thread, 'SeekDeep Shared Archive Entry');
    }
  } catch (scanErr) {
    console.error('[SeekDeep] shared archive count scan failed:', scanErr);
  }

  try {
    const threadName = typeof seekdeepSharedArchiveThreadBuildName === 'function'
      ? seekdeepSharedArchiveThreadBuildName(count)
      : ('ðŸª™ â€¢ Shared Archive â€¢ ' + String(count)).slice(0, 96);
    if (thread.name !== threadName) {
      if (typeof seekdeepMaybeRenameArchiveThread === 'function') {
        await seekdeepMaybeRenameArchiveThread(thread, threadName);
      } else if (typeof thread.setName === 'function') {
        await thread.setName(threadName, 'SeekDeep shared archive count update').catch(() => null);
      }
    }

    if (typeof seekdeepSharedArchiveSaveProfile === 'function') {
      seekdeepSharedArchiveSaveProfile(String(guild.id), {
        threadId: thread.id,
        threadName,
        count,
        countSource: typeof SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE !== 'undefined' ? SEEKDEEP_SHARED_ARCHIVE_COUNT_SOURCE : 'thread-scan',
        lastArchivedAt: archivedAt,
        lastArchivedBy: interaction?.user?.id || '',
        lastArchiveSource: 'shared-archive-button-ack-v4',
      });
    }
  } catch (countErr) {
    console.error('[SeekDeep] shared archive count/name update failed:', countErr);
  }

  await seekdeepSharedArchiveButtonRespondV4(
    interaction,
    'Archived to shared archive.\nThread: <#' + thread.id + '>\nImages: ' + files.length
  );

  return true;
}

async function seekdeepHandleSharedArchiveButtonInteractionV4(interaction) {
  if (!interaction || !interaction.isButton || !interaction.isButton()) return false;
  if (!seekdeepSharedArchiveButtonLooksLikeSharedArchiveV4(interaction.customId)) return false;

  const start = Date.now();
  console.log('[SeekDeep] route=shared-archive-button-v4 customId=' + String(interaction.customId || ''));

  await seekdeepSharedArchiveButtonAckV4(interaction);

  try {
    await seekdeepSharedArchiveButtonManualArchiveV4(interaction);
  } catch (err) {
    console.error('[SeekDeep] shared archive button failed:', err);
    const reason = String(err?.message || err || 'unknown error').slice(0, 1000);
    await seekdeepSharedArchiveButtonRespondV4(
      interaction,
      'Shared Archive failed after the button was acknowledged.\nReason: ' + reason + '\nRun \`@SeekDeep archive setup here\`, then retry. Check the console for \`[SeekDeep] shared archive button failed\`.'
    );
  } finally {
    console.log('[SeekDeep] shared-archive-button-v4 done in ' + (Date.now() - start) + 'ms');
  }

  return true;
}
// SEEKDEEP_SHARED_ARCHIVE_BUTTON_ACK_V4_END
`;

if (!out.includes(helperMarker)) {
  const handler = findClientInteractionCreateHandler(out);
  if (!handler) {
    throw new Error('Could not find client.on("interactionCreate", ...) to install Shared Archive button ack hook.');
  }
  insertBeforeIndex(handler.start, helperBlock + '\n\n');
  changes.push('inserted Shared Archive button ack/manual archive helper v4');
}

const hookLine = "  if (typeof seekdeepHandleSharedArchiveButtonInteractionV4 === 'function' && await seekdeepHandleSharedArchiveButtonInteractionV4(interaction)) return;";
if (!out.includes(hookLine)) {
  const handler = findClientInteractionCreateHandler(out);
  if (!handler) throw new Error('Could not find interactionCreate handler opening brace for hook insertion.');
  const openBrace = handler.openBrace;
  out = out.slice(0, openBrace + 1) + '\n' + hookLine + out.slice(openBrace + 1);
  changes.push('hooked Shared Archive button before the existing interaction handler');
} else {
  changes.push('Shared Archive interactionCreate hook v4 already present');
}

// Keep help canonical if the help text has the old button list.
out = out.replace(/Buttons: `Original` `Refined` `Both` `Download` `Archive`(?! `Shared Archive`)/g, "Buttons: `Original` `Refined` `Both` `Download` `Archive` `Shared Archive`");

if (out === source) throw new Error('Patch made no changes; refusing to continue.');

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);
