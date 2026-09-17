import { h } from '../lib/dom.js';

// Popover with the CAS session settings that affect every evaluation (calculator input
// and plots alike, since they all share the one Giac session) - angle unit, whether
// results are always numerically approximated instead of left exact, and how much
// auto-simplification Giac applies after each evaluation.
export function SettingsMenu({ onAngleModeChange, onApproxChange, onAutosimplifyChange, onThemeChange, onShowTextChange }) {
  let open = false;
  let angleMode = 'RAD';
  let approx = false;
  let autosimplify = 1;
  let showText = false;
  let theme = 'dark';
  let disabled = false;

  const root = h('div', { class: 'settings-menu' });
  const trigger = h('button', { type: 'button', class: 'settings-menu__trigger', title: 'Settings', onclick: toggle }, '⚙');

  const radBtn = h('button', { type: 'button', onclick: () => onAngleModeChange('RAD') }, 'RAD');
  const degBtn = h('button', { type: 'button', onclick: () => onAngleModeChange('DEG') }, 'DEG');
  const approxInput = h('input', { type: 'checkbox', onchange: (e) => onApproxChange(e.target.checked) });
  const autosimplifyBtns = [0, 1, 2].map((level) =>
    h('button', { type: 'button', onclick: () => onAutosimplifyChange(level) }, String(level)),
  );
  const showTextInput = h('input', { type: 'checkbox', onchange: (e) => onShowTextChange(e.target.checked) });
  const themeThumb = h('span', { class: 'theme-switch__thumb' }, '☾');
  const themeSwitch = h(
    'button',
    {
      type: 'button',
      class: 'theme-switch',
      role: 'switch',
      'aria-label': 'Toggle light theme',
      onclick: () => onThemeChange(theme === 'light' ? 'dark' : 'light'),
    },
    themeThumb,
  );

  const panel = h(
    'div',
    { class: 'settings-menu__panel' },
    h(
      'div',
      { class: 'settings-menu__row' },
      h('span', { class: 'settings-menu__label' }, 'Angle'),
      h('div', { class: 'settings-menu__segmented' }, radBtn, degBtn),
    ),
    h(
      'label',
      { class: 'settings-menu__row settings-menu__row--checkbox' },
      h('span', { class: 'settings-menu__label' }, 'Approximate'),
      approxInput,
    ),
    h(
      'div',
      { class: 'settings-menu__row' },
      h('span', { class: 'settings-menu__label', title: '0 = none, 1 = regroup, 2 = simplify' }, 'Autosimplify'),
      h('div', { class: 'settings-menu__segmented' }, ...autosimplifyBtns),
    ),
    h(
      'label',
      { class: 'settings-menu__row settings-menu__row--checkbox' },
      h('span', { class: 'settings-menu__label' }, 'Show text output'),
      showTextInput,
    ),
    h(
      'div',
      { class: 'settings-menu__row' },
      h('span', { class: 'settings-menu__label' }, 'Theme'),
      themeSwitch,
    ),
  );

  root.append(trigger, panel);

  function setOpen(next) {
    open = next;
    trigger.classList.toggle('settings-menu__trigger--active', open);
    panel.style.display = open ? '' : 'none';
  }
  setOpen(false);
  function toggle() {
    setOpen(!open);
  }

  function render() {
    radBtn.className = angleMode === 'RAD' ? 'settings-menu__seg--active' : '';
    degBtn.className = angleMode === 'DEG' ? 'settings-menu__seg--active' : '';
    radBtn.disabled = disabled;
    degBtn.disabled = disabled;
    approxInput.checked = approx;
    approxInput.disabled = disabled;
    autosimplifyBtns.forEach((btn, level) => {
      btn.className = level === autosimplify ? 'settings-menu__seg--active' : '';
      btn.disabled = disabled;
    });
    showTextInput.checked = showText;
    themeSwitch.classList.toggle('theme-switch--light', theme === 'light');
    themeSwitch.setAttribute('aria-checked', theme === 'light');
    themeThumb.textContent = theme === 'light' ? '☀' : '☾';
  }
  render();

  function onDocPointerDown(e) {
    if (open && !root.contains(e.target)) setOpen(false);
  }
  function onKeyDown(e) {
    if (open && e.key === 'Escape') setOpen(false);
  }
  document.addEventListener('pointerdown', onDocPointerDown);
  document.addEventListener('keydown', onKeyDown);

  function update(state) {
    angleMode = state.angleMode;
    approx = state.approx;
    autosimplify = state.autosimplify;
    showText = state.showText;
    theme = state.theme;
    disabled = state.disabled;
    render();
  }

  return { root, update };
}
