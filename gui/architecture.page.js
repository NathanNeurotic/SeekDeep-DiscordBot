// ===========================================================
// NODES — positioned on a 1100 × 920 canvas
// ===========================================================
const NODES = {
  discord: {
    layer: 'external', x: 470, y: 14, w: 160,
    title: 'Discord Gateway',
    meta: 'External · WebSocket',
    summary: 'Discord\'s WebSocket gateway. Source of every message, interaction, and reaction the bot reacts to.',
    fields: { protocol: 'WSS', auth: 'DISCORD_TOKEN', shape: 'discord.js v14' },
    talks: ['index'],
  },
  searxng: {
    layer: 'external', x: 880, y: 470, w: 170,
    title: 'SearXNG',
    meta: 'External · :8080',
    summary: 'Privacy-respecting metasearch engine running in a docker container. Backs <span class="mono">web:auto</span> and <span class="mono">web:always</span> chat routes.',
    fields: { container: 'docker compose', host: '127.0.0.1:8080', purpose: 'web routing' },
    talks: ['chatAgent'],
  },

  index: {
    layer: 'bot', x: 460, y: 96, w: 180,
    title: 'index.js',
    meta: 'Node · ~24.5k lines',
    summary: 'The Discord bot entry point. Handles three top-level event hooks and dispatches everything downstream.',
    fields: { runtime: 'Node 22+', size: '~24.5k lines ESM', entry: 'node index.js' },
    talks: ['discord', 'msgCreate', 'interaction', 'reactionAdd', 'persistence'],
  },

  msgCreate: {
    layer: 'router', x: 130, y: 220, w: 200,
    title: 'messageCreate',
    meta: 'Event handler',
    summary: 'Routes raw messages: archive shortcuts, config commands, persona overrides, search, reactrule edits, plus the mention dispatch.',
    fields: { routes: 'archive, config, stats, persona, reactrule', extracted: 'seekdeepDispatchAddressedMessage' },
    talks: ['index', 'dispatcher'],
  },
  interaction: {
    layer: 'router', x: 360, y: 220, w: 180,
    title: 'interactionCreate',
    meta: 'Event handler',
    summary: 'Slash commands, button clicks, modal submits, autocomplete. Owns <span class="mono">/ask</span> <span class="mono">/image</span> <span class="mono">/vision</span> <span class="mono">/stats</span> and friends.',
    fields: { routes: '/ask /image /vision /stats /recent /persona /template', kind: 'interaction.isChatInputCommand()' },
    talks: ['index', 'dispatcher'],
  },
  reactionAdd: {
    layer: 'router', x: 570, y: 220, w: 200,
    title: 'reactionAdd',
    meta: 'Event handler',
    summary: 'React-on-bot shortcuts: 📥 archive · 🗑 delete · 🔁 regenerate. Plus auto-reaction rule matching.',
    fields: { shortcuts: '📥 🗑 🔁', emoji_vault: 'gated · SEEKDEEP_FEATURE_EMOJI_VAULT' },
    talks: ['index', 'reactRules', 'persistence'],
  },
  contextMenu: {
    layer: 'router', x: 800, y: 220, w: 200,
    title: 'context menu',
    meta: '11 app commands',
    summary: 'Right-click → Apps → SeekDeep submenu. Includes Generate Image, Refine, Describe, Upscale, img2img, Edit, Remove, Inspect, Translate, Compare, Force React.',
    fields: { kind: 'interaction.isMessageContextMenuCommand()', count: '11 entries' },
    talks: ['dispatcher'],
  },

  dispatcher: {
    layer: 'bot', x: 460, y: 340, w: 180,
    title: 'address dispatcher',
    meta: 'seekdeepDispatch*',
    summary: 'Routes mention-addressed messages into the right agent. Pre-classifies image-vs-text-vs-vision intent, validates feature flags, checks per-user cooldowns.',
    fields: { fn: 'seekdeepDispatchAddressedMessage', size: '~370 lines', routes: 'chat · image · vision · upscale · img2img · pix2pix · inpaint' },
    talks: ['msgCreate', 'interaction', 'contextMenu', 'chatAgent', 'imageAgent', 'visionAgent'],
  },

  chatAgent: {
    layer: 'service', x: 130, y: 460, w: 200,
    title: 'chat agent',
    meta: 'role-routed',
    summary: 'Dispatches to <span class="mono">default_chat</span>, <span class="mono">quality_text</span>, <span class="mono">reasoning_code</span>, <span class="mono">lightweight_chat</span>, or <span class="mono">fallback_chat</span>. Owns refinement, web-routing, and memory injection.',
    fields: { roles: '5 chat models', memory: 'rolling · per-user scope', web: 'auto · off · always' },
    talks: ['dispatcher', 'searxng', 'aiServer'],
  },
  imageAgent: {
    layer: 'service', x: 380, y: 460, w: 200,
    title: 'image agent',
    meta: 'txt2img · img2img · inpaint · pix2pix',
    summary: 'Builds the request, runs prompt refinement through default_chat, picks the right pipeline based on intent, posts the result with action buttons.',
    fields: { pipelines: 'txt2img · img2img · pix2pix · inpaint · upscale', refiner: 'pinned to default_chat' },
    talks: ['dispatcher', 'aiServer'],
  },
  visionAgent: {
    layer: 'service', x: 630, y: 460, w: 200,
    title: 'vision agent',
    meta: 'describe + ocr modes',
    summary: 'Routes vision questions to <span class="mono">/vision</span>. Walks <span class="mono">messageSnapshots</span> to resolve forwarded-message attachments. OCR mode raises max-tokens to 1500.',
    fields: { model: 'Qwen2.5-VL-3B', modes: 'describe · ocr' },
    talks: ['dispatcher', 'aiServer'],
  },

  aiServer: {
    layer: 'server', x: 380, y: 580, w: 350,
    title: 'local_ai_server.py',
    meta: 'FastAPI · :7865 · task-LRU',
    summary: 'Python FastAPI server. Holds one chat model resident at a time (task-LRU), serves SDXL + Qwen-VL pipelines, manages VRAM safety budget and singleflight request serialization.',
    fields: { runtime: 'Python 3.11+', port: '7865', strategy: 'MODEL_KEEP_MODE=task-lru', singleflight: 'one request at a time per pipeline' },
    talks: ['chatAgent', 'imageAgent', 'visionAgent', 'health', 'chatEp', 'imageEp', 'visionEp', 'editEp', 'utilEp'],
  },

  health: {
    layer: 'server', x: 50, y: 720, w: 130,
    title: '/health · /gpu',
    meta: 'GET',
    summary: 'Diagnostics endpoints. <span class="mono">/health</span> includes model + nested gpu. <span class="mono">/gpu</span> is a one-shot VRAM snapshot. Powers Control Center + API Explorer.',
    fields: { '/health': 'state + gpu', '/gpu': 'VRAM only', poll: '5s default' },
    talks: ['aiServer'],
  },
  chatEp: {
    layer: 'server', x: 210, y: 720, w: 130,
    title: '/chat',
    meta: 'POST',
    summary: 'Role-routed text generation. Picks the model based on <span class="mono">role</span>; falls back if load fails. 1.0-1.4s typical latency on Llama-3.1-8B 4bit.',
    fields: { models: 'Llama, Mistral-Nemo, Phi-4, Granite, Gemma-3n', quant: '4bit default' },
    talks: ['aiServer'],
  },
  imageEp: {
    layer: 'server', x: 370, y: 720, w: 160,
    title: '/image · /img2img',
    meta: 'POST · SDXL',
    summary: 'Dreamshaper-XL pipeline. 28 steps standard, dpmsolver++ scheduler. img2img shares the same pipe via <span class="mono">AutoPipelineForImage2Image.from_pipe()</span>.',
    fields: { model: 'Lykon/dreamshaper-xl-1-0', scheduler: 'dpmsolver++', steps: '28' },
    talks: ['aiServer'],
  },
  editEp: {
    layer: 'server', x: 560, y: 720, w: 160,
    title: '/inpaint · /pix2pix',
    meta: 'POST',
    summary: 'CLIPSeg auto-mask + SDXL inpaint pipeline. InstructPix2Pix for natural-language edits. Both gated by feature flags.',
    fields: { inpaint: 'CIDAS/clipseg + SDXL', pix2pix: 'timbrooks/instruct-pix2pix' },
    talks: ['aiServer'],
  },
  visionEp: {
    layer: 'server', x: 750, y: 720, w: 130,
    title: '/vision',
    meta: 'POST',
    summary: 'Qwen2.5-VL-3B describes images or extracts text. <span class="mono">LOCAL_VISION_KEEP_RESIDENT=on</span> pins it across task switches.',
    fields: { model: 'Qwen/Qwen2.5-VL-3B-Instruct', modes: 'describe · ocr' },
    talks: ['aiServer'],
  },
  utilEp: {
    layer: 'server', x: 910, y: 720, w: 150,
    title: '/upscale · /chart · /unload',
    meta: 'POST',
    summary: 'Utility endpoints. <span class="mono">/upscale</span> uses PIL Lanczos + sharpen. <span class="mono">/chart</span> renders matplotlib stats. <span class="mono">/unload</span> clears CUDA + the resident chat model.',
    fields: { upscale: 'lanczos · realesrgan scaffolded', chart: 'matplotlib', unload: 'force evict' },
    talks: ['aiServer'],
  },

  persistence: {
    layer: 'data', x: 50, y: 360, w: 60,
    title: 'data/*',
    meta: 'JSON store',
    summary: 'On-disk state. Read-on-demand, atomic writes. 6 files cover archive config, persona overrides, server stats, memory presets, prompt templates, and auto-reactions.',
    fields: {
      'archive-guild-config.json': 'guild archive channel + threads',
      'persona-overrides.json': 'channel/server persona + feature toggles',
      'server-stats.json': 'image/chat/vision daily buckets',
      'memory-presets.json': 'user behavior presets',
      'prompt-templates.json': 'saved image-prompt templates',
      'auto-reactions.json': 'reactrule patterns + builtins',
    },
    talks: ['index', 'reactionAdd', 'reactRules'],
  },
  reactRules: {
    layer: 'data', x: 870, y: 110, w: 150,
    title: 'reactrule engine',
    meta: 'substring + /regex/',
    summary: 'Pattern-matches incoming messages and applies emoji reactions. Built-in stacks: <span class="mono">long_message</span>, <span class="mono">forwarded</span>, <span class="mono">code_block</span>, <span class="mono">image_only</span>, <span class="mono">link_only</span>.',
    fields: { patterns: 'substring · /regex/flag', state: 'auto-reactions.json' },
    talks: ['reactionAdd', 'persistence'],
  },
};

