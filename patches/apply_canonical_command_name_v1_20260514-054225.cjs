
const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let out = source;
const changes = [];

function replaceAllLiteral(find, replace, label) {
  const count = (out.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (count > 0) {
    out = out.split(find).join(replace);
    changes.push(`${label}: ${count}`);
  }
}

function replaceRegex(regex, replacer, label) {
  let count = 0;
  out = out.replace(regex, (...args) => {
    count += 1;
    return typeof replacer === 'function' ? replacer(...args) : replacer;
  });
  if (count > 0) changes.push(`${label}: ${count}`);
}

// Canonical visible command prefix should be @SeekDeep.
replaceAllLiteral('@SEEKOTICS', '@SeekDeep', 'updated visible command prefix');
replaceAllLiteral('SEEKOTICS COMMAND MAP', 'SEEKDEEP COMMAND MAP', 'updated command map title');
replaceAllLiteral('Seekotics command map', 'SeekDeep command map', 'updated title-case command map title');
replaceAllLiteral('seekotics command map', 'seekdeep command map', 'updated lower-case command map title');

// Some earlier help text may mention SEEKOTICS in prose without the @ mention.
replaceRegex(/\bUse `@SeekDeep help` for the full supported command map\./g, 'Use `@SeekDeep help` for the full supported command map.', 'normalized help hint');
replaceRegex(/\bSeekotics\b/g, 'SeekDeep', 'updated visible bot name');

if (out === source) {
  throw new Error('No visible @SEEKOTICS / Seekotics help text was found to update.');
}

fs.writeFileSync(indexPath, out, 'utf8');
console.log('Patched index.js successfully.');
for (const c of changes) console.log('- ' + c);

