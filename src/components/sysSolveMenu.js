import { h } from '../lib/dom.js';
import { SOLVE_MODES } from '../lib/sysSolveParams.js';

// Modal opened when the input holds nothing but the bare "syssolve" command (see
// isSysSolveMenuCommand/app.js's Enter handling) - lets a system of equations be typed one
// per line, a list of variables to solve for, and the solve mode (exact/complex/numeric)
// picked from a dropdown, the same idea as RegressionMenu/DistributionMenu (and sharing
// their CSS classes, since the chrome is identical). Submitting builds
// "<mode>(eq1 and eq2 and ...,[v1,v2,...])" and hands it to onSubmit; app.js drops that into
// the input and evaluates it, same as if it had been typed by hand.
export function SysSolveMenu({ onSubmit, onCancel }) {
  let isOpenState = false;

  const title = h('h2', { class: 'distribution-menu__title' }, 'syssolve( … )');
  const eqsInput = h('textarea', {
    class: 'distribution-menu__input',
    rows: 4,
    autocomplete: 'off',
    placeholder: 'x+y=5\nx-y=1',
  });
  const varsInput = h('input', { type: 'text', class: 'distribution-menu__input', autocomplete: 'off', placeholder: 'x,y' });
  const modeSelect = h(
    'select',
    { class: 'distribution-menu__input' },
    ...SOLVE_MODES.map((m) => h('option', { value: m.name }, m.label)),
  );
  const field = (label, input) => h('label', { class: 'distribution-menu__field' }, h('span', { class: 'distribution-menu__label' }, label), input);
  const fieldsWrap = h(
    'div',
    { class: 'distribution-menu__fields' },
    field('Equations (one per line)', eqsInput),
    field('Solve for', varsInput),
    field('Mode', modeSelect),
  );
  const cancelBtn = h('button', { type: 'button', class: 'distribution-menu__btn distribution-menu__btn--ghost', onclick: cancel }, 'Cancel');
  const submitBtn = h('button', { type: 'submit', class: 'distribution-menu__btn distribution-menu__btn--primary' }, 'Compute');
  const form = h(
    'form',
    { class: 'distribution-menu__form', onsubmit: handleSubmit },
    fieldsWrap,
    h('div', { class: 'distribution-menu__actions' }, cancelBtn, submitBtn),
  );
  const card = h('div', { class: 'distribution-menu__card' }, title, form);
  const backdrop = h('div', { class: 'distribution-menu__backdrop', onmousedown: (e) => e.target === backdrop && cancel() }, card);
  backdrop.style.display = 'none';

  function open() {
    isOpenState = true;
    backdrop.style.display = '';
    eqsInput.focus();
  }

  function close() {
    backdrop.style.display = 'none';
    isOpenState = false;
  }

  function cancel() {
    if (!isOpenState) return;
    close();
    onCancel?.();
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!isOpenState) return;
    const eqLines = eqsInput.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (eqLines.length === 0) {
      eqsInput.focus();
      return;
    }
    const vars = varsInput.value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (vars.length === 0) {
      varsInput.focus();
      return;
    }
    const equationsText = eqLines.join(' and ');
    const varsArg = vars.length > 1 ? `[${vars.join(',')}]` : vars[0];
    const expr = `${modeSelect.value}(${equationsText},${varsArg})`;
    close();
    onSubmit(expr);
  }

  function isOpen() {
    return isOpenState;
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
