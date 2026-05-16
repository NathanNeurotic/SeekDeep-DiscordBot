const fs = require('fs');
const path = require('path');

const indexPath = path.join(process.cwd(), 'index.js');
let source = fs.readFileSync(indexPath, 'utf8');
let text = source;
const changes = [];

const newFn = `function seekdeepIsArchiveConfigPrompt(value = '') {
  const cleaned = seekdeepCleanArchiveConfigPrompt(value).toLowerCase();
  return /^(?:archive\\s+(?:setup|configure|config|channel|set\\s+channel)|setup\\s+archive|configure\\s+archive|config\\s+archive|set\\s+archive\\s+channel)(?:\\b|$)/i.test(cleaned);
}`;

const fnRegex = /function seekdeepIsArchiveConfigPrompt\(value = ''\) \{[\s\S]*?\n\}\n\nfunction seekdeepExtractArchiveSetupChannel/;
if (!fnRegex.test(text)) {
  throw new Error('Could not find seekdeepIsArchiveConfigPrompt immediately before seekdeepExtractArchiveSetupChannel.');
}

text = text.replace(fnRegex, newFn + '\n\nfunction seekdeepExtractArchiveSetupChannel');
changes.push('updated archive setup route matcher to accept setup archive aliases');

if (text.includes('`@SeekDeep setup archive here`')) {
  changes.push('setup archive alias already present in help text');
} else {
  const helpNeedle = "    '`@SeekDeep archive setup #channel`',\n    '`@SeekDeep archive setup here`'";
  if (text.includes(helpNeedle)) {
    text = text.replace(
      helpNeedle,
      "    '`@SeekDeep archive setup #channel`',\n    '`@SeekDeep archive setup here`',\n    '`@SeekDeep setup archive here`'"
    );
    changes.push('added setup archive alias to setup prompt text');
  } else {
    changes.push('setup prompt help anchor not found; route fix still applied');
  }
}

if (text === source) {
  throw new Error('Patch made no changes; refusing to continue.');
}

fs.writeFileSync(indexPath, text, 'utf8');
console.log('Patched index.js successfully.');
for (const change of changes) console.log('- ' + change);

