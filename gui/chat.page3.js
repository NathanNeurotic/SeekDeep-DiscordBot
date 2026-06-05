const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": ["#2dd4ff", "#00a8e8", "#0d2152"],
  "mode": "dark",
  "ambientMotion": true
} /*EDITMODE-END*/;
const PALETTES = [["#2dd4ff", "#00a8e8", "#0d2152"], ["#7af0c2", "#1da37a", "#02261a"], ["#ff6df0", "#a82cc4", "#1a0830"], ["#ffb84d", "#c97b00", "#2a1a04"]];
function applyTweaks(t) {
  const root = document.documentElement;
  if (t.palette) {
    root.style.setProperty('--cyan-0', adjL(t.palette[0], 12));
    root.style.setProperty('--cyan-1', t.palette[0]);
    root.style.setProperty('--cyan-2', t.palette[1]);
    root.style.setProperty('--cyan-3', adjL(t.palette[1], -15));
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
  } else {
    root.style.setProperty('--ink', '#000a1f');
    root.style.setProperty('--abyss-0', '#02060f');
    root.style.setProperty('--abyss-1', '#050b1c');
    root.style.setProperty('--abyss-2', '#081434');
    root.style.setProperty('--abyss-4', '#14306b');
    root.style.setProperty('--hull', '#f4f8ff');
    root.style.setProperty('--hull-2', '#c7d6f0');
    root.style.setProperty('--hull-3', '#7d92b8');
  }
}
function adjL(hex, delta) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16),
    g = parseInt(c.slice(2, 4), 16),
    b = parseInt(c.slice(4, 6), 16);
  const adj = v => Math.max(0, Math.min(255, v + delta * 2.55));
  const toHex = v => Math.round(adj(v)).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
const PERSONA_OPTS = [{
  value: 'neurotic',
  label: 'Neurotic — hedged'
}, {
  value: 'unsettling',
  label: 'Unsettling — pauses…'
}, {
  value: 'clinical',
  label: 'Clinical — terse'
}, {
  value: 'chaotic',
  label: 'Chaotic — CAPS'
}];
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  // Persona is owned by the chat.html Persona controller; Tweaks reflects + drives it.
  const [persona, setPersonaUI] = React.useState('clinical');
  React.useEffect(() => {
    const onChange = e => {
      const p = e.detail && e.detail.persona;
      if (p) setPersonaUI(p);
    };
    window.addEventListener('seekdeep:persona-changed', onChange);
    return () => window.removeEventListener('seekdeep:persona-changed', onChange);
  }, []);
  React.useEffect(() => {
    applyTweaks(t);
  }, [t.palette, t.mode, t.ambientMotion]);
  const pickPersona = v => {
    setPersonaUI(v);
    if (window.Persona && typeof window.Persona.choose === 'function') {
      window.Persona.choose(v);
    }
  };
  const clearPersona = () => {
    if (window.Persona && typeof window.Persona.clear === 'function') {
      window.Persona.clear();
    }
  };
  return /*#__PURE__*/React.createElement(TweaksPanel, {
    title: "Tweaks"
  }, /*#__PURE__*/React.createElement(TweakSection, {
    label: "Palette"
  }, /*#__PURE__*/React.createElement(TweakColor, {
    label: "Accent",
    value: t.palette,
    onChange: v => setTweak('palette', v),
    options: PALETTES
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
    label: "Persona \xB7 global override"
  }, /*#__PURE__*/React.createElement(TweakSelect, {
    label: "Active",
    value: persona,
    options: PERSONA_OPTS,
    onChange: pickPersona
  }), /*#__PURE__*/React.createElement(TweakButton, {
    label: "\u25B8 Clear override",
    onClick: clearPersona
  })), /*#__PURE__*/React.createElement(TweakSection, {
    label: "Atmosphere"
  }, /*#__PURE__*/React.createElement(TweakToggle, {
    label: "Ambient drift",
    value: t.ambientMotion,
    onChange: v => setTweak('ambientMotion', v)
  })));
}
ReactDOM.createRoot(document.getElementById('tweaks-root')).render(/*#__PURE__*/React.createElement(App, null));
