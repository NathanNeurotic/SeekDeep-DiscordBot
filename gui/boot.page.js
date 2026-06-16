const STEPS = [
  { src: 'launcher',   msg: 'seekdeep_launcher.bat &middot; option <span class="hl">8</span> (clean start)', res: 'OK',    cls: 'ok' },
  { src: 'env',        msg: 'load <span class="hl">.env</span> &middot; redact tokens before logging',       res: 'OK',    cls: 'ok' },
  { src: 'docker',     msg: 'docker compose up <span class="hl">searxng</span>',                              res: 'OK',    cls: 'ok' },
  { src: 'searxng',    msg: 'listen <span class="hl">127.0.0.1:8080</span>',                                  res: 'UP',    cls: 'ok' },
  { src: 'python',     msg: 'spawn <span class="hl">local_ai_server.py</span> &middot; uvicorn',              res: 'BOOT',  cls: 'busy' },
  { src: 'cuda',       msg: 'detect <span class="hl">RTX 4090</span> &middot; 24 GB VRAM &middot; CUDA 12.4', res: 'OK',    cls: 'ok' },
  { src: 'model-load', msg: 'load <span class="hl">Llama-3.1-8B-Instruct</span> &middot; 4bit NF4',           res: 'WARM',  cls: 'busy' },
  { src: 'fastapi',    msg: 'listen <span class="hl">127.0.0.1:7865</span> &middot; uvicorn ready',           res: 'UP',    cls: 'ok' },
  { src: 'node',       msg: 'spawn <span class="hl">index.js</span> &middot; node 22+',                       res: 'BOOT',  cls: 'busy' },
  { src: 'discord',    msg: 'wss connect &middot; gateway intent <span class="hl">guildMessages</span>',      res: 'OK',    cls: 'ok' },
  { src: 'discord',    msg: 'logged in as <span class="hl">SeekDeep#4242</span> &middot; 3 guilds',           res: 'READY', cls: 'ok' },
  { src: 'router',     msg: '5 chat roles registered &middot; default &rarr; <span class="hl">Llama-3.1-8B</span>', res: 'OK', cls: 'ok' },
  { src: 'vram',       msg: 'budget <span class="hl">5.1 / 24 GB</span> &middot; <span class="hl">19 GB</span> headroom', res: 'OK', cls: 'ok' },
  { src: 'stack',      msg: '<span class="hl">all upstreams reachable</span> &middot; smoke test pass',       res: 'READY', cls: 'ok' },
];

const linesEl = document.getElementById('bootLines');
const progBar = document.getElementById('progBar');
const progPct = document.getElementById('progPct');
const progLabel = document.getElementById('progLabel');
const clockEl = document.getElementById('bootClock');

const BOOT_START = performance.now();
function tick() {
  const t = (performance.now() - BOOT_START) / 1000;
  const mm = Math.floor(t / 60);
  const ss = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  clockEl.textContent =
    String(mm).padStart(2,'0') + ':' +
    String(ss).padStart(2,'0') + '.' +
    String(ms).padStart(3,'0');
}
const clockInterval = setInterval(tick, 33);

let stepIndex = 0;
let done = false;

function ts() {
  const t = (performance.now() - BOOT_START) / 1000;
  return t.toFixed(3).padStart(6,'0') + 's';
}

function addStep(step) {
  const row = document.createElement('div');
  row.className = 'boot-line ' + (step.cls || '');
  row.innerHTML = `
    <span class="ts">${ts()}</span>
    <span class="src">[${step.src}]</span>
    <span class="msg">${step.msg}</span>
    <span class="res">${step.res}</span>
  `;
  linesEl.appendChild(row);
  linesEl.scrollTop = linesEl.scrollHeight;
  // trigger fade-in
  requestAnimationFrame(() => row.classList.add('in'));
  // update progress
  const pct = Math.round(((stepIndex + 1) / STEPS.length) * 100);
  progBar.style.width = pct + '%';
  progPct.textContent = pct + '%';
  progLabel.textContent = step.src.toUpperCase() + ' · ' + step.res;
}

function nextStep() {
  if (stepIndex >= STEPS.length) {
    finish();
    return;
  }
  addStep(STEPS[stepIndex]);
  stepIndex++;
  // Variable per-step delay (180-380ms) so it doesn't feel mechanical
  const delay = 180 + Math.random() * 200;
  setTimeout(nextStep, delay);
}

function finish() {
  if (done) return;
  done = true;
  clearInterval(clockInterval);
  progLabel.textContent = 'STACK READY';
  setTimeout(() => {
    document.body.classList.add('complete');
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 600);
  }, 500);
}

// Start after the logo animation has had a beat
setTimeout(nextStep, 700);

// Skip
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
    done = true;
    clearInterval(clockInterval);
    window.location.href = 'index.html';
  }
});
document.addEventListener('click', () => {
  if (done) return;
  // Click anywhere to skip
  done = true;
  clearInterval(clockInterval);
  window.location.href = 'index.html';
});
