const fs = require('fs');

function applyFix() {
    let content = fs.readFileSync('index.js', 'utf8');

    const queueOptionsTarget = `    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute(routeName, basePrompt);
    }

    const modeOptions = typeof seekdeepRegenerateModeOptions === 'function'
      ? seekdeepRegenerateModeOptions(regenMode, {
          ...state,
          originalPrompt: basePrompt,
          ground: grounded,
        })
      : {
          ...(state?.imageModeOptions || {}),
          refine: regenMode !== 'original',
          ground: grounded,
          cleanPrompt: basePrompt,
          skipCooldown: true,
      };

    if (String(regenMode || '').toLowerCase() === 'rerefine') {
      console.log(\`[SeekDeep] RE-REFINE queued actionId=\${actionId} prompt=\${basePrompt.slice(0, 120)}\`);
    }
    modeOptions.target = interaction;

    return await seekdeepSendImageWithButtons(
      proxy,
      basePrompt,
      width,
      height,
      seed,
      modeOptions,`;

    const queueOptionsReplacement = `    if (typeof seekdeepLogRoute === 'function') {
      seekdeepLogRoute(routeName, finalPrompt);
    }

    const modeOptions = typeof seekdeepRegenerateModeOptions === 'function'
      ? seekdeepRegenerateModeOptions(regenMode, {
          ...state,
          originalPrompt: finalPrompt,
          ground: grounded,
        })
      : {
          ...(state?.imageModeOptions || {}),
          refine: regenMode !== 'original',
          ground: grounded,
          cleanPrompt: finalPrompt,
          skipCooldown: true,
      };

    if (String(regenMode || '').toLowerCase() === 'rerefine') {
      console.log(\`[SeekDeep] RE-REFINE queued actionId=\${actionId} prompt=\${finalPrompt.slice(0, 120)}\`);
    }
    modeOptions.target = interaction;

    return await seekdeepSendImageWithButtons(
      proxy,
      finalPrompt,
      width,
      height,
      seed,
      modeOptions,`;

    if (content.includes(queueOptionsTarget)) {
        content = content.replace(queueOptionsTarget, queueOptionsReplacement);
    } else {
        console.error("Could not find queueOptionsTarget");
    }

    fs.writeFileSync('index.js', content);
}
applyFix();
