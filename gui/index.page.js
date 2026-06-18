/* Populate the About-page "facts" grid + lead paragraph from the live bot
   config so it stays truthful when a user changes models / search backend.
   Reads:
     GET /health   → { version, loaded_chat_model_id, models: {chat,vision,image}, ... }
                      (see local_ai_server.py def health() for the full shape)
     GET /config   → { ok, env: { LOCAL_CHAT_MODEL_ID, LOCAL_VISION_MODEL_ID,
                                   LOCAL_IMAGE_MODEL_ID, SEARXNG_BASE_URL, ... } }
                      (gui_endpoints.py · GET /config — secrets redacted to '*****')
   When either is unreachable, the hardcoded defaults in the markup stay put.
   No fetch error toasts — fallback is silent by design. */
(function () {
  // Tauri 2 on Windows serves bundled pages from http://tauri.localhost.
  // Force 127.0.0.1:7865 in Tauri context; otherwise same-origin/fallback.
  const BASE = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function')
    ? window.SeekDeepResolveBase()
    : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost')
        ? 'http://127.0.0.1:7865'
        : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));

  // Surface count — derived from the page registry (gui/pages.js), the single
  // source of truth, so the Hub KPI stays accurate as pages are added/removed.
  // stats.js skips the 'surfaces' key so the server value can't clobber this.
  try {
    if (window.SeekDeepPages && typeof window.SeekDeepPages.navigable === 'function') {
      const n = String(window.SeekDeepPages.navigable().length);
      document.querySelectorAll('[data-stat-surfaces]').forEach((el) => { el.textContent = n; });
    }
  } catch (_) {}

  // Friendly family labels — match against the model ID and emit the first hit.
  // Order matters: more-specific patterns above more-generic ones.
  const FAMILIES = [
    { re: /qwen.*(?:vl|vision)/i,         label: 'Qwen-VL' },
    { re: /llama.*(?:vision|vl)/i,        label: 'Llama Vision' },
    { re: /llava/i,                       label: 'LLaVA' },
    { re: /llama/i,                       label: 'Llama' },
    { re: /qwen/i,                        label: 'Qwen' },
    { re: /granite/i,                     label: 'Granite' },
    { re: /mistral|mixtral/i,             label: 'Mistral' },
    { re: /phi-?\d/i,                     label: 'Phi' },
    { re: /gemma/i,                       label: 'Gemma' },
    { re: /deepseek/i,                    label: 'DeepSeek' },
    { re: /command-?r/i,                  label: 'Command-R' },
    { re: /sdxl|stable-?diffusion-?xl/i,  label: 'SDXL' },
    { re: /sd-?turbo/i,                   label: 'SD Turbo' },
    { re: /sd-?3|sd3/i,                   label: 'SD 3' },
    { re: /sd-?1\.5|sd15|stable-?diffusion-?1\.5/i, label: 'SD 1.5' },
    { re: /flux/i,                        label: 'FLUX' },
    { re: /playground/i,                  label: 'Playground v2.5' },
    { re: /piper/i,                       label: 'Piper TTS' },
    { re: /xtts/i,                        label: 'XTTS' },
  ];
  // Env keys we'll consult for model IDs, in order. Two conventions are
  // supported because the bot has shipped both at different points:
  //   · LOCAL_*_MODEL_ID — what gui_endpoints.py /config currently surfaces
  //     (LOCAL_CHAT_MODEL_ID / LOCAL_VISION_MODEL_ID / LOCAL_IMAGE_MODEL_ID)
  //   · <role>            — older role-keyed convention; harmless to keep
  //     in case a future revision starts emitting them again.
  const ROLE_KEYS = [
    'LOCAL_CHAT_MODEL_ID', 'LOCAL_VISION_MODEL_ID', 'LOCAL_IMAGE_MODEL_ID',
    'LOCAL_IMG2IMG_MODEL_ID', 'LOCAL_INPAINT_MODEL_ID', 'LOCAL_UPSCALE_MODEL_ID',
    'LOCAL_TTS_MODEL_ID',
    'default_chat', 'quality_text', 'lightweight_chat', 'reasoning_code',
    'fallback_chat', 'vision', 'image', 'img2img', 'inpaint',
    'instruct_pix2pix', 'upscale', 'chart', 'tts',
  ];

  function familyOf(id) {
    if (!id) return null;
    const s = String(id);
    for (const { re, label } of FAMILIES) if (re.test(s)) return label;
    // Fallback: take the first chunk of the HF/Ollama id, capitalize.
    const tail = s.split('/').pop().split(/[-_.]/)[0];
    if (!tail) return null;
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  function unique(arr) { return [...new Set(arr.filter(Boolean))]; }

  async function fetchJSON(path) {
    try {
      const r = await fetch(BASE + path, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async function populate() {
    const [health, config] = await Promise.all([fetchJSON('/health'), fetchJSON('/config')]);
    const env = (config && (config.env || config)) || {};

    // ----- Models: union of every configured role -----
    const ids = [];
    for (const k of ROLE_KEYS) {
      const v = env[k] ?? env[k.toUpperCase()];
      if (v) ids.push(v);
    }
    // /health surfaces both the currently-loaded chat role (loaded_chat_model_id)
    // and the configured-but-maybe-not-loaded ids under .models{chat,vision,image}.
    // The older single-string `health.model` / `health.loaded_model` keys are
    // kept as fallbacks for forward compatibility.
    if (health) {
      if (health.loaded_chat_model_id) ids.push(health.loaded_chat_model_id);
      if (health.models && typeof health.models === 'object') {
        for (const v of Object.values(health.models)) if (v) ids.push(v);
      }
      if (health.model) ids.push(health.model);
      if (health.loaded_model) ids.push(health.loaded_model);
    }
    const families = unique(ids.map(familyOf));
    if (families.length) {
      const dotJoin   = families.join(' · ');
      const commaJoin = families.length === 1
        ? families[0]
        : families.slice(0, -1).join(', ') + ' and ' + families.slice(-1);
      document.querySelectorAll('[data-fact="models"]').forEach(e => e.textContent = dotJoin);
      document.querySelectorAll('[data-fact-families]').forEach(e => e.textContent = commaJoin);
    }

    // ----- Search backend -----
    let searchLong = null, searchShort = null;
    if (env.SEARXNG_BASE_URL || env.SEARXNG_BASE || env.SEARXNG_URL ||
        env.searxng_base_url || env.searxng_url || env.searxng_base) {
      searchLong  = 'SearXNG (self-hosted)';
      searchShort = 'SearXNG';
    } else if (env.SEARCH_BACKEND) {
      searchLong  = String(env.SEARCH_BACKEND);
      searchShort = searchLong;
    } else if (env.WEB_SEARCH_DISABLED === 'true' || env.web_search_disabled === true) {
      searchLong  = '(disabled)';
      searchShort = 'no web search';
    } else if (config && config.ok) {
      // /config responded with a known env but no SearXNG key — bot really
      // does have web search disabled. Reflect that rather than lying.
      searchLong  = '(disabled)';
      searchShort = 'no web search';
    }
    if (searchLong) {
      document.querySelectorAll('[data-fact="search"]').forEach(e => e.textContent = searchLong);
      document.querySelectorAll('[data-fact-search]').forEach(e => e.textContent = searchShort);
    }

    // ----- Runtime -----
    if (health && (health.runtime_node || health.runtime_python || health.node || health.python)) {
      const parts = [];
      const n = health.runtime_node || health.node;
      const p = health.runtime_python || health.python;
      if (n) parts.push('Node ' + n);
      if (p) parts.push('Python ' + p);
      if (parts.length) {
        document.querySelectorAll('[data-fact="runtime"]').forEach(e => e.textContent = parts.join(' · '));
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', populate, { once: true });
  } else {
    populate();
  }
})();
