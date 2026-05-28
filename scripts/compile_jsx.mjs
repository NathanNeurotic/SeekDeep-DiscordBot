// One-off compile pass: extract <script type="text/babel"> blocks from chat.html
// and app.html, transform with @babel/preset-react, write back as plain <script>.
// Also replaces the <script src="tweaks-panel.jsx"> reference with the
// pre-compiled .js. Lets us drop the 3.5 MB Babel standalone CDN entirely.
import fs from 'node:fs';
import path from 'node:path';
import * as babel from '@babel/core';

const ROOT = path.dirname(new URL(import.meta.url).pathname.slice(1));
const REPO = path.resolve(ROOT, '..');

function compileFile(rel) {
  const abs = path.join(REPO, rel);
  let html = fs.readFileSync(abs, 'utf8');
  const re = /<script type="text\/babel">([\s\S]*?)<\/script>/g;
  let count = 0;
  const out = html.replace(re, (match, code) => {
    try {
      const result = babel.transformSync(code, {
        presets: [['@babel/preset-react', { runtime: 'classic' }]],
        filename: 'inline.jsx',
      });
      count++;
      return '<script>\n' + result.code + '\n</script>';
    } catch (e) {
      console.error('  fail inline:', e.message.slice(0, 100));
      return match;
    }
  });
  // Swap the JSX file ref for the compiled .js
  const swapped = out.replace(
    /<script type="text\/babel" src="tweaks-panel\.jsx"><\/script>/g,
    '<script src="tweaks-panel.compiled.js"></script>'
  );
  fs.writeFileSync(abs, swapped);
  console.log(`  ${rel}: compiled ${count} inline blocks; swapped tweaks-panel ref`);
}

console.log('Compiling JSX in HTML pages...');
compileFile('gui/chat.html');
compileFile('gui/app.html');
console.log('Done.');
