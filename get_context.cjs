const fs = require('fs');
let content = fs.readFileSync('index.js', 'utf8');

const i = content.indexOf('async function seekdeepHandleContextMenuGenerateImage(interaction, targetMessage)');
console.log(content.substring(i, i + 1000));
