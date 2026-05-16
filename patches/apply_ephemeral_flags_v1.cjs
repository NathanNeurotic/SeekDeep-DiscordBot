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