import { h, clear } from '../lib/dom.js';
import { definitionLabel, vectorNames } from '../lib/definitions.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import { typesetNode } from '../lib/mathjax.js';
import { t } from '../lib/i18n.js';

// Popover listing every variable/function the user has defined this CAS session (see
// state.definitions in app.js) with its current value/formula, and a small button to purge
// each one - opened via its trigger button or the Alt+V shortcut (see app.js's keydown
// handler). Same open/close/outside-click/Escape pattern as settingsMenu.js, plus keyboard
// picking: while open, ArrowUp/ArrowDown move a highlighted row, Enter hands that row's
// definition to onInsert (and closes), Escape closes and calls onCancel.
export function VariablesMenu({ onPurge, onInsert, onCancel }) {
  let open = false;
  let definitions = new Map();
  let entries = [];
  let rows = [];
  let selectedIndex = 0;

  const root = h('div', { class: 'variables-menu' });
  const trigger = h(
    'button',
    { type: 'button', class: 'variables-menu__trigger', title: t('Variables (Alt+V)'), onclick: toggle },
    t('Vars'),
  );
  const list = h('div', { class: 'variables-menu__list' });
  const emptyHint = h('div', { class: 'variables-menu__empty' }, t('No variables defined yet.'));
  const panel = h('div', { class: 'variables-menu__panel' }, h('div', { class: 'variables-menu__title' }, t('Variables')), list, emptyHint);

  root.append(trigger, panel);

  // Renders each value/formula through MathJax (same client-side Xcas->LaTeX converter and
  // \(...\) inline-math convention the input's own live formula preview uses - see
  // giacToLatex() and updatePreview() in app.js) rather than showing the raw Xcas text, so
  // e.g. "a*x+b" reads as a·x+b. Falls back to the raw text untypeset if it can't be parsed
  // (giacToLatex returns null/'' on anything it doesn't understand) so a value is never
  // silently dropped.
  function render() {
    clear(list);
    entries = Array.from(definitions.values());
    rows = [];
    selectedIndex = Math.max(0, Math.min(selectedIndex, entries.length - 1));
    const names = vectorNames(definitions);
    emptyHint.style.display = entries.length ? 'none' : '';
    list.style.display = entries.length ? '' : 'none';
    for (const def of entries) {
      const valueEl = h('span', { class: 'variables-menu__value' });
      const latex = giacToLatex(def.body, names);
      if (latex) valueEl.textContent = '\\(' + latex + '\\)';
      else valueEl.textContent = def.body;
      // A saved vector's own name gets the same overhead-arrow treatment its value's "a" would
      // get if it appeared inside another expression (see currentVectorNames/giacToLatex.js) -
      // rendered through giacToLatex too so it picks up the same underscore/subscript handling,
      // rather than duplicating that logic here.
      const nameEl = h('span', { class: 'variables-menu__name' });
      const nameLatex = def.kind === 'variable' && def.isVector ? giacToLatex(def.name, names) : null;
      if (nameLatex) nameEl.textContent = '\\(' + nameLatex + '\\)';
      else nameEl.textContent = definitionLabel(def);
      const row = h(
        'div',
        { class: 'variables-menu__row' },
        nameEl,
        valueEl,
        h(
          'button',
          { type: 'button', class: 'variables-menu__remove', title: t('Delete {name}', { name: def.name }), onclick: () => onPurge(def.name) },
          '×',
        ),
      );
      rows.push(row);
      list.appendChild(row);
    }
    typesetNode(list);
    updateSelection();
  }

  // Only toggles a class on the already-rendered rows (rather than going through render())
  // so moving the highlight doesn't re-typeset every value.
  function updateSelection() {
    rows.forEach((row, i) => row.classList.toggle('variables-menu__row--selected', i === selectedIndex));
    rows[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function setOpen(next) {
    open = next;
    trigger.classList.toggle('variables-menu__trigger--active', open);
    panel.style.display = open ? '' : 'none';
    if (open) {
      selectedIndex = 0;
      render();
    }
  }
  setOpen(false);
  function toggle() {
    setOpen(!open);
  }

  function onDocPointerDown(e) {
    if (open && !root.contains(e.target)) setOpen(false);
  }
  // Registered in the capture phase and stops propagation for the keys it handles: focus
  // usually stays in the expression input while this menu is open (Alt+V), whose own keydown
  // handler would otherwise also browse history on Up/Down, submit on Enter and clear its
  // selection on Escape (see handleKeyDown in app.js).
  function onKeyDown(e) {
    if (!open || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'Escape') {
      setOpen(false);
      onCancel();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (entries.length) {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        selectedIndex = (selectedIndex + step + entries.length) % entries.length;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      const def = entries[selectedIndex];
      if (!def) return;
      setOpen(false);
      onInsert(def);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKeyDown, true);

  function update(next) {
    definitions = next;
    if (open) render();
  }

  return { root, update, toggle };
}
