import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';

// Popover with the session-management actions: exporting the current notebook (history plus
// plot/3D-plot/table panel state - see lib/sessionPersistence.js) to a downloadable .json
// file, importing one back, and wiping the current session to start fresh. Browser-storage
// autosave/restore itself is silent (see persistSession/restoreSession in app.js) - this menu
// only surfaces the explicit, user-triggered actions. Same open/close/outside-click/Escape
// pattern as settingsMenu.js/variablesMenu.js.
export function SessionMenu({ onSaveToFile, onLoadFile, onPrint, onClear }) {
  let open = false;

  const root = h('div', { class: 'session-menu' });
  const trigger = h(
    'button',
    { type: 'button', class: 'session-menu__trigger', title: t('Session'), onclick: toggle },
    t('Session'),
  );

  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'session-menu__item',
      onclick: () => {
        setOpen(false);
        onSaveToFile();
      },
    },
    t('Save to file…'),
  );

  // The visible "Load from file…" control is this label wrapping a hidden native file input -
  // clicking the label opens the OS file picker without needing to style (or fight the native
  // look of) the input itself.
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    class: 'session-menu__fileInput',
    onchange: (e) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // lets picking the exact same file again still fire onchange
      setOpen(false);
      if (file) onLoadFile(file);
    },
  });
  const loadBtn = h('label', { class: 'session-menu__item' }, t('Load from file…'), fileInput);

  const printBtn = h(
    'button',
    {
      type: 'button',
      class: 'session-menu__item',
      onclick: () => {
        setOpen(false);
        onPrint();
      },
    },
    t('Print…'),
  );

  const clearBtn = h(
    'button',
    {
      type: 'button',
      class: 'session-menu__item session-menu__item--danger',
      onclick: () => {
        setOpen(false);
        onClear();
      },
    },
    t('Clear session'),
  );

  const panel = h(
    'div',
    { class: 'session-menu__panel' },
    h('div', { class: 'session-menu__title' }, t('Session')),
    saveBtn,
    loadBtn,
    printBtn,
    clearBtn,
  );

  root.append(trigger, panel);

  function setOpen(next) {
    open = next;
    trigger.classList.toggle('session-menu__trigger--active', open);
    panel.style.display = open ? '' : 'none';
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

  function setDisabled(disabled) {
    trigger.disabled = disabled;
  }

  // Printing only covers the history (see the print stylesheet in app.css), so there's nothing
  // to print while it's empty.
  function setPrintDisabled(disabled) {
    printBtn.disabled = disabled;
  }

  return { root, setDisabled, setPrintDisabled };
}
