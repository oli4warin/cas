import { h, clear } from '../lib/dom.js';

function isDefaultLowerBound(value) {
  return /^-\s*infinity$/i.test(value) || /^-\s*inf$/i.test(value);
}

// Modal opened when the input holds nothing but a bare distribution command name (see
// findDistributionMenu/app.js's Enter handling) - lets the parameters be filled in through
// labeled fields (e.g. "Number of trials (n)") instead of remembering Giac's positional
// argument order. Submitting builds the actual call text and hands it to onSubmit; app.js
// drops that into the input and evaluates it, same as if it had been typed by hand.
export function DistributionMenu({ onSubmit, onCancel }) {
  let current = null; // { name, kind, params } of the command currently open, or null when closed
  let fields = []; // [{ key, input }] for every field currently rendered, params first

  const title = h('h2', { class: 'distribution-menu__title' });
  const fieldsWrap = h('div', { class: 'distribution-menu__fields' });
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

  function field(label, extra) {
    const input = h('input', { type: 'text', class: 'distribution-menu__input', autocomplete: 'off', ...extra });
    fieldsWrap.append(h('label', { class: 'distribution-menu__field' }, h('span', { class: 'distribution-menu__label' }, label), input));
    return input;
  }

  function buildFields(config) {
    clear(fieldsWrap);
    fields = config.params.map((p) => ({ key: p.key, input: field(p.label) }));
    if (config.kind === 'cdf') {
      fields.push({ key: '__lower', input: field('Lower bound', { value: '-infinity' }) });
      fields.push({ key: '__upper', input: field('Upper bound') });
    } else {
      fields.push({ key: '__prob', input: field('Probability (p)') });
    }
  }

  function open(config) {
    current = config;
    title.textContent = `${config.name}( … )`;
    buildFields(config);
    backdrop.style.display = '';
    fields[0]?.input.focus();
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
    const values = {};
    for (const f of fields) {
      const value = f.input.value.trim();
      if (!value) {
        f.input.focus();
        return;
      }
      values[f.key] = value;
    }
    const args = current.params.map((p) => values[p.key]);
    if (current.kind === 'cdf') {
      // Giac's two-bound form (<cmd>(params, lower, upper)) evaluates a literal -infinity
      // lower bound correctly for only a couple of families (normald, student) and gives
      // outright wrong answers for several others (e.g. weibull_cdf(..., -infinity, x) = 1).
      // The single-bound form (<cmd>(params, upper)) is exactly P(X<=upper) and always
      // evaluates correctly, so fall back to it when the lower bound is left at its default.
      if (isDefaultLowerBound(values.__lower)) args.push(values.__upper);
      else args.push(values.__lower, values.__upper);
    } else {
      args.push(values.__prob);
    }
    const expr = `${current.name}(${args.join(',')})`;
    close();
    onSubmit(expr);
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