// ===========================================================
// EDGES
// ===========================================================
// Build edge list from .talks (bidirectional)
const seen = new Set();
const EDGES = [];
Object.entries(NODES).forEach(([from, n]) => {
  (n.talks || []).forEach(to => {
    const k = [from, to].sort().join('::');
    if (seen.has(k)) return;
    seen.add(k);
    EDGES.push({ from, to });
  });
});

// ===========================================================
// RENDER NODES
// ===========================================================
const canvas = document.getElementById('canvas');
Object.entries(NODES).forEach(([id, n]) => {
  const el = document.createElement('div');
  el.className = 'node layer-' + n.layer;
  el.dataset.id = id;
  el.style.left = n.x + 'px';
  el.style.top  = n.y + 'px';
  if (n.w) el.style.width = n.w + 'px';
  el.innerHTML = `
    <div class="layer">${n.meta}</div>
    <div class="name">${n.title}</div>
  `;
  el.addEventListener('click', () => selectNode(id));
  el.addEventListener('mouseenter', () => hoverNode(id));
  el.addEventListener('mouseleave', () => hoverNode(null));
  canvas.appendChild(el);
});

// ===========================================================
// RENDER EDGES (SVG paths between node centers)
// ===========================================================
const svg = document.getElementById('edges');
const NS = 'http://www.w3.org/2000/svg';
function nodeCenter(id) {
  const n = NODES[id];
  const el = canvas.querySelector(`.node[data-id="${id}"]`);
  if (!el) return { x: n.x + 70, y: n.y + 25 };
  return {
    x: n.x + el.offsetWidth / 2,
    y: n.y + el.offsetHeight / 2,
  };
}
function edgeKey(e) { return e.from + '::' + e.to; }

