const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": ["#2dd4ff", "#00a8e8", "#0d2152"],
  "mode": "dark",
  "persona": "neurotic",
  "ambientMotion": true,
  "panelBlur": 18
} /*EDITMODE-END*/;
const APP_PALETTES = [["#2dd4ff", "#00a8e8", "#0d2152"],
// abyss cyan (default)
["#7af0c2", "#1da37a", "#02261a"],
// bioluminescent moss
["#ff6df0", "#a82cc4", "#1a0830"],
// anglerfish violet
["#ffb84d", "#c97b00", "#2a1a04"] // sodium glow
];
const APP_PERSONAS = {
  clinical: "terse · numbered · footnoted",
  neurotic: "hedged · second-guessing · asks back",
  unsettling: "ellipses · too-knowing pauses",
  chaotic: "CAPS LOCK · tangents · ENERGY"
};
function applyAppTweaks(t) {
  const root = document.documentElement;
  if (t.palette) {
    root.style.setProperty('--cyan-0', adjLightness(t.palette[0], 12));
    root.style.setProperty('--cyan-1', t.palette[0]);
    root.style.setProperty('--cyan-2', t.palette[1]);
    root.style.setProperty('--cyan-3', adjLightness(t.palette[1], -15));
    root.style.setProperty('--abyss-3', t.palette[2]);
    root.style.setProperty('--cyan-glow', `0 0 24px ${t.palette[0]}73`);
  }
  if (t.mode === 'light') {
    root.style.setProperty('--ink', '#eaf1fb');
    root.style.setProperty('--abyss-0', '#f4f8ff');
    root.style.setProperty('--abyss-1', '#e2ecf8');
    root.style.setProperty('--abyss-2', '#d5e2f3');
    root.style.setProperty('--abyss-4', '#9fb6d8');
    root.style.setProperty('--hull', '#021629');
    root.style.setProperty('--hull-2', '#1a2f4a');
    root.style.setProperty('--hull-3', '#5a6b85');
    root.style.setProperty('--panel', 'rgba(255,255,255,0.6)');
    root.style.setProperty('--stroke', 'rgba(13,33,82,0.18)');
  } else {
    root.style.setProperty('--ink', '#000a1f');
    root.style.setProperty('--abyss-0', '#02060f');
    root.style.setProperty('--abyss-1', '#050b1c');
    root.style.setProperty('--abyss-2', '#081434');
    root.style.setProperty('--abyss-4', '#14306b');
    root.style.setProperty('--hull', '#f4f8ff');
    root.style.setProperty('--hull-2', '#c7d6f0');
    root.style.setProperty('--hull-3', '#7d92b8');
    root.style.setProperty('--panel', 'color-mix(in oklab, var(--abyss-2) 70%, transparent)');
    root.style.setProperty('--stroke', 'color-mix(in oklab, var(--cyan-1) 22%, transparent)');
  }
  // motion
  document.querySelectorAll('.bubbles, .abyss::before').forEach(el => {
    el.style.animationPlayState = t.ambientMotion ? 'running' : 'paused';
  });
  if (!t.ambientMotion) {
    document.body.classList.add('no-motion');
  } else {
    document.body.classList.remove('no-motion');
  }
  // persona reflection in status bar
  const personaEl = document.getElementById('sb-persona');
  if (personaEl) personaEl.textContent = (t.persona || 'clinical').toUpperCase();
  // persona reflection in config grid
  document.querySelectorAll('#persona-grid .persona-card').forEach(c => {
    c.classList.toggle('active', c.dataset.persona === t.persona);
  });
  // panel blur
  document.querySelectorAll('.panel, .panel-flat').forEach(el => {
    el.style.backdropFilter = `blur(${t.panelBlur || 18}px) saturate(140%)`;
  });
}
function adjLightness(hex, delta) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16),
    g = parseInt(c.slice(2, 4), 16),
    b = parseInt(c.slice(4, 6), 16);
  const adj = v => Math.max(0, Math.min(255, v + delta * 2.55));
  const toHex = v => Math.round(adj(v)).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
const adjustLightness = adjLightness;
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    applyAppTweaks(t);
  }, [t.palette, t.mode, t.persona, t.ambientMotion, t.panelBlur]);
  // expose setTweak globally so vanilla config panel can sync persona
  React.useEffect(() => {
    window.__seekdeepSetTweak = setTweak;
  }, [setTweak]);
  // listen for persona changes from the config panel
  React.useEffect(() => {
    const onPersona = e => setTweak('persona', e.detail);
    window.addEventListener('seekdeep:setPersona', onPersona);
    return () => window.removeEventListener('seekdeep:setPersona', onPersona);
  }, [setTweak]);
  return /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    label: "Palette"
  }, /*#__PURE__*/React.createElement(TweakColor, {
    label: "Accent",
    value: t.palette,
    onChange: v => setTweak('palette', v),
    options: APP_PALETTES
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Mode"
  }, /*#__PURE__*/React.createElement(TweakRadio, {
    label: "Theme",
    value: t.mode,
    options: [{
      value: 'dark',
      label: 'Dark'
    }, {
      value: 'light',
      label: 'Light'
    }],
    onChange: v => setTweak('mode', v)
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Persona"
  }, /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Active",
    value: t.persona,
    options: [{
      value: 'clinical',
      label: 'Clinical — terse'
    }, {
      value: 'neurotic',
      label: 'Neurotic — hedged'
    }, {
      value: 'unsettling',
      label: 'Unsettling — pauses…'
    }, {
      value: 'chaotic',
      label: 'Chaotic — CAPS'
    }],
    onChange: v => setTweak('persona', v)
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 10,
      color: 'var(--hull-3)',
      lineHeight: 1.5,
      padding: '4px 12px 8px'
    }
  }, APP_PERSONAS[t.persona])), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Atmosphere"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Ambient drift",
    value: t.ambientMotion,
    onChange: v => setTweak('ambientMotion', v)
  }), /*#__PURE__*/React.createElement(TweakSlider, {
    label: "Panel blur",
    min: 0,
    max: 30,
    step: 1,
    unit: "px",
    value: t.panelBlur,
    onChange: v => setTweak('panelBlur', v)
  })));
}
const root = ReactDOM.createRoot(document.getElementById('tweaks-root'));
root.render(/*#__PURE__*/React.createElement(App, null));
