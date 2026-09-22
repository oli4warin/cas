import { h } from '../lib/dom.js';

// Modal opened by a history entry's "save" button (or the "s" keyboard shortcut on a
// selected output - see saveableForEntry/lib/saveable.js, which decides which entries offer
// this at all) - lets the user type the name to save that output under, either a plain
// variable name ("a") or a function name with its parameter(s) ("f(x)"). Submitting builds
// the actual "name:=value" assignment text (Giac's own syntax for both a variable and a
// function definition - see parseDefinition/lib/definitions.js) and hands it, along with the
// source entry's index (passed into open() so it can be handed straight back), to onSubmit;
// app.js runs it exactly like it would any other ready-made assignment (see
// saveEntryVariables), without ever touching the main expression input, and uses the index to
// relabel that entry's save button instead of adding a new history entry for it. Reuses the
// distribution-menu__* styling/markup shared by every small modal like this one (see
// components/distributionMenu.js) rather than defining its own.
export function SaveMenu({ onSubmit, onCancel }) {
  let current = null; // { value, index } of the output currently being saved, or null when closed

  const nameInput = h('input', { type: 'text', class: 'distribution-menu__input', autocomplete: 'off', placeholder: 'a or f(x)' });
  const valuePreview = h('div', { class: 'distribution-menu__label' });
  const cancelBtn = h('button', { type: 'button', class: 'distribution-menu__btn distribution-menu__btn--ghost', onclick: cancel }, 'Cancel');
  const submitBtn = h('button', { type: 'submit', class: 'distribution-menu__btn distribution-menu__btn--primary' }, 'Save');
  const form = h(
    'form',
    { class: 'distribution-menu__form', onsubmit: handleSubmit },
    h(
      'div',
      { class: 'distribution-menu__fields' },
      h('label', { class: 'distribution-menu__field' }, h('span', { class: 'distribution-menu__label' }, 'Save as'), nameInput),
      valuePreview,
    ),
    h('div', { class: 'distribution-menu__actions' }, cancelBtn, submitBtn),
  );
  const card = h('div', { class: 'distribution-menu__card' }, h('h2', { class: 'distribution-menu__title' }, 'Save'), form);
  const backdrop = h('div', { class: 'distribution-menu__backdrop', onmousedown: (e) => e.target === backdrop && cancel() }, card);
  backdrop.style.display = 'none';

  function open({ defaultName, value, index }) {
    current = { value, index };
    nameInput.value = defaultName || '';
    valuePreview.textContent = `= ${value}`;
    backdrop.style.display = '';
    nameInput.focus();
    nameInput.select();
  }

  function close() {
    backdrop.style.display = 'none';
    current = null;
  }

  function cancel() {
    if (!current) return;
    close();
    onCancel?.();
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!current) return;
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const expr = `${name}:=${current.value}`;
    const { index } = current;
    close();
    onSubmit(expr, index);
  }

  function isOpen() {
    return current != null;
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      cancel();
    }
  }
  card.addEventListener('keydown', handleKeyDown);

  return { root: backdrop, open, close, isOpen };
}
