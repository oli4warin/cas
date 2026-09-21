import { h } from '../lib/dom.js';
import { typesetNode } from '../lib/mathjax.js';
import { giacToLatex } from '../lib/giacToLatex.js';
import { reinsertableValue } from '../lib/giac.js';
import { plottableExprForEntry } from '../lib/plottable.js';
import { saveableExprForEntry } from '../lib/saveable.js';

// Renders one In[]/Out[] pair. `onSelect`/`onDelete` are called with this entry's index;
// `onPlot` is called with (index, expr) when the plot button is clicked, only ever present
// when plottableExprForEntry actually found something to plot (see there) - same check the
// "p" keyboard shortcut on a selected output uses (see app.js), so both agree on exactly
// which outputs offer this. `onSave` is the same idea for the "save" button/"s" shortcut and
// saveableExprForEntry. `showText` is read fresh on every render() call (App owns that as
// global UI state).
export function HistoryEntry({ entry, index, onSelect, onDelete, onPlot, onSave }) {
  const plotExpr = plottableExprForEntry(entry);
  const saveExpr = saveableExprForEntry(entry);
  let copiedTimeout = null;

  const inputMath = h('span', { class: 'entry__math' });
  const inputText = h('span', { class: 'entry__inputText' }, entry.input);
  const inputRawText = h('span', { class: 'entry__rawText' }, entry.input);
  const inputCopied = h('span', { class: 'entry__copied' }, 'Copied');
  inputCopied.style.display = 'none';
  const inputContent = h('div', { class: 'entry__content' }, inputMath, inputText, inputRawText);

  const resultMath = h('span', { class: 'entry__math' });
  const errorText = h('span', { class: 'entry__errorText' }, entry.text);
  const plainText = h('span', { class: 'entry__plainText' }, entry.text);
  const outputRawText = h('span', { class: 'entry__rawText' }, entry.text);
  const outputCopied = h('span', { class: 'entry__copied' }, 'Copied');
  outputCopied.style.display = 'none';
  const outputContent = h('div', { class: 'entry__content' }, resultMath, errorText, plainText, outputRawText);

  const inputRow = h(
    'div',
    { class: 'entry__input', role: 'button', tabindex: 0, onclick: () => copyToClipboard('input', entry.input) },
    h('span', { class: 'entry__prompt' }, `In[${index + 1}]`),
    inputContent,
    inputCopied,
  );

  const outputRow = h(
    'div',
    {
      class: 'entry__output',
      role: 'button',
      tabindex: 0,
      onclick: () => !entry.isError && copyToClipboard('output', reinsertableValue(entry.raw)),
    },
    h('span', { class: 'entry__prompt' }, `Out[${index + 1}]`),
    outputContent,
    outputCopied,
  );

  const deleteBtn = h(
    'button',
    {
      type: 'button',
      class: 'entry__delete',
      'aria-label': 'Delete this input/output pair',
      title: 'Delete',
      onclick: () => onDelete(index),
    },
    '×',
  );

  // Only rendered at all when this output is actually plottable (see plotExpr above) -
  // stopPropagation keeps its click from also bubbling to outputRow's own onclick (which
  // would otherwise copy the output to the clipboard at the same time).
  const plotBtn = h(
    'button',
    {
      type: 'button',
      class: 'entry__plot',
      'aria-label': 'Plot this function',
      title: 'Plot this function (p)',
      onclick: (e) => {
        e.stopPropagation();
        onPlot(index, plotExpr);
      },
    },
    'plot',
  );
  if (!plotExpr) plotBtn.style.display = 'none';

  // Only rendered at all when this output actually carries a ready-made assignment (see
  // saveExpr above) - stopPropagation for the same reason as plotBtn's.
  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'entry__save',
      'aria-label': 'Save the solved variable(s)',
      title: 'Save the solved variable(s) (s)',
      onclick: (e) => {
        e.stopPropagation();
        onSave(index, saveExpr);
      },
    },
    'save',
  );
  if (!saveExpr) saveBtn.style.display = 'none';

  const root = h('div', { class: `entry${entry.isError ? ' entry--error' : ''}` }, deleteBtn, plotBtn, saveBtn, inputRow, outputRow);

  // Same best-effort syntax-only converter as the live input preview (see app.js) - it
  // never touches the engine, so a submitted input renders identically to how it looked
  // while being typed. A system typed one equation per line (see joinInputLines/app.js -
  // entry.input keeps the actual line breaks, unlike the " and "-joined form sent to the
  // engine) renders each line's math separately and stacks them in a `gathered` block,
  // rather than joining lines into running text - if any single line fails to convert, the
  // whole thing falls back to plain text together, same as a single line already does.
  const inputLines = entry.input.split('\n');
  const inputLatex =
    inputLines.length === 1
      ? giacToLatex(entry.input) || ''
      : (() => {
          const rendered = inputLines.map((line) => giacToLatex(line));
          return rendered.every(Boolean) ? `\\begin{gathered}${rendered.join('\\\\')}\\end{gathered}` : '';
        })();
  if (inputLatex) {
    inputMath.textContent = '\\[' + inputLatex + '\\]';
    inputMath.style.display = '';
    inputText.style.display = 'none';
    typesetNode(inputMath);
  } else {
    inputMath.style.display = 'none';
    inputText.style.display = '';
  }

  if (entry.isError) {
    errorText.style.display = '';
    plainText.style.display = 'none';
    resultMath.style.display = 'none';
  } else if (entry.latex) {
    resultMath.textContent = '\\[' + entry.latex + '\\]';
    resultMath.style.display = '';
    errorText.style.display = 'none';
    plainText.style.display = 'none';
    typesetNode(resultMath);
  } else {
    plainText.style.display = '';
    errorText.style.display = 'none';
    resultMath.style.display = 'none';
  }

  function setShowText(showText) {
    inputRawText.style.display = showText && inputLatex ? '' : 'none';
    outputRawText.style.display = showText && !entry.isError && entry.latex ? '' : 'none';
  }

  function setSelected(part) {
    inputRow.classList.toggle('entry__input--selected', part === 'input');
    outputRow.classList.toggle('entry__output--selected', part === 'output');
  }

  // Clicking In[] or Out[] copies just that part to the clipboard (not the other), so
  // reaching for a previous result doesn't drag its input expression along with it.
  function copyToClipboard(part, text) {
    navigator.clipboard?.writeText(text).catch(() => {});
    onSelect(index, part);
    const badge = part === 'input' ? inputCopied : outputCopied;
    badge.style.display = '';
    clearTimeout(copiedTimeout);
    copiedTimeout = setTimeout(() => {
      badge.style.display = 'none';
    }, 1000);
  }

  return { root, setSelected, setShowText };
}
