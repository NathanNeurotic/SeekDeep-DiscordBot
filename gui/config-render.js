// SeekDeep · shared config control renderer
// ============================================================================
// Single source of truth for how a /config/schema field becomes a control
// (toggle / select / input), its boolean value vocabulary, and how its value
// is read. Used by BOTH the All Settings page (settings.html) and the Control
// Center config pane (app.html) so the two surfaces can never drift on how a
// given key renders.
//
// Pure DOM + value logic only — no fetching, no dirty-tracking, no save. Each
// page keeps its own layout/dirty/save and just calls makeControl() for the
// actual input element + a read()/reset() pair.
(function () {
  'use strict';

  // A value counts as "on" for a boolean-ish key.
  function isOn(v) {
    return ['1', 'true', 'yes', 'on'].includes(String(v == null ? '' : v).trim().toLowerCase());
  }

  // Preserve the key's own boolean vocabulary so we never rewrite true->on,
  // 1->on, etc. Mirrors the key's default form.
  function boolVocab(def) {
    const d = String(def == null ? '' : def).trim().toLowerCase();
    if (d === 'true' || d === 'false') return { on: 'true', off: 'false' };
    if (d === 'yes' || d === 'no') return { on: 'yes', off: 'no' };
    if (d === '1' || d === '0') return { on: '1', off: '0' };   // numeric boolean (HF offline flags)
    return { on: 'on', off: 'off' };
  }

  // Build the control for a schema field.
  //   field : { key, kind, default, options? }  (kind: toggle|select|secret|number|text)
  //   opts  : { baseline?, current?, onChange? }
  //     baseline = the value to seed the control with (current .env value)
  //     current  = the full current-values map (used to label secret fields)
  //     onChange = called on every user edit (page wires dirty-tracking here)
  // Returns { nodes, read, reset }:
  //   nodes : array of DOM nodes to append into the control cell
  //   read  : () => string current value of the control
  //   reset : () => restore the control to the field's default
  function makeControl(field, opts) {
    opts = opts || {};
    const onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    const baseline = opts.baseline != null ? opts.baseline : '';
    const current = opts.current || {};
    const defStr = String(field.default == null ? '' : field.default);
    const nodes = [];
    let read, reset;

    if (field.kind === 'toggle') {
      const vocab = boolVocab(field.default);
      const tog = document.createElement('div');
      tog.className = 'toggle';
      const valLabel = document.createElement('span');
      valLabel.className = 'toggle-val';
      const baseOn = isOn(baseline);
      tog.classList.toggle('on', baseOn);
      valLabel.textContent = baseOn ? vocab.on : vocab.off;
      tog.addEventListener('click', () => {
        tog.classList.toggle('on');
        valLabel.textContent = tog.classList.contains('on') ? vocab.on : vocab.off;
        onChange();
      });
      read = () => (tog.classList.contains('on') ? vocab.on : vocab.off);
      reset = () => {
        const on = isOn(defStr);
        tog.classList.toggle('on', on);
        valLabel.textContent = on ? vocab.on : vocab.off;
      };
      nodes.push(valLabel, tog);
    } else if (field.kind === 'select') {
      const sel = document.createElement('select');
      const choices = (field.options && field.options.length) ? field.options.slice() : [];
      if (baseline && !choices.includes(baseline)) choices.unshift(baseline);
      for (const o of choices) {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        if (o === baseline) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', onChange);
      read = () => sel.value;
      reset = () => { sel.value = defStr; };
      nodes.push(sel);
    } else {
      const inp = document.createElement('input');
      if (field.kind === 'secret') {
        inp.type = 'password';
        inp.placeholder = (current[field.key] === '*****') ? '•••••• set · type to replace' : '(not set)';
        inp.value = '';
      } else if (field.kind === 'number') {
        inp.type = 'text';            // text not number: avoids locale/step quirks
        inp.value = baseline;
      } else {
        inp.type = 'text';
        inp.value = baseline;
        inp.placeholder = field.default ? defStr : '(empty)';
      }
      inp.spellcheck = false; inp.autocomplete = 'off';
      inp.addEventListener('input', onChange);
      read = () => inp.value;
      reset = () => { inp.value = (field.kind === 'secret') ? '' : defStr; };
      nodes.push(inp);
    }

    return { nodes: nodes, read: read, reset: reset };
  }

  window.SeekDeepConfigRender = { isOn: isOn, boolVocab: boolVocab, makeControl: makeControl };
})();
