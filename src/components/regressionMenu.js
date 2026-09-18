import { h } from '../lib/dom.js';
import { REGRESSION_TYPES } from '../lib/regressionParams.js';

// Modal opened when the input holds nothing but the bare "regression" command (see
// isRegressionMenuCommand/app.js's Enter handling) - lets an x-list, a y-list and a curve
// type be filled in through labeled fields, the same idea as DistributionMenu (and sharing
// its CSS classes, since the chrome is identical). Submitting builds
// "<type>_regression(xList,yList)" and hands it to onSubmit; app.js drops that into the
// input and evaluates it, same as if it had been typed by hand.
export function RegressionMenu({ onSubmit, onCancel }) {
  let isOpenState = false;

  const title = h('h2', { class: 'distribution-menu__title' }, 'regression( … )');
  const typeSelect = h(
    'select',
    { class: 'distribution-menu__input' },
    ...REGRESSION_TYPES.map((t) => h('option', { value: t.name }, t.label)),
  );
  const xInput = h('input', { type: 'text', class: 'distribution-menu__input', autocomplete: 'off', placeholder: '[1,2,3,4]' });
  const yInput = h('input', { type: 'text', class: 'distribution-menu__input', autocomplete: 'off', placeholder: '[2,4,6,8]' });
  const field = (label, input) => h('label', { class: 'distribution-menu__field' }, h('span', { class: 'distribution-menu__label' }, label), input);
  const fieldsWrap = h('div', { class: 'distribution-menu__fields' }, field('Regression type', typeSelect), field('X list', xInput), field('Y list', yInput));
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
    xInput.focus();
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
    const xList = xInput.value.trim();
    const yList = yInput.value.trim();
    if (!xList) {
      xInput.focus();
      return;
    }
    if (!yList) {
      yInput.focus();
      return;
    }
    const expr = `${typeSelect.value}(${xList},${yList})`;
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
