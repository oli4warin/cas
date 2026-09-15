// A minimal hyperscript-style helper so component code reads like the JSX it was ported
// from, without pulling in a framework. `h` builds one real DOM node per call - there is
// no virtual-dom diffing, so components that need to update after the initial render do it
// by mutating the returned node directly (see each component's `update`/setter functions).

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = value;
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && typeof el[key] !== 'function') {
        // Reflects props like `value`, `checked`, `disabled` as DOM properties (not just
        // attributes), which matters for form controls whose attribute and live state can
        // diverge (e.g. `value` after the user types).
        el[key] = value;
      } else if (value === true) {
        el.setAttribute(key, '');
      } else {
        el.setAttribute(key, value);
      }
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setChildren(el, children) {
  clear(el);
  append(el, [].concat(children));
}

// Reorders `parent`'s children to match `desired` (all inserted immediately before
// `anchor`), but does nothing at all when they already match `current` (the caller's own
// list of the relevant current children, pre-filtered to exclude any fixed
// sentinels/siblings that aren't part of the reordered set). Skipping the no-op case
// matters: an `insertBefore` that "moves" a node to the position it's already in can still
// blur a focused input inside it in some browsers, which is exactly the wrong thing to do
// when this runs on every keystroke (see plotPanel.js/tablePanel.js, both of which
// re-reconcile row/column order after every field edit).
export function reconcileOrder(parent, current, desired, anchor = null) {
  const same = current.length === desired.length && current.every((el, i) => el === desired[i]);
  if (same) return;
  for (const node of desired) parent.insertBefore(node, anchor);
}

export function svg(tag, props) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) el.setAttribute(key, value);
  }
  return el;
}