EDGES.forEach(e => {
  const a = nodeCenter(e.from);
  const b = nodeCenter(e.to);
  // Smooth bezier — control points are vertically aligned
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c1 = { x: a.x, y: a.y + dy * 0.4 };
  const c2 = { x: b.x, y: b.y - dy * 0.4 };
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'edge');
  path.dataset.from = e.from;
  path.dataset.to = e.to;
  path.dataset.key = edgeKey(e);
  path.setAttribute('d', `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`);
  svg.appendChild(path);
});

// ===========================================================
// INTERACTION
// ===========================================================
let active = null;
let hover = null;

function relevantEdges(id) {
  return [...svg.querySelectorAll('path.edge')].filter(p =>
    p.dataset.from === id || p.dataset.to === id
  );
}

function hoverNode(id) {
  hover = id;
  if (active) return;
  svg.querySelectorAll('path.edge').forEach(p => p.classList.remove('highlight'));
  document.querySelectorAll('.node').forEach(n => n.classList.remove('active'));
  if (!id) {
    showDetails(null);
    return;
  }
  relevantEdges(id).forEach(p => p.classList.add('highlight'));
  canvas.querySelector(`.node[data-id="${id}"]`).classList.add('active');
  showDetails(id, true);
}

function selectNode(id) {
  active = id;
  svg.querySelectorAll('path.edge').forEach(p => p.classList.remove('highlight'));
  document.querySelectorAll('.node').forEach(n => n.classList.remove('active'));
  relevantEdges(id).forEach(p => p.classList.add('highlight'));
  canvas.querySelector(`.node[data-id="${id}"]`).classList.add('active');
  showDetails(id);
}

