import { h } from '../lib/dom.js';

// A curated reference of Giac/Xcas functions, grouped by topic, aimed at a middle/early
// high school level - covers arithmetic, algebra, trig, calculus and basic differential
// equations, but deliberately stops short of anything like Fourier/Laplace transforms,
// complex analysis or PDEs.
//
// Each entry's `prefix`/`suffix` are inserted around the current selection (or just the
// cursor, if nothing is selected) exactly like the TOOLBAR buttons in app.js - see
// insertSnippet there.
const CATEGORIES = [
  {
    title: 'Numbers',
    items: [
      { label: 'gcd(a, b)', hint: 'greatest common divisor', prefix: 'gcd(', suffix: ',18)' },
      { label: 'lcm(a, b)', hint: 'least common multiple', prefix: 'lcm(', suffix: ',6)' },
      { label: 'irem(a, b)', hint: 'remainder of a÷b', prefix: 'irem(', suffix: ',5)' },
      { label: 'isprime(n)', hint: 'is n prime?', prefix: 'isprime(', suffix: ')' },
      { label: 'ifactor(n)', hint: 'prime factorization', prefix: 'ifactor(', suffix: ')' },
      { label: 'floor(x)', hint: 'round down', prefix: 'floor(', suffix: ')' },
      { label: 'ceil(x)', hint: 'round up', prefix: 'ceil(', suffix: ')' },
      { label: 'round(x, n)', hint: 'round to n decimals', prefix: 'round(', suffix: ',2)' },
    ],
  },
  {
    title: 'Algebra',
    items: [
      { label: 'solve(eqn, x)', hint: 'solve an equation', prefix: 'solve(', suffix: '=0,x)' },
      { label: 'factor(expr)', hint: 'factor an expression', prefix: 'factor(', suffix: ')' },
      { label: 'expand(expr)', hint: 'expand an expression', prefix: 'expand(', suffix: ')' },
      { label: 'simplify(expr)', hint: 'simplify an expression', prefix: 'simplify(', suffix: ')' },
      { label: 'subst(expr, x=a)', hint: 'substitute a value', prefix: 'subst(', suffix: ',x=1)' },
    ],
  },
  {
    title: 'Trigonometry',
    items: [
      { label: 'sin(x)', hint: '', prefix: 'sin(', suffix: ')' },
      { label: 'cos(x)', hint: '', prefix: 'cos(', suffix: ')' },
      { label: 'tan(x)', hint: '', prefix: 'tan(', suffix: ')' },
      { label: 'asin(x)', hint: 'arcsine', prefix: 'asin(', suffix: ')' },
      { label: 'acos(x)', hint: 'arccosine', prefix: 'acos(', suffix: ')' },
      { label: 'atan(x)', hint: 'arctangent', prefix: 'atan(', suffix: ')' },
    ],
  },
  {
    title: 'Calculus',
    items: [
      { label: 'diff(f, x)', hint: 'derivative', prefix: 'diff(', suffix: ',x)' },
      { label: 'integrate(f, x)', hint: 'antiderivative', prefix: 'integrate(', suffix: ',x)' },
      { label: 'limit(f, x, a)', hint: 'limit as x→a', prefix: 'limit(', suffix: ',x,0)' },
      { label: 'fMax(f,x)', hint: 'Function Maximum', prefix: 'fMax(', suffix: ',x)' },
      { label: 'fMin(f,x)', hint: 'Function Minimum', prefix: 'fMin(', suffix: ',x)' },
      { label: 'taylor(f, x=a, n)', hint: 'Taylor series', prefix: 'taylor(', suffix: ',x=0,5)' },
    ],
  },
  {
    title: 'Differential equations',
    items: [
      { label: "y' = y", hint: 'general solution', prefix: "desolve(y'=y,y)", suffix: '' },
      { label: "y' = y, y(0) = 1", hint: 'initial value problem', prefix: "desolve(y'=y and y(0)=1,y)", suffix: '' },
      { label: "y'' + y = 0", hint: 'second order', prefix: "desolve(y''+y=0,y)", suffix: '' },
    ],
  },
  {
    title: 'Statistics & probability',
    items: [
      { label: 'mean(list)', hint: '', prefix: 'mean(', suffix: ')' },
      { label: 'median(list)', hint: '', prefix: 'median(', suffix: ')' },
      { label: 'stddev(list)', hint: 'standard deviation', prefix: 'stddev(', suffix: ')' },
      { label: 'factorial(n)', hint: 'n!', prefix: 'factorial(', suffix: ')' },
      { label: 'comb(n, k)', hint: 'combinations', prefix: 'comb(', suffix: ',2)' },
      { label: 'perm(n, k)', hint: 'permutations', prefix: 'perm(', suffix: ',2)' },
    ],
  },
];

export function FunctionsMenu({ onInsert }) {
  let open = false;
  const root = h('div', { class: 'functions-menu' });
  const trigger = h(
    'button',
    { type: 'button', class: 'functions-menu__trigger', title: 'Functions', 'aria-label': 'Functions', onclick: toggle },
    '☰',
  );
  const panel = h('div', { class: 'functions-menu__panel' });
  root.append(trigger, panel);

  for (const cat of CATEGORIES) {
    const section = h('div', { class: 'functions-menu__section' }, h('div', { class: 'functions-menu__heading' }, cat.title));
    for (const item of cat.items) {
      section.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: 'functions-menu__item',
            onclick: () => {
              onInsert(item.prefix, item.suffix);
              setOpen(false);
            },
          },
          h('span', { class: 'functions-menu__itemLabel' }, item.label),
          item.hint ? h('span', { class: 'functions-menu__itemHint' }, item.hint) : null,
        ),
      );
    }
    panel.appendChild(section);
  }

  function setOpen(next) {
    open = next;
    trigger.classList.toggle('functions-menu__trigger--active', open);
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

  return { root, setDisabled };
}
