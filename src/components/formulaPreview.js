import { h } from '../lib/dom.js';
import { typesetNode } from '../lib/mathjax.js';

// Same imperative-DOM approach the original React version used everywhere MathJax touches
// a node: MathJax rewrites the node's children in place, so nothing else should try to own
// them - here that's simply the natural way to do it, since there's no diffing framework
// fighting it in the first place.
export function FormulaPreview({ placeholder = 'Formula preview', className = 'formula-preview' } = {}) {
  const span = h('span');
  const root = h('div', { class: `${className} ${className}--empty` }, span);
  let debounceTimer = null;

  function update(latex) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (latex) {
        root.className = className;
        span.textContent = '\\(' + latex + '\\)';
        typesetNode(span);
      } else {
        root.className = `${className} ${className}--empty`;
        span.textContent = placeholder;
      }
    }, 60);
  }

  return { root, update };
}
