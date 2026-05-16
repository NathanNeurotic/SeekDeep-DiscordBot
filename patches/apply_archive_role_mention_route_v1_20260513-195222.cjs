const fs = require('fs');

const indexPath = process.argv[2];
if (!indexPath) throw new Error('Missing index.js path argument.');

let src = fs.readFileSync(indexPath, 'utf8');
let next = src;
const changes = [];

if (next.includes('SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1')) {
  console.log('Archive role-mention route patch marker already present; no text changes needed.');
} else {
  const oldBlock = `  const withoutBotMention = raw
    .replace(/<@!?\\d+>/g, (mention, offset) => {
      // Preserve non-leading mentions so "archive @user" still routes.
      const before = raw.slice(0, offset).trim();
      return before ? mention : ' ';
    })`;

  const newBlock = `  const withoutBotMention = raw
    // SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1_START
    // Discord can resolve @SeekDeep as a role mention (<@&id>) instead of the bot user mention.
    // Treat only leading user/role mentions as command-addressing noise, while preserving later
    // user mentions so "archive @user" still targets the correct person.
    .replace(/<@(?:!|&)?\\d+>/g, (mention, offset) => {
      const before = raw.slice(0, offset).trim();
      return before ? mention : ' ';
    })
    // SEEKDEEP_ARCHIVE_ROLE_MENTION_ROUTE_V1_END`;

  if (!next.includes(oldBlock)) {
    throw new Error('Could not find the archive-open mention normalization block. index.js has drifted; refusing to patch blindly.');
  }

  next = next.replace(oldBlock, newBlock);
  changes.push('archive-open message detection now accepts leading role mentions such as <@&role> archive @user');
}

if (next !== src) {
  fs.writeFileSync(indexPath, next, 'utf8');
  for (const change of changes) console.log(`Applied: ${change}`);
}
