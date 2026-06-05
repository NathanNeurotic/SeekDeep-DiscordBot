const slides = document.querySelectorAll('.slide');
const tot = slides.length;
let idx = 0;
document.getElementById('totIdx').textContent = tot;

function show(i) {
  idx = Math.max(0, Math.min(tot - 1, i));
  slides.forEach((s, j) => s.classList.toggle('active', j === idx));
  document.getElementById('curIdx').textContent = idx + 1;
  document.getElementById('next').textContent = (idx === tot - 1) ? '✓ Finish' : 'NEXT →';
}

document.getElementById('prev').addEventListener('click', () => show(idx - 1));
document.getElementById('next').addEventListener('click', () => {
  if (idx === tot - 1) location.href = 'index.html';
  else show(idx + 1);
});

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (idx === tot - 1) location.href = 'index.html'; else show(idx + 1); }
  else if (e.key === 'ArrowLeft') { show(idx - 1); }
  else if (e.key === 'Home') show(0);
  else if (e.key === 'End') show(tot - 1);
  else if (e.key === 'Escape') location.href = 'index.html';
});

// Scale stage to fit viewport
function fit() {
  const stage = document.getElementById('stage');
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = Math.min(vw / 1920, vh / 1080);
  // translate(-50%,-50%) centers the stage in the deck regardless of how grid
  // would (mis)align an item wider than the viewport; scale fits it to size.
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
fit();
window.addEventListener('resize', fit);
