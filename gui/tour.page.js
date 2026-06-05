const STEPS = [
  {
    title: 'Welcome to SeekDeep',
    body: 'SeekDeep is a local-first Discord bot. Nothing leaves your machine — Llama, SDXL, Qwen-VL all run on your GPU. This 7-step tour walks you through the GUI surfaces.',
    tip: '▸ Press <strong>↵</strong> or <strong>→</strong> to advance · <strong>Esc</strong> to skip.',
    target: null,
  },
  {
    title: 'Launcher · the rail',
    body: 'The left rail in the Control Center holds 10 modules: launcher, GPU monitor, model manager, config, logs, chat playground, image playground, archive browser, auto-react rules, server stats.',
    target: 'm-sb-1',
  },
  {
    title: 'GPU & VRAM · live',
    body: 'Click GPU on the rail to see live VRAM stats. The page polls <span class="mono">/health</span> every 5 seconds — when the local AI server is running, the title-bar pill flips from <span class="mono">OFFLINE</span> to <span class="mono">LIVE</span>.',
    target: 'm-sb-2',
  },
  {
    title: 'Model manager',
    body: 'Browse, warm, pin, evict, or quantize models. Task-LRU swaps the resident chat model on demand; pinning keeps one in VRAM across task switches.',
    target: 'm-sb-3',
  },
  {
    title: 'Bot config · grouped',
    body: '10 collapsible sections cover Discord, models, VRAM, memory, image, chat generation, feature flags, personas, web search, and admin. Dirty values flash amber and a counter shows pending changes.',
    target: 'm-sb-4',
  },
  {
    title: 'Live logs',
    body: 'Tail <span class="mono">logs/seekdeep-YYYY-MM-DD.log</span> live with filters for INFO / WARN / ERROR and source tags (bot / ai-server / searxng / image / vision).',
    target: 'm-sb-5',
  },
  {
    title: 'You\'re ready',
    body: 'That\'s the lay of the land. The installer wizard, docs page, roadmap, API explorer, and architecture map all live in the top-nav.',
    tip: '▸ Open <span class="mono">index.html</span> to land on the hub.',
    target: null,
  },
];

let idx = 0;
const card = document.getElementById('card');
const spot = document.getElementById('spot');
const dotsEl = document.getElementById('dots');

// Build dots
STEPS.forEach((_, i) => {
  const d = document.createElement('i');
  d.addEventListener('click', () => go(i));
  dotsEl.appendChild(d);
});

function go(i) {
  if (i < 0 || i >= STEPS.length) return;
  idx = i;
  const s = STEPS[i];
  document.getElementById('stepNum').textContent = i + 1;
  document.getElementById('title').textContent = s.title;
  document.getElementById('body').innerHTML = s.body;
  const tipEl = document.getElementById('tip');
  if (s.tip) { tipEl.style.display = ''; tipEl.innerHTML = s.tip; }
  else tipEl.style.display = 'none';

  // Dots
  document.querySelectorAll('.tour-dots i').forEach((d, j) => d.classList.toggle('on', j === i));

  // Position spotlight
  if (s.target) {
    const t = document.getElementById(s.target);
    if (t) {
      const r = t.getBoundingClientRect();
      spot.style.opacity = '1';
      spot.style.boxShadow = '';
      spot.style.top = (r.top - 6) + 'px';
      spot.style.left = (r.left - 6) + 'px';
      spot.style.width = (r.width + 12) + 'px';
      spot.style.height = (r.height + 12) + 'px';
      // Position card to the right of the spotlight
      const cardX = r.right + 24;
      const cardY = Math.max(80, r.top - 40);
      card.style.left = Math.min(window.innerWidth - 410, cardX) + 'px';
      card.style.top = cardY + 'px';
      card.style.transform = 'none';
    }
  } else {
    spot.style.opacity = '0';
    spot.style.boxShadow = 'none';
    spot.style.top = '50%'; spot.style.left = '50%';
    spot.style.width = '0px'; spot.style.height = '0px';
    // Center the card
    card.style.left = '50%'; card.style.top = '50%';
    card.style.transform = 'translate(-50%, -50%)';
  }

  // Update buttons
  document.getElementById('prevBtn').disabled = i === 0;
  document.getElementById('nextBtn').textContent = (i === STEPS.length - 1) ? '✓ Finish' : 'Next →';
}

document.getElementById('nextBtn').addEventListener('click', () => {
  if (idx === STEPS.length - 1) finish();
  else go(idx + 1);
});
document.getElementById('prevBtn').addEventListener('click', () => go(idx - 1));
document.getElementById('skipBtn').addEventListener('click', finish);

function finish() {
  document.body.style.transition = 'opacity 0.4s ease';
  document.body.style.opacity = '0';
  setTimeout(() => { window.location.href = 'index.html'; }, 380);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    document.getElementById('nextBtn').click();
  } else if (e.key === 'ArrowLeft') {
    document.getElementById('prevBtn').click();
  } else if (e.key === 'Escape') {
    finish();
  }
});

// Start
go(0);
window.addEventListener('resize', () => go(idx));