const details = document.getElementById('details');
function showDetails(id, isHover) {
  if (!id) {
    if (active) return; // keep showing the active node
    details.innerHTML = '<div class="empty">▸ <em>Hover or click</em> a node to see its details, files, ports, and which neighbors it talks to.</div>';
    return;
  }
  const n = NODES[id];
  const talks = (n.talks || []).map(t => `<span style="display:inline-block; padding:2px 8px; margin:2px 4px 2px 0; border:1px solid rgba(45,212,255,0.25); border-radius:2px; font-family:var(--font-mono); font-size:10px; color:var(--cyan-1); letter-spacing: 0.08em;">${NODES[t]?.title || t}</span>`).join('');
  const fields = Object.entries(n.fields || {}).map(([k,v]) =>
    `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`
  ).join('');
  details.innerHTML = `
    <h3>${n.title}</h3>
    <div class="meta-line">▸ ${n.meta}</div>
    <p>${n.summary}</p>
    ${fields ? '<h4>FIELDS</h4>' + fields : ''}
    ${talks ? '<h4>TALKS TO</h4><div>' + talks + '</div>' : ''}
  `;
}

// Click empty canvas to deselect
canvas.addEventListener('click', (e) => {
  if (!e.target.closest('.node')) {
    active = null;
    svg.querySelectorAll('path.edge').forEach(p => p.classList.remove('highlight'));
    document.querySelectorAll('.node').forEach(n => n.classList.remove('active'));
    showDetails(null);
  }
});

// Start with dispatcher selected — it's the centerpoint
selectNode('dispatcher');
