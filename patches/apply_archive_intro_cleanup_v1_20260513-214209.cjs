const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let output = source;

const changes = [];

function replaceAll(label, pattern, replacement) {
  const before = output;
  output = output.replace(pattern, replacement);
  if (output !== before) changes.push(label);
}

// Remove archive-thread starter/explainer line that was being posted into the user's archive thread.
// This intentionally targets the phrase "Thread format:" only; the public help text uses "Thread style:" and is left alone.
replaceAll(
  'removed archive thread-format explainer line',
  /^[^\S\r\n]*[^\r\n]*Thread format:[^\r\n]*(?:\r?\n|$)/gm,
  ''
);

// Shorten the starter text. The thread name already communicates ownership and count.
replaceAll(
  'shortened archive starter wording',
  /New archived generations for this user will be posted here\./g,
  'New archived generations will appear here.'
);

replaceAll(
  'shortened archive starter wording without period',
  /New archived generations for this user will be posted here/g,
  'New archived generations will appear here'
);

if (output === source) {
  throw new Error('No archive intro text matched. index.js may have drifted or the intro was already cleaned up; refusing to patch blindly.');
}

fs.writeFileSync(indexPath, output, 'utf8');
console.log('Patched index.js successfully:');
for (const change of changes) console.log(`- ${change}`);
