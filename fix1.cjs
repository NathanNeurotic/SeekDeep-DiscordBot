const fs = require('fs');

function applyFix() {
    let content = fs.readFileSync('index.js', 'utf8');

    // 1. seekdeepIsGenericImageFollowupPrompt
    const genericTarget = `function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;
  // Standalone command without a real subject ("draw it", "make a picture").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p)) return true;
  // Pronoun-only references ("draw him", "draw her", "make her", "image of him", "picture of them").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?\\s+(an?\\s+(?:image|picture|pic|portrait|drawing|illustration)\\s+of\\s+)?(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  if (/^(?:an?\\s+)?(image|picture|pic|portrait|drawing|illustration|render)\\s+of\\s+(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  return false;
}`;

    const genericReplacement = `function seekdeepIsGenericImageFollowupPrompt(prompt = '') {
  const p = normalizeUserText(prompt).toLowerCase().trim();
  if (seekdeepLooksLikeGenerateOnlyPrompt(p)) return true;

  // Correction phrases
  if (/^(?:no,?\\s*)?(?:make|create|draw|generate|render|turn)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\s*(?:from|out of|with)\\s+(?:that|this|the)\\s+(?:prompt|idea)(?:\\s+instead)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:use|take)\\s+(?:that|this|the)\\s+(?:prompt|idea)\\s+(?:for|to make|and make)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:make|turn)\\s+(?:it|that|this)\\s+(?:into\\s+)?(?:an?\\s+)?(?:image|picture|pic|art|picture)\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:draw|generate|render|make)\\s+(?:it|that)\\s*(?:instead)?(?:\\s+into\\s+a\\s+picture)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:make|create|draw|generate|render)\\s+(?:an?\\s+)?(?:image|picture|pic|art)\\s+from\\s+(?:that|this|it)(?:\\s+prompt)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?(?:use|make)\\s+(?:that|this)\\s+prompt(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;
  if (/^(?:no,?\\s*)?make\\s+an\\s+image\\s+from\\s+that(?:\\s+prompt)?(?:\\s+please)?\\.?[!?]*$/i.test(p)) return true;

  // Standalone command without a real subject ("draw it", "make a picture").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?(?:\\s+(an?\\s+)?(image|picture|pic|art|drawing|illustration|it|that|this))?$/i.test(p)) return true;
  // Pronoun-only references ("draw him", "draw her", "make her", "image of him", "picture of them").
  if (/^(generate|create|make|draw|paint|sketch|illustrate|render|show)(\\s+me)?\\s+(an?\\s+(?:image|picture|pic|portrait|drawing|illustration)\\s+of\\s+)?(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  if (/^(?:an?\\s+)?(image|picture|pic|portrait|drawing|illustration|render)\\s+of\\s+(him|her|them|that|this|it|us|those|these)\\b\\s*[.!?]*$/i.test(p)) return true;
  return false;
}`;
    content = content.replace(genericTarget, genericReplacement);

    fs.writeFileSync('index.js', content);
}
applyFix();
