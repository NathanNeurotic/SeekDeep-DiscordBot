// ============================================================
// COMMAND DATA — lifted from COMMANDS.md (v10.38)
// ============================================================
const DATA = [
  {
    id: 'start', title: 'Start & status', meta: '8 commands',
    note: "First-line checks: is the bot online, what model is loaded, what's the queue look like.",
    cmds: [
      { syntax: '@SeekDeep help', desc: 'Show the full in-Discord command map.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep help <topic>', desc: 'Show only one section. Topics: <span class="mono">start</span>, <span class="mono">chat</span>, <span class="mono">image</span>, <span class="mono">vision</span>, <span class="mono">archive</span>, <span class="mono">model</span>, <span class="mono">recent</span>, <span class="mono">admin</span>, <span class="mono">reactrule</span>, <span class="mono">emoji</span>, <span class="mono">context</span>, <span class="mono">all</span>.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep help search <query>', desc: 'Fuzzy-search all commands for a keyword.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive help', desc: 'Show help, archive section only.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep status', desc: 'Local AI server, model, runtime, queue, response status.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep ping', desc: 'Lightweight bot availability check.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep what model are you using?', desc: 'Show configured local model information.', type: 'mention', perm: 'Everyone' },
      { syntax: '/help topic:<choice> search:<query>', desc: 'Slash equivalent with optional fuzzy search.', type: 'slash', perm: 'Everyone' },
      { syntax: '/status verbose:true', desc: 'Slash status with the full chat-roles map + cache/map-size diagnostics.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'chat', title: 'Chat, web & prompting', meta: '4 commands',
    note: '<span class="mono">web:auto</span> lets SeekDeep decide whether SearXNG is needed. Use <span class="mono">web:off</span> for local-only answers. <span class="mono">web:always</span> forces a search. Source URLs are wrapped like <span class="mono">&lt;https://...&gt;</span> to suppress Discord embeds.',
    cmds: [
      { syntax: '@SeekDeep ask <question>', desc: 'Ask the local chat model.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep refine <prompt>', desc: 'Rewrite or improve a prompt with the local chat model.', type: 'mention', perm: 'Everyone' },
      { syntax: '/ask prompt:<text> web:auto|off|always', desc: 'Slash-command chat entrypoint.', type: 'slash', perm: 'Everyone' },
      { syntax: '/refine prompt:<text>', desc: 'Slash-command prompt rewrite entrypoint.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'image', title: 'Image generation', meta: '15 commands',
    note: 'Image requests offer <strong>Original / Refined / Both</strong> before queueing. Result buttons: <strong>Download · Archive · Shared Archive · RE-REFINE</strong>. Use <span class="mono">raw</span>, <span class="mono">unrefined</span>, <span class="mono">--raw</span>, or <span class="mono">no refine</span> to skip refinement.',
    cmds: [
      { syntax: '@SeekDeep show me <subject>', desc: 'Generate an image.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep draw/make/create/render/paint/sketch/illustrate/design <subject>', desc: 'Generate an image — all verbs equivalent.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep regenerate', desc: 'Regenerate the most recent image prompt when available.', type: 'mention', perm: 'Everyone' },
      { syntax: '/image prompt:<text> width:<n> height:<n> seed:<n>', desc: 'Slash-command image generation.', type: 'slash', perm: 'Everyone' },
      { syntax: '/image ... quality:low|standard|high', desc: 'Image quality preset (12 / 28 / 40 inference steps).', type: 'slash', perm: 'Everyone' },
      { syntax: '/image ... style:anime|photoreal|pixel|oil-painting|cyberpunk|cottagecore|cinematic|3d-render|sketch|watercolor', desc: 'Pre-baked style modifier.', type: 'slash', perm: 'Everyone' },
      { syntax: '/regen mode:refined|original|both', desc: 'Regenerate the latest channel image.', type: 'slash', perm: 'Everyone' },
      { syntax: '@SeekDeep img2img [prompt]', desc: 'Transform an attached/replied/recent image. Bare command defaults to "enhance this image".', type: 'mention', perm: 'Everyone' },
      { syntax: '/img2img image:<file> prompt:<text> strength:0.6', desc: 'Slash img2img. Strength 0.05-1.0.', type: 'slash', perm: 'Everyone' },
      { syntax: '@SeekDeep pix2pix <instruction>', desc: 'Edit an attached/replied/recent image with InstructPix2Pix.', type: 'mention', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on' },
      { syntax: '/pix2pix instruction:<text> image:<file>', desc: 'Slash InstructPix2Pix.', type: 'slash', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on' },
      { syntax: '@SeekDeep inpaint <target>', desc: 'Remove something from an attached/replied/recent image via CLIPSeg + SDXL.', type: 'mention', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INPAINT=on' },
      { syntax: '/inpaint remove:<text> prompt:<text> image:<file>', desc: 'Slash inpaint.', type: 'slash', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INPAINT=on' },
      { syntax: '@SeekDeep upscale [2x|3x|4x]', desc: 'Upscale an attached/replied/recent image. PIL Lanczos + mild sharpen by default.', type: 'mention', perm: 'Everyone' },
      { syntax: '/upscale image:<file> scale:2|3|4', desc: 'Slash upscale.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'vision', title: 'Vision', meta: '4 commands',
    note: 'Reply to an image with natural language and SeekDeep classifies intent first: vision · upscale · edit (inpaint/pix2pix/img2img) · fresh inspired · regenerate / RE-REFINE.',
    cmds: [
      { syntax: '@SeekDeep what is this?  (reply to image/video)', desc: 'Analyze the replied-to media.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep what is this?  (reply to forwarded image)', desc: 'Walks <span class="mono">messageSnapshots</span> to find the underlying image.', type: 'mention', perm: 'Everyone' },
      { syntax: '/vision file:<upload> prompt:<question> mode:describe|ocr', desc: 'Slash-command vision analysis. OCR mode extracts text exactly as it appears.', type: 'slash', perm: 'Everyone' },
      { syntax: '@SeekDeep tell me more about this image', desc: 'Re-runs vision on the cached attachment (within ~10 min).', type: 'mention', perm: 'Everyone' },
    ]
  },
  {
    id: 'archive-setup', title: 'Archive — setup', meta: '5 commands',
    note: 'Admin setup wires a single archive channel per server. SeekDeep needs <strong>Manage Threads</strong> + access to the chosen channel.',
    cmds: [
      { syntax: '@SeekDeep archive config', desc: 'Show archive configuration status.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep archive setup here', desc: 'Configure the current channel as the server archive channel.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep setup archive here', desc: 'Alias for archive setup in the current channel.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep archive setup #channel', desc: 'Configure a mentioned channel as the server archive channel.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep archive snapshot', desc: 'Walk every guild thread (shared + per-user) and write a flat index to <span class="mono">data/archive-snapshot.json</span>. The GUI Archive pane (<span class="mono">app.html → Archive browser</span>) reads this — without a snapshot the pane shows "snapshot pending". A 6h cron writes it automatically; this command forces an immediate refresh. Aliases: <span class="mono">archive rescan</span> · <span class="mono">archive refresh</span> · <span class="mono">archive reindex</span>.', type: 'mention', perm: 'Admin' },
    ]
  },
  {
    id: 'archive-use', title: 'Archive — use', meta: '13 commands',
    note: 'Each archive entry has <strong>Download</strong> + grey <strong>Delete from Archive</strong> buttons. The <span class="mono">Archive Key</span> in each entry prevents double-counting across retries, restarts and reaction shortcuts.',
    cmds: [
      { syntax: '@SeekDeep archive me', desc: 'Open or create your personal archive thread.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive @user', desc: "Open or create another user's archive thread when permitted.", type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive shared', desc: 'Open or create the shared archive thread.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive status', desc: 'Show your archive status.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive status @user', desc: "Show a user's archive status.", type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive count set <number>', desc: 'Manually set the count for your own archive thread.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive count @user set <number>', desc: "Set another user's count.", type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep archive search <query>', desc: 'Text-search prompts in your archive thread.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive clean older than <duration>', desc: 'Preview old entries for bulk deletion. Units: <span class="mono">h</span>, <span class="mono">d</span>, <span class="mono">w</span>, <span class="mono">m</span>.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive clean confirm', desc: 'Confirm pending bulk deletion. 2-min TTL.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep archive this | save this | share this', desc: 'Natural-language archive of the most recent SeekDeep image in the channel.', type: 'mention', perm: 'Everyone' },
      { syntax: '/archivestatus', desc: 'Slash-command archive status.', type: 'slash', perm: 'Everyone' },
      { syntax: '/recent kind:archive', desc: 'Newest 10 entries in your archive thread.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'search', title: 'Search & templates', meta: '7 commands',
    note: 'Templates persist to <span class="mono">data/prompt-templates.json</span>. Max 25 per user, names auto-sanitized to lowercase alphanumeric + hyphens (max 30 chars).',
    cmds: [
      { syntax: '@SeekDeep search <query>', desc: 'Search recent conversations in this channel by keyword.', type: 'mention', perm: 'Everyone' },
      { syntax: '/search query:<keywords>', desc: 'Slash conversation search.', type: 'slash', perm: 'Everyone' },
      { syntax: '@SeekDeep template save <name>: <prompt>', desc: 'Save a reusable image prompt template.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep template list', desc: 'Show your saved templates.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep template use <name>', desc: 'Generate an image from a saved template.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep template delete <name>', desc: 'Remove a template.', type: 'mention', perm: 'Everyone' },
      { syntax: '/template action:save|list|use|delete name:<n> prompt:<p>', desc: 'Slash template management.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'recent', title: 'Recent, cache & queue', meta: '17 commands',
    note: 'GPU watch edits one message every N sec (clamped 2-60). React ✋ to stop early. Per-channel single-active-watcher lock.',
    cmds: [
      { syntax: '@SeekDeep recent images [limit]', desc: 'Show recent image generations. Default 5, max 10.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep recent prompts', desc: 'Show recent prompts for the current context.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep recent errors', desc: 'Show recent bot-side errors (redacted).', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep changelog', desc: 'Show the last 10 git commits.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep cache status', desc: 'Show temporary image cache status.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep queue status', desc: 'Show current image queue status.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep stats', desc: 'Server-wide totals + top contributors.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep stats me', desc: 'Your activity in this server.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep stats chart', desc: '30-day activity chart image (images, chats, vision).', type: 'mention', perm: 'Everyone' },
      { syntax: '/stats scope:server|me|chart', desc: 'Slash-command stats with optional chart.', type: 'slash', perm: 'Everyone' },
      { syntax: '/recent kind:images|prompts|archive', desc: 'Slash-command recent history.', type: 'slash', perm: 'Everyone' },
      { syntax: '/cachestatus', desc: 'Slash-command cache status.', type: 'slash', perm: 'Everyone' },
      { syntax: '/changelog', desc: 'Slash-command git log (last 10 commits).', type: 'slash', perm: 'Everyone' },
      { syntax: '/status', desc: 'Slash-command local backend status.', type: 'slash', perm: 'Everyone' },
      { syntax: '@SeekDeep gpu  /  @SeekDeep vram', desc: 'One-shot GPU + VRAM snapshot.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep gpu watch [N]  /  vram watch [N]', desc: 'Live-tail VRAM every N sec (default 5, max 2 min).', type: 'mention', perm: 'Everyone' },
      { syntax: '/gpu watch:true interval:5', desc: 'Slash live-tail GPU.', type: 'slash', perm: 'Everyone' },
    ]
  },
  {
    id: 'admin', title: 'Admin / customization', meta: '14 commands',
    note: 'Personas: built-in (<span class="mono">neurotic</span>, <span class="mono">unsettling</span>, <span class="mono">clinical</span>, <span class="mono">chaotic</span>) plus any custom personas you create with <span class="mono">persona create</span>. Memory presets stack on top of persona — <span class="mono">brief</span>, <span class="mono">expert</span>, <span class="mono">no-emoji</span>, <span class="mono">formal</span>, <span class="mono">casual</span>.',
    cmds: [
      { syntax: '@SeekDeep persona [channel|server] [neurotic|unsettling|clinical|chaotic|<custom>|reset|show]', desc: 'Set or display the persona. Accepts any built-in slug or one you defined via <span class="mono">persona create</span>.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep persona create <slug> <tone description>', desc: 'Define a custom persona. Slug 2-32 chars, [a-z0-9_-]. Tone 2-280 chars, becomes the system-prompt flavor line. Stored in <span class="mono">data/custom-personas.json</span>.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep persona remove <slug>', desc: 'Delete a custom persona. Channel/guild overrides pointing at it fall back to the env default on next message.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep persona list', desc: 'Show built-in + custom personas with their tone descriptions.', type: 'mention', perm: 'Everyone' },
      { syntax: '/persona', desc: 'Open the persona editor modal (interactive popup).', type: 'slash', perm: 'Manage Guild' },
      { syntax: '@SeekDeep memory preset add <preset-name>', desc: 'Layer a behavior preset.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep memory preset list', desc: 'Show your active presets.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep memory preset remove <key>', desc: 'Remove a preset.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep memory preset clear', desc: 'Clear all your presets.', type: 'mention', perm: 'Everyone' },
      { syntax: '@SeekDeep digest channel here', desc: 'Set this channel as the daily-digest destination.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep digest channel off', desc: 'Disable the daily digest for this server.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep translate channel here', desc: 'Enable auto-translate for non-Latin messages in this channel.', type: 'mention', perm: 'Admin' },
      { syntax: '@SeekDeep translate channel off', desc: 'Disable auto-translate for this server.', type: 'mention', perm: 'Admin' },
      { syntax: '/say text:<text> channel:<#channel> image_url:<url>', desc: 'Admin anonymous post. Strips <span class="mono">@everyone</span>, <span class="mono">@here</span>, role mentions.', type: 'slash', perm: 'Manage Msgs' },
    ]
  },
  {
    id: 'reactrule', title: 'Auto-reactions', meta: '8 commands',
    note: 'Pattern is substring by default; use <span class="mono">/regex/flag</span> for regex. Built-in stacking rules: <span class="mono">long_message</span>, <span class="mono">forwarded</span>, <span class="mono">code_block</span>, <span class="mono">image_only</span>, <span class="mono">link_only</span>.',
    cmds: [
      { syntax: '@SeekDeep reactrule list', desc: 'Show this guild\'s auto-reaction rules + built-in toggles.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule add <emoji> when <pattern>', desc: 'Add a rule.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule add <emoji> when <pattern> in #channel', desc: 'Restrict the rule to a channel.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule add <emoji> for @user', desc: 'Restrict the rule to a user.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule remove <id>', desc: 'Remove a rule by ID.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule toggle <id>', desc: 'Enable / disable a rule.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule builtin <name> on|off', desc: 'Toggle a built-in stacking rule.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule export', desc: 'Attach a JSON of the current rules.', type: 'mention', perm: 'Manage Msgs' },
      { syntax: '@SeekDeep reactrule import', desc: 'Re-create rules from an attached JSON.', type: 'mention', perm: 'Manage Msgs' },
    ]
  },
  {
    id: 'emoji', title: 'Emoji vault', meta: '4 commands · feature-flagged',
    note: 'Default <strong style="color:var(--bad);">OFF</strong> in shared servers so SeekDeep doesn\'t fight demonbot for the same vault thread. Set <span class="mono">SEEKDEEP_FEATURE_EMOJI_VAULT=on</span> to enable.',
    cmds: [
      { syntax: '@SeekDeep emoji backup', desc: 'Create the emoji thread with paginated previews + JSON + ZIP.', type: 'mention', perm: 'Manage Msgs', flag: 'SEEKDEEP_FEATURE_EMOJI_VAULT=on' },
      { syntax: '@SeekDeep emoji import', desc: 'Re-create emojis from an attached JSON or ZIP. Bot needs <span class="mono">Manage Expressions</span>.', type: 'mention', perm: 'Manage Msgs', flag: 'SEEKDEEP_FEATURE_EMOJI_VAULT=on' },
      { syntax: '@SeekDeep emoji count', desc: 'Quick count + animated/static split.', type: 'mention', perm: 'Manage Msgs', flag: 'SEEKDEEP_FEATURE_EMOJI_VAULT=on' },
      { syntax: '@SeekDeep emoji list', desc: 'Short text list of all custom emojis.', type: 'mention', perm: 'Manage Msgs', flag: 'SEEKDEEP_FEATURE_EMOJI_VAULT=on' },
    ]
  },
  {
    id: 'context', title: 'Right-click context menu', meta: '11 commands',
    note: 'Right-click any message → <strong>Apps</strong> → SeekDeep submenu. Default flips to <strong>ephemeral</strong> for Refine, Translate, Compare via <span class="mono">SEEKDEEP_CONTEXT_*_EPHEMERAL=on</span>.',
    cmds: [
      { syntax: 'Generate Image from this', desc: 'Use the message text as an image prompt.', type: 'context', perm: 'Everyone' },
      { syntax: 'Refine as Image Prompt', desc: 'Rewrite as a stronger image prompt.', type: 'context', perm: 'Everyone' },
      { syntax: 'Describe Image (SeekDeep)', desc: 'Run vision analysis on an image attachment (ephemeral).', type: 'context', perm: 'Everyone' },
      { syntax: 'Upscale Image (SeekDeep)', desc: 'Upscale an image attachment 2x.', type: 'context', perm: 'Everyone' },
      { syntax: 'img2img from this', desc: 'Use text as img2img prompt on the attached or most recent bot image.', type: 'context', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_IMG2IMG=on' },
      { syntax: 'Edit Image (SeekDeep)', desc: 'Edit the attached image with InstructPix2Pix.', type: 'context', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INSTRUCT_PIX2PIX=on' },
      { syntax: 'Remove Object (SeekDeep)', desc: 'Remove something from the attached image via CLIPSeg + inpaint.', type: 'context', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_INPAINT=on' },
      { syntax: 'Inspect (SeekDeep)', desc: 'Ephemeral debug card: IDs, timestamps, attachments.', type: 'context', perm: 'Everyone' },
      { syntax: 'Translate (SeekDeep)', desc: 'Translate to plain English.', type: 'context', perm: 'Everyone' },
      { syntax: 'Compare with previous', desc: 'Compare this message against the prior non-bot message.', type: 'context', perm: 'Everyone' },
      { syntax: 'Force React (SeekDeep)', desc: 'Paginated emoji picker.', type: 'context', perm: 'Everyone', flag: 'SEEKDEEP_FEATURE_FORCE_REACT=on' },
    ]
  },
  {
    id: 'reactions', title: 'Reaction shortcuts', meta: '3 reactions',
    note: 'React on any SeekDeep image message. Only the original requester (or an admin) can trigger these.',
    cmds: [
      { syntax: '📥  (inbox tray)', desc: 'Archive the image to your personal archive thread.', type: 'reaction', perm: 'Requester / Admin' },
      { syntax: '🗑  (wastebasket)', desc: 'Delete the bot message.', type: 'reaction', perm: 'Requester / Admin' },
      { syntax: '🔁  (counterclockwise)', desc: 'Regenerate (refined).', type: 'reaction', perm: 'Requester / Admin' },
    ]
  },
  {
    id: 'wiring', title: 'Live wiring (GUI ↔ backend)', meta: '5 endpoints',
    note: '<strong>Control Center</strong> (<span class="mono">app.html</span>) and <strong>Chat client</strong> (<span class="mono">chat.html</span>) poll the local AI server every <strong>5s</strong> and fill in real data when reachable. A pill in the title bar reflects mode: <span class="mono" style="color:var(--good)">LIVE · :7865</span> when alive, <span class="mono" style="color:var(--warn)">OFFLINE · :7865</span> otherwise. Three consecutive timeouts are required to flip to OFFLINE so brief network blips don\'t cause flicker.',
    cmds: [
      { syntax: 'GET http://127.0.0.1:7865/health', desc: 'Returns <span class="mono">{ device, cuda_available, model, loaded, keep_resident, gpu: {...} }</span>. Powers the LIVE pill, model name, VRAM stat in the status bar.', type: 'mention', perm: 'Everyone' },
      { syntax: 'GET http://127.0.0.1:7865/gpu', desc: 'Returns <span class="mono">{ allocated_mb, reserved_mb, free_mb, total_mb, used_mb, used_pct, reserved_pct, loaded, keep_resident, device_name }</span>. Powers the GPU pane cards on the Control Center.', type: 'mention', perm: 'Everyone' },
      { syntax: 'GET http://127.0.0.1:8080  (SearXNG)', desc: 'Installer step 6 probes this with <span class="mono">no-cors</span> mode — any response = container is up. Not polled afterward.', type: 'mention', perm: 'Everyone' },
      { syntax: 'GET http://127.0.0.1:7865/health  (installer)', desc: 'Installer step 2 (System check) and step 8 (Launch + smoke) both fetch this with a 2s timeout and infer Node/Python/Docker/disk presence from the response.', type: 'mention', perm: 'Everyone' },
      { syntax: 'npm run doctor  (CLI fallback)', desc: 'Native Node diagnostic that runs the same checks as the installer wizard plus <span class="mono">.env</span> placeholder scanning and directory creation. Exit code 0 only when no FAILs.', type: 'mention', perm: 'Everyone' },
    ]
  },
  {
    id: 'cors', title: 'Browser CORS notes', meta: '3 caveats',
    note: 'The GUI pages are static HTML — they can only reach the local AI server if the browser is allowed to. Three options, easiest first.',
    cmds: [
      { syntax: 'OPTION 1 — serve the pages from the bot itself', desc: 'Drop these HTML files into a folder served by <span class="mono">local_ai_server.py</span> (e.g. mount <span class="mono">/static</span>). Same-origin, no CORS at all. Recommended.', type: 'mention', perm: 'Everyone' },
      { syntax: 'OPTION 2 — enable CORS on the FastAPI server', desc: 'Add <span class="mono">CORSMiddleware</span> with <span class="mono">allow_origins=["*"]</span> (dev only — restrict in production). Then opening <span class="mono">file://</span> works.', type: 'mention', perm: 'Everyone' },
      { syntax: 'OPTION 3 — proxy via a local web server', desc: 'Run <span class="mono">python -m http.server</span> in the GUI folder and reverse-proxy <span class="mono">/api</span> → <span class="mono">:7865</span>. Reverse-proxying also avoids the CORS headers entirely.', type: 'mention', perm: 'Everyone' },
    ]
  },
];

// ============================================================
// SYNTAX HIGHLIGHTER
// ============================================================
function hl(syntax) {
  // Escape first
  let s = syntax.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // @Mention
  s = s.replace(/(@SeekDeep)/g, '<span class="at">$1</span>');
  // /slash at start of token
  s = s.replace(/(^|\s)(\/[a-z]+)/g, '$1<span class="sl">$2</span>');
  // &lt;args&gt; placeholders
  s = s.replace(/(&lt;[^&]+&gt;)/g, '<span class="arg">$1</span>');
  // [optional] args
  s = s.replace(/(\[[^\]]+\])/g, '<span class="opt">$1</span>');
  return s;
}

// ============================================================
// RENDER
// ============================================================
const sectionsEl = document.getElementById('sections');
const sidebarEl  = document.getElementById('sidebar');
const totCount   = DATA.reduce((n, s) => n + s.cmds.length, 0);
document.getElementById('totCount').textContent = totCount;

// Sidebar
const sbHeader = document.createElement('div');
sbHeader.className = 'grp';
sbHeader.innerHTML = '<span>SECTIONS</span><span style="color:var(--cyan-1);">' + DATA.length + '</span>';
sbHeader.style.display = 'flex';
sbHeader.style.justifyContent = 'space-between';
sidebarEl.appendChild(sbHeader);
DATA.forEach((sec, i) => {
  const a = document.createElement('a');
  a.className = 'sec-link';
  a.href = '#sec-' + sec.id;
  a.innerHTML = `<span>${sec.title}</span><span class="ct">${sec.cmds.length}</span>`;
  a.addEventListener('click', e => {
    e.preventDefault();
    const tgt = document.getElementById('sec-' + sec.id);
    if (tgt) document.querySelector('.main').scrollTo({ top: tgt.offsetTop - 16, behavior: 'smooth' });
  });
  sidebarEl.appendChild(a);
});
// Resources group
const sbRes = document.createElement('div');
sbRes.className = 'grp';
sbRes.textContent = 'EXTERNAL';
sidebarEl.appendChild(sbRes);
const links = [
  { label: 'COMMANDS.md', href: 'https://github.com/NathanNeurotic/SeekDeep-DiscordBot/blob/main/COMMANDS.md', meta: 'SOURCE' },
  { label: 'README.md',   href: 'https://github.com/NathanNeurotic/SeekDeep-DiscordBot/blob/main/README.md',   meta: 'SOURCE' },
  { label: 'PLANNED.md',  href: 'https://github.com/NathanNeurotic/SeekDeep-DiscordBot/blob/main/PLANNED.md',  meta: 'ROADMAP' },
  { label: 'GitHub repo', href: 'https://github.com/NathanNeurotic/SeekDeep-DiscordBot', meta: 'REPO' },
];
links.forEach(l => {
  const a = document.createElement('a');
  a.className = 'sec-link';
  a.href = l.href; a.target = '_blank';
  a.innerHTML = `<span>${l.label}</span><span class="ct">${l.meta}</span>`;
  sidebarEl.appendChild(a);
});

// Sections + cards
// Derive a "N commands" string from cmds.length, preserving any non-count
// suffix in sec.meta (e.g. "feature-flagged" or other annotations). This
// keeps the counts honest even when entries are added/removed without
// updating the meta string. Pattern: replace "<digits> commands" with the
// real count; leave the rest of the meta intact.
function _docsCmdMeta(sec) {
  const n = sec.cmds.length;
  const phrase = n + ' command' + (n === 1 ? '' : 's');
  if (typeof sec.meta !== 'string') return phrase;
  if (/\d+\s+commands?/i.test(sec.meta)) {
    return sec.meta.replace(/\d+\s+commands?/i, phrase);
  }
  // No "N commands" in the meta — prepend it.
  return phrase + (sec.meta ? ' · ' + sec.meta : '');
}

DATA.forEach(sec => {
  const sectionEl = document.createElement('section');
  sectionEl.className = 'sec';
  sectionEl.id = 'sec-' + sec.id;
  sectionEl.innerHTML = `
    <div class="sec-head">
      <h2>${sec.title}</h2>
      <span class="meta">▸ <em>${sec.cmds.length}</em> · ${_docsCmdMeta(sec)}</span>
    </div>
    ${sec.note ? `<div class="note">${sec.note}</div>` : ''}
    <div class="cmd-grid"></div>
  `;
  const grid = sectionEl.querySelector('.cmd-grid');

  sec.cmds.forEach(c => {
    const card = document.createElement('div');
    card.className = 'cmd';
    card.dataset.type = c.type;
    card.dataset.perm = c.perm;
    card.dataset.search = (c.syntax + ' ' + c.desc + ' ' + c.perm + ' ' + sec.title).toLowerCase();
    const permClass = 'perm-' + c.perm.toLowerCase().replace(/[^a-z]/g, '');
    card.innerHTML = `
      <div class="cmd-head">
        <div class="cmd-syntax">${hl(c.syntax)}</div>
        <div class="cmd-meta">
          <span class="badge type-${c.type}">${
            c.type === 'mention' ? '@' :
            c.type === 'slash' ? '/' :
            c.type === 'context' ? 'CTX' : 'RXN'
          }</span>
          <span class="badge ${permClass}">${c.perm}</span>
        </div>
      </div>
      <div class="cmd-desc">${c.desc}</div>
      ${c.flag ? `<div class="cmd-flag" data-flag-key="${String(c.flag).split('=')[0].trim()}"><a class="mono" href="settings.html#${String(c.flag).split('=')[0].trim()}" style="color:inherit;text-decoration:underline dotted;text-underline-offset:2px" title="Open this setting in All Settings">▸ ${String(c.flag).split('=')[0].trim()}</a><button type="button" class="ff-toggle" aria-pressed="false" title="Toggle this feature — saved instantly; a one-click Restart bar appears to apply it">···</button></div>` : ''}
    `;
    grid.appendChild(card);
  });

  sectionsEl.appendChild(sectionEl);
});

// ============================================================
// FILTERING
// ============================================================
let q = '';
let typeFilter = 'all';
let permFilter = 'all';

function applyFilter() {
  let vis = 0;
  document.querySelectorAll('.cmd').forEach(c => {
    const matchesQ = !q || c.dataset.search.includes(q);
    const matchesT = typeFilter === 'all' || c.dataset.type === typeFilter;
    const matchesP = permFilter === 'all' || c.dataset.perm === permFilter;
    const show = matchesQ && matchesT && matchesP;
    c.style.display = show ? '' : 'none';
    if (show) vis++;
  });
  // Hide section if no visible cards
  document.querySelectorAll('.sec').forEach(s => {
    const anyVisible = [...s.querySelectorAll('.cmd')].some(c => c.style.display !== 'none');
    s.style.display = anyVisible ? '' : 'none';
  });
  document.getElementById('visCount').textContent = vis;
  document.getElementById('empty').style.display = vis === 0 ? '' : 'none';
}

document.getElementById('searchInput').addEventListener('input', e => {
  q = e.target.value.trim().toLowerCase();
  applyFilter();
});
document.querySelectorAll('[data-filter-type]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-filter-type]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    typeFilter = chip.dataset.filterType;
    applyFilter();
  });
});
document.querySelectorAll('[data-filter-perm]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('[data-filter-perm]').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    permFilter = chip.dataset.filterPerm;
    applyFilter();
  });
});

// Keyboard: / focuses search
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  }
});

applyFilter();
