import { h, clear } from '../lib/dom.js';
import { definitionLabel } from '../lib/definitions.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import { typesetNode } from '../lib/mathjax.js';

// Popover listing every variable/function the user has defined this CAS session (see
// state.definitions in app.js) with its current value/formula, and a small button to purge
// each one - opened via its trigger button or the Alt+V shortcut (see app.js's keydown
// handler). Same open/close/outside-click/Escape pattern as settingsMenu.js.
export function VariablesMenu({ onPurge }) {
  let open = false;
  let definitions = new Map();

  const root = h('div', { class: 'variables-menu' });
  const trigger = h(
    'button',
    { type: 'button', class: 'variables-menu__trigger', title: 'Variables (Alt+V)', onclick: toggle },
    'Vars',
  );
  const list = h('div', { class: 'variables-menu__list' });
  const emptyHint = h('div', { class: 'variables-menu__empty' }, 'No variables defined yet.');
  const panel = h('div', { class: 'variables-menu__panel' }, h('div', { class: 'variables-menu__title' }, 'Variables'), list, emptyHint);

  root.append(trigger, panel);

  // Renders each value/formula through MathJax (same client-side Xcas->LaTeX converter and
  // \(...\) inline-math convention the input's own live formula preview uses - see
  // giacToLatex() and updatePreview() in app.js) rather than showing the raw Xcas text, so
  // e.g. "a*x+b" reads as a·x+b. Falls back to the raw text untypeset if it can't be parsed
  // (giacToLatex returns null/'' on anything it doesn't understand) so a value is never
  // silently dropped.
  function render() {
    clear(list);
    const entries = Array.from(definitions.values());
    emptyHint.style.display = entries.length ? 'none' : '';
    list.style.display = entries.length ? '' : 'none';
    for (const def of entries) {
      const valueEl = h('span', { class: 'variables-menu__value' });
      const latex = giacToLatex(def.body);
      if (latex) valueEl.textContent = '\\(' + latex + '\\)';
      else valueEl.textContent = def.body;
      list.appendChild(
        h(
          'div',
          { class: 'variables-menu__row' },
          h('span', { class: 'variables-menu__name' }, definitionLabel(def)),
          valueEl,
          h(
            'button',
            { type: 'button', class: 'variables-menu__remove', title: `Delete ${def.name}`, onclick: () => onPurge(def.name) },
            '×',
          ),
        ),
      );
    }
    typesetNode(list);
  }

  function setOpen(next) {
    open = next;
    trigger.classList.toggle('variables-menu__trigger--active', open);
    panel.style.display = open ? '' : 'none';
    if (open) render();
  }
  setOpen(false);
  function toggle() {
    setOpen(!open);
  }

  function onDocPointerDown(e) {
    if (open && !root.contains(e.target)) setOpen(false);
  }
  function onKeyDown(e) {
    if (open && e.key === 'Escape') setOpen(false);
  }
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKeyDown);

  function update(next) {
    definitions = next;
    if (open) render();
  }

  return { root, update, toggle };
}
