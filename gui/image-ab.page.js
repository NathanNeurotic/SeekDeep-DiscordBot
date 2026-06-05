(function () {
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];

  // Enable/disable pipeline toggles
  $$('.pipe-toggle').forEach(t => t.addEventListener('click', e => {
    if (e.target.tagName === 'INPUT') return;
    t.classList.toggle('on');
    const checked = t.classList.contains('on');
    t.querySelector('input').checked = checked;
    const pipe = t.dataset.toggle;
    $(`.pipe-panel[data-pipe="${pipe}"]`).classList.toggle('disabled', !checked);
  }));

  $('#randomSeed').addEventListener('click', () => {
    $('#seed').value = Math.floor(Math.random() * 2**31);
  });

  // Source preview from URL
  function refreshSrcPreview() {
    const url = $('#srcUrl').value.trim();
    const p = $('#srcPreview');
    if (url && /^(?:https?:|data:image\/|blob:)/i.test(url)) {
      // FE-2: build the <img> via the DOM (not innerHTML + an inline onerror) so a
      // pasted URL can't break out into markup; and only accept image-bearing schemes
      // so a tainted value can't reach a script-capable sink (CodeQL js/xss-through-dom).
      p.textContent = '';
      const img = document.createElement('img');
      img.alt = '';
      img.addEventListener('error', () => { p.textContent = 'SOURCE URL UNREACHABLE'; });
      img.src = url;
      p.appendChild(img);
    } else if (url) {
      p.textContent = 'SOURCE URL UNREACHABLE';
    } else {
      p.textContent = 'DROP SOURCE IMAGE';
    }
  }
  $('#srcUrl').addEventListener('input', refreshSrcPreview);

  // Convert a source URL (http(s):// OR data: OR blob:) into a raw
  // base64 string the backend's image_b64 field expects. The img2img /
  // pix2pix / inpaint backends previously received `image_url` from
  // this GUI but their pydantic models declare image_b64 only — every
  // POST 422'd on the wire. This helper bridges the gap.
  async function srcToB64(url) {
    if (!url) throw new Error('empty source URL');
    // data: URLs already carry their own base64 payload — slice it out.
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) throw new Error('malformed data: URL');
      return url.slice(comma + 1);
    }
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`fetch source ${r.status}`);
    const blob = await r.blob();
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || '');
        const comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
      fr.readAsDataURL(blob);
    });
  }

  // Run all enabled pipelines
  const PIPES = {
    txt2img:  { path: '/image',              needsSrc: false },
    img2img:  { path: '/img2img',            needsSrc: true  },
    pix2pix:  { path: '/instruct-pix2pix',   needsSrc: true,  needsInstruction: true },
    inpaint:  { path: '/inpaint',            needsSrc: true,  needsMask: true },
  };

  function setStatus(panel, label, cls) {
    const p = panel.querySelector('[data-status]');
    p.className = 'pill ' + cls;
    p.innerHTML = '<span class="dot"></span>' + label;
  }

  async function runOne(pipe) {
    const panel = $(`.pipe-panel[data-pipe="${pipe}"]`);
    if (!panel || panel.classList.contains('disabled')) return;
    const spec = PIPES[pipe];
    const src = $('#srcUrl').value.trim();
    if (spec.needsSrc && !src) {
      setStatus(panel, 'NEED SOURCE', 'warn');
      return;
    }
    const out = panel.querySelector('[data-out]');
    setStatus(panel, 'GENERATING', 'cyan');
    panel.querySelector('[data-seed]').textContent = $('#seed').value;
    panel.querySelector('[data-ms]').textContent = '…';
    out.classList.remove('has-image');
    out.innerHTML = '<span style="color:var(--cyan-1);">▸ POST ' + spec.path + '</span>';

    const body = {
      prompt: $('#prompt').value,
      negative_prompt: $('#negPrompt').value,
      seed: Number($('#seed').value),
      steps: Number($('#steps').value),
      guidance_scale: Number($('#cfg').value),
    };
    const [w, h] = $('#res').value.split('×').map(Number);
    body.width = w; body.height = h;
    // Backend pydantic models (Img2ImgRequest, InpaintRequest,
    // InstructPix2PixRequest) require image_b64 — a base64 string of
    // the raw image bytes. The GUI used to send `image_url` here,
    // which produced silent 422s for every non-txt2img pipeline.
    if (spec.needsSrc) {
      try {
        body.image_b64 = await srcToB64(src);
      } catch (err) {
        out.innerHTML = `<span style="color:var(--bad);">▸ couldn't fetch source · ${String(err.message || err).slice(0, 120)}</span>`;
        setStatus(panel, 'NO SOURCE', 'bad');
        return;
      }
    }
    if (spec.needsInstruction) body.instruction = $('#instruction').value;
    // /inpaint and /inpaint_mask_preview both expect `remove_target`
    // (not `mask_prompt`). Pydantic v2 has no aliasing, so the wire
    // name must match the field name exactly.
    if (spec.needsMask) body.remove_target = $('#mask').value;

    const t0 = performance.now();
    try {
      const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : ((window.__TAURI__ || (location.hostname || '') === 'tauri.localhost') ? 'http://127.0.0.1:7865' : ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'http://127.0.0.1:7865'));
      const r = await fetch(base + spec.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      const dt = Math.round(performance.now() - t0);
      panel.querySelector('[data-ms]').textContent = dt + 'ms';
      const ct = r.headers.get('Content-Type') || '';
      if (ct.includes('image/')) {
        const blob = await r.blob();
        out.classList.add('has-image');
        out.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="" />`;
        setStatus(panel, 'OK', 'on');
      } else {
        const data = await r.json().catch(() => null);
        if (data?.image_b64) {
          out.classList.add('has-image');
          out.innerHTML = `<img src="data:image/png;base64,${data.image_b64}" alt="" />`;
          setStatus(panel, 'OK', 'on');
        } else {
          out.classList.remove('has-image');
          out.innerHTML = '<span style="color:var(--bad);">▸ ' + r.status + ' · no image returned</span>';
          setStatus(panel, 'FAIL', 'bad');
        }
      }
    } catch (e) {
      panel.querySelector('[data-ms]').textContent = '—';
      out.classList.remove('has-image');
      // Escape the error message — a hostile server response could embed
      // HTML; we don't want it rendering as live markup.
      const errEscaped = String(e?.message || e || '').slice(0, 80)
        .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      out.innerHTML = `<span style="color:var(--bad);">▸ OFFLINE · ${errEscaped}<br><br>showing canned placeholder</span>`;
      setStatus(panel, 'OFFLINE', 'warn');
    }
  }

  $('#runBtn').addEventListener('click', () => {
    Object.keys(PIPES).forEach(p => runOne(p));
  });

  // "USE AS SRC" — copy a generated image into the source URL field
  $$('[data-act="reuse"]').forEach(b => b.addEventListener('click', e => {
    const panel = e.target.closest('.pipe-panel');
    const img = panel.querySelector('[data-out] img');
    if (!img) return;
    $('#srcUrl').value = img.src;
    refreshSrcPreview();
  }));

  // "SAVE" — download the generated image. Used to be dead (no listener);
  // user clicks SAVE on a generated image and nothing happens. Now triggers
  // a browser download via a synthetic <a download> click. Works for both
  // blob: URLs (image/* response) and data: URLs (b64 in JSON response).
  // Filename: <pipe>-<seed>.png so multiple pipes don't overwrite each other.
  $$('[data-act="save"]').forEach(b => b.addEventListener('click', e => {
    const panel = e.target.closest('.pipe-panel');
    const img = panel?.querySelector('[data-out] img');
    if (!img || !img.src) {
      (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:'Nothing to save yet', body:'Click GENERATE first.'});
      return;
    }
    const pipe = panel.dataset.pipe || 'image';
    const seed = panel.querySelector('[data-seed]')?.textContent || 'unknown';
    const a = document.createElement('a');
    a.href = img.src;
    a.download = `seekdeep-${pipe}-seed${seed}.png`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }));

  // "PREVIEW MASK" — only on the inpaint panel. Hits /inpaint_mask_preview
  // with the current source URL + mask target phrase, then renders the
  // returned mask PNG into the panel's output cell so the user can see
  // what CLIPSeg actually matched BEFORE running the full inpaint.
  $$('[data-act="mask"]').forEach(b => b.addEventListener('click', async e => {
    const panel = e.target.closest('.pipe-panel');
    const src = $('#srcUrl').value.trim();
    const maskPrompt = $('#mask').value.trim();
    if (!src || !maskPrompt) {
      (window.SeekDeepNotify?.toast || ((o)=>alert(o.title)))({tone:'warn', title:'Missing input', body:'Need both a source image URL and a mask target phrase.'});
      return;
    }
    const out = panel.querySelector('[data-out]');
    const setStatus = (txt, tone) => {
      const pill = panel.querySelector('[data-status]');
      if (pill) { pill.className = 'pill' + (tone ? ' ' + tone : ''); pill.innerHTML = `<span class="dot"></span>${txt}`; }
    };
    setStatus('MASKING', 'cyan');
    out.innerHTML = '<span style="color:var(--cyan-1);">▸ POST /inpaint_mask_preview</span>';
    let image_b64;
    try {
      image_b64 = await srcToB64(src);
    } catch (err) {
      out.innerHTML = `<span style="color:var(--bad);">▸ couldn't fetch source · ${String(err.message || err).slice(0, 120)}</span>`;
      setStatus('NO SOURCE', 'bad');
      return;
    }
    try {
      const base = (typeof window !== 'undefined' && typeof window.SeekDeepResolveBase === 'function') ? window.SeekDeepResolveBase() : 'http://127.0.0.1:7865';
      const r = await fetch(base + '/inpaint_mask_preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64, remove_target: maskPrompt }),
        signal: AbortSignal.timeout(60_000),
      });
      const ct = r.headers.get('Content-Type') || '';
      if (ct.startsWith('image/')) {
        const blob = await r.blob();
        out.innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="mask preview" style="max-width:100%;" />`;
        setStatus('MASK OK', 'on');
      } else {
        const data = await r.json().catch(() => null);
        if (data?.image_b64) {
          out.innerHTML = `<img src="data:image/png;base64,${data.image_b64}" alt="mask preview" style="max-width:100%;" />`;
          setStatus('MASK OK', 'on');
        } else {
          out.innerHTML = `<span style="color:var(--bad);">▸ ${r.status} · no mask returned</span>`;
          setStatus('FAIL', 'bad');
        }
      }
    } catch (err) {
      out.innerHTML = `<span style="color:var(--bad);">▸ ${String(err && err.message || err).slice(0, 120)}</span>`;
      setStatus('OFFLINE', 'warn');
    }
  }));
})();
