import { h, clear } from './lib/dom.js';
import {
  ensureGiacLoaded,
  evaluate as giacEvaluate,
  evaluateApprox as giacEvaluateApprox,
  cancelCurrentEval,
  looksIncomplete,
  reinsertableValue,
  joinInputLines,
  normalizeMultilineInput,
  normalizeDelCommand,
  evaluateRaw as giacEvaluateRaw,
  setAutosimplifyLevel as giacSetAutosimplifyLevel,
  setTauMode as giacSetTauMode,
  setPauMode as giacSetPauMode,
} from './lib/giac.js';
import { giacToLatex } from './lib/giacToLatex.js';
import { typesetNode } from './lib/mathjax.js';
import { applyEntryToDefinitions, parseDefinition, parseMultiDefinition, definitionLabel } from './lib/definitions.js';
import { plottableInputForEntry, plottableOutputForEntry } from './lib/plottable.js';
import { saveableForEntry } from './lib/saveable.js';
import { displayListIndexAliases } from './lib/listIndexAlias.js';
import { startBridgeHost } from './lib/plotBridge.js';
import { DEFAULT_VIEW, makeRow } from './lib/plotRows.js';
import { makeInitialColumns } from './lib/tableColumns.js';
import { HistoryEntry } from './components/historyEntry.js';
import { PlotPanel } from './components/plotPanel.js';
import { TablePanel } from './components/tablePanel.js';
import { Credits } from './components/credits.js';
import { SettingsMenu } from './components/settingsMenu.js';
import { VariablesMenu } from './components/variablesMenu.js';
import { FunctionsMenu } from './components/functionsMenu.js';
import { DistributionMenu } from './components/distributionMenu.js';
import { SaveMenu } from './components/saveMenu.js';
import { RegressionMenu } from './components/regressionMenu.js';
import { SysSolveMenu } from './components/sysSolveMenu.js';
import { XCAS_COMMANDS } from './lib/xcasCommands.js';
import { findDistributionMenu } from './lib/distributionParams.js';
import { isRegressionMenuCommand } from './lib/regressionParams.js';
import { isSysSolveMenuCommand } from './lib/sysSolveParams.js';

function makeSessionId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function getInitialTheme() {
  try {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage can throw in locked-down environments (private mode, disabled storage) -
    // fall through to the default below.
  }
  return 'dark';
}

// Off by default - the raw text is a fallback for spotting a rendering bug, not something
// most sessions need cluttering every entry.
function getInitialShowText() {
  try {
    return localStorage.getItem('showText') === '1';
  } catch {
    return false;
  }
}

// Off by default - the math keyboard and keyboard-shortcut hints are a beginner aid, not
// something every session needs taking up screen space. Toggled via the small buttons next
// to each (see setToolbarVisible/setHintsVisible below) and remembered per browser.
function getInitialToolbarVisible() {
  try {
    return localStorage.getItem('toolbarVisible') === '1';
  } catch {
    return false;
  }
}
function getInitialTauMode() {
  try {
    return localStorage.getItem('tauMode') === '1';
  } catch {
    return false;
  }
}
function getInitialHintsVisible() {
  try {
    return localStorage.getItem('hintsVisible') === '1';
  } catch {
    return false;
  }
}

// Flattens history into a single up/down browsing order: most recent output first, then
// that same entry's input, then the previous entry's output, and so on. An entry that
// errored has no reinsertable output, so only its input step is included.
function buildHistorySteps(history) {
  const steps = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (!history[i].isError) steps.push({ idx: i, part: 'output' });
    steps.push({ idx: i, part: 'input' });
  }
  return steps;
}

// The math keyboard (see toolbar/toolbarWrap in mountApp), grouped so related buttons sit
// together and share a color accent (see the toolbar__group--* rules in app.css) - purely a
// visual grouping aid, it has no effect on insertion behavior. Each item's prefix/suffix are
// inserted around the current selection (or just the cursor) - see insertSnippet - unless
// `wrap: false`, which instead drops any selection and inserts `prefix` as plain typed text
// (see insertPlain) - used for bare identifiers (variables, digits, operators, constants,
// "=", ":=") where wrapping a selection would glue it onto the identifier instead of
// replacing it. An item may instead carry `nav` ('left'/'right'/'up'/'down'/'backspace'),
// which moves the cursor (see moveCursor) or deletes (see backspaceAtCursor) rather than
// inserting anything - used for the arrow-key/backspace group below. `col` sends the group
// to the left (functions/variables) or right (the calculator keypad) column - see
// toolbar__col--* in app.css - loosely following the functions-left/keypad-right split
// Qalculate's keyboard uses.
const TOOLBAR_GROUPS = [
  {
    key: 'vars',
    col: 'left',
    items: [
      { label: 'x', prefix: 'x', wrap: false },
      { label: 'y', prefix: 'y', wrap: false },
      { label: 't', prefix: 't', wrap: false },
      { label: ':=', prefix: ':=', wrap: false },
    ],
  },
  {
    key: 'const',
    col: 'left',
    items: [
      { label: 'π', prefix: 'pi', wrap: false },
      { label: 'τ', prefix: 'tau', wrap: false },
      { label: 'e', prefix: 'e', wrap: false },
    ],
  },
  {
    key: 'trig',
    col: 'left',
    items: [
      { label: 'sin', prefix: 'sin(', suffix: ')' },
      { label: 'cos', prefix: 'cos(', suffix: ')' },
      { label: 'tan', prefix: 'tan(', suffix: ')' },
      { label: 'asin', prefix: 'asin(', suffix: ')' },
      { label: 'acos', prefix: 'acos(', suffix: ')' },
      { label: 'atan', prefix: 'atan(', suffix: ')' },
    ],
  },
  {
    key: 'log',
    col: 'left',
    items: [
      { label: 'ln', prefix: 'ln(', suffix: ')' },
      { label: 'log', prefix: 'log(', suffix: ')' },
      { label: 'logₐ', prefix: 'logb(', suffix: ')' },
    ],
  },
  {
    key: 'calc',
    col: 'left',
    items: [
      { label: '∫', prefix: 'integrate(', suffix: ',x)' },
      { label: 'd/dx', prefix: 'diff(', suffix: ',x)' },
      { label: 'lim', prefix: 'limit(', suffix: ',x,0)' },
      { label: 'Σ', prefix: 'sum(', suffix: ',x,1,10)' },
    ],
  },
  {
    key: 'alg',
    col: 'left',
    items: [
      { label: 'solve', prefix: 'solve(', suffix: '=0,x)' },
      { label: 'factor', prefix: 'factor(', suffix: ')' },
      { label: 'expand', prefix: 'expand(', suffix: ')' },
      { label: 'simplify', prefix: 'simplify(', suffix: ')' },
    ],
  },
  {
    key: 'basic',
    col: 'right',
    items: [
      { label: '( )', prefix: '(', suffix: ')' },
      { label: '[ ]', prefix: '[', suffix: ']' },
      { label: '=', prefix: '=', wrap: false },
      { label: '√', prefix: 'sqrt(', suffix: ')' },
      { label: 'x²', prefix: '^2', suffix: '' },
      { label: 'xʸ', prefix: '^', suffix: '' },
      { label: 'abs', prefix: 'abs(', suffix: ')' },
    ],
  },
  {
    key: 'num',
    col: 'right',
    // A physical-calculator-style keypad (see toolbar__group--num in app.css): digits 7-9/
    // 4-6/1-3 with the operator column (÷×−) running down the right, then a bottom row of
    // "." and a wide "0" and "+" - 4 columns throughout, "0" spanning 2 of them.
    items: [
      { label: '7', prefix: '7', wrap: false },
      { label: '8', prefix: '8', wrap: false },
      { label: '9', prefix: '9', wrap: false },
      { label: '÷', prefix: '/', wrap: false },
      { label: '4', prefix: '4', wrap: false },
      { label: '5', prefix: '5', wrap: false },
      { label: '6', prefix: '6', wrap: false },
      { label: '×', prefix: '*', wrap: false },
      { label: '1', prefix: '1', wrap: false },
      { label: '2', prefix: '2', wrap: false },
      { label: '3', prefix: '3', wrap: false },
      { label: '−', prefix: '-', wrap: false },
      { label: '.', prefix: '.', wrap: false },
      { label: '0', prefix: '0', wrap: false, span2: true },
      { label: '+', prefix: '+', wrap: false },
    ],
  },
  {
    key: 'nav',
    col: 'right',
    // Arrow-key cluster plus backspace and new-line for touchscreens, where those physical
    // keys aren't reachable - moves the cursor, deletes, or inserts a newline (see
    // moveCursor/backspaceAtCursor/insertNewline) instead of inserting a math snippet. Sits
    // below the keypad, same 4-column grid: arrows fill one row, then backspace and new-line
    // share the row below, half the width each.
    items: [
      { label: '←', nav: 'left' },
      { label: '↑', nav: 'up' },
      { label: '↓', nav: 'down' },
      { label: '→', nav: 'right' },
      { label: '⌫', nav: 'backspace', span2: true },
      { label: '⏎', nav: 'newline', span2: true, title: 'New line - same as Shift+Enter' },
    ],
  },
];

const EXAMPLES = ['integrate(sin(x)*x,x)', 'solve(x^2-5*x+6=0,x)', 'factor(x^3-1)', 'limit(sin(x)/x,x,0)'];

// Names offered by input tab completion: the full Giac/Xcas command set (see
// lib/xcasCommands.js), not just the handful curated in the functions menu.
const STATIC_COMPLETION_NAMES = Object.keys(XCAS_COMMANDS);

export function mountApp(root) {
  const state = {
    status: 'loading', // 'loading' | 'ready' | 'error'
    error: null,
    history: [],
    navPos: -1, // -1 = live / not browsing, else an index into `steps`
    warning: null,
    busy: false,
    definitions: new Map(),
    plotOpen: false,
    tableOpen: false,
    mobileView: 'calculator',
    plotRows: [makeRow()],
    plotView: DEFAULT_VIEW,
    tableColumns: makeInitialColumns(),
    angleMode: 'RAD',
    approxMode: false,
    autosimplify: 1, // 0=none, 1=regroup, 2=simplify - matches evaluate()'s own default in giac.js
    tauMode: getInitialTauMode(),
    pauMode: false, // the "paumode" easter egg (see submit()) - never persisted, session-only
    theme: getInitialTheme(),
    showText: getInitialShowText(),
    toolbarVisible: getInitialToolbarVisible(),
    hintsVisible: getInitialHintsVisible(),
  };
  // Purely a display preference (see piToTau in giac.js - it never changes what's actually
  // computed, only how a pi-valued result is shown), so unlike angleMode/approxMode/
  // autosimplify below it needs no "re-apply once the engine is ready" step - giac.js's own
  // module-level flag just needs to start out matching the persisted value.
  giacSetTauMode(state.tauMode);

  const sessionId = makeSessionId();
  // Snapshot of the rows/view being handed off to a popped-out window, taken at the
  // instant popOutPlot() fires - see the comment there for why this can't just read the
  // live plotRows/plotView (those get reset to blank in that same click handler, and the
  // popup's state request only arrives after that reset has already landed).
  let plotHandoff = null;
  let bridgeHost = null;
  let plotPanelInstance = null;
  let tablePanelInstance = null;

  const entryViews = []; // parallel to state.history

  // ---------- static structure ----------

  const title = h('h1', null, 'Calculator');
  const printBtn = h('button', { type: 'button', class: 'header__plotBtn', onclick: () => window.print() }, 'Print');
  const plotBtn = h('button', { type: 'button', class: 'header__plotBtn', title: 'Alt+P', onclick: () => (state.plotOpen ? closePlot() : openPlot()) }, 'Plot');
  const tableBtn = h('button', { type: 'button', class: 'header__plotBtn', title: 'Alt+T', onclick: () => (state.tableOpen ? closeTable() : openTable()) }, 'Table');
  const functionsMenu = FunctionsMenu({ onInsert: handleFunctionsMenuInsert });
  const distributionMenu = DistributionMenu({
    onSubmit: (expr) => {
      input.value = expr;
      submit({ force: true });
      input.focus();
    },
    onCancel: () => input.focus(),
  });
  const regressionMenu = RegressionMenu({
    onSubmit: (expr) => {
      input.value = expr;
      submit({ force: true });
      input.focus();
    },
    onCancel: () => input.focus(),
  });
  const saveMenu = SaveMenu({
    onSubmit: (expr, index) => {
      saveEntryVariables(expr, index);
      input.focus();
    },
    onCancel: () => input.focus(),
  });
  const sysSolveMenu = SysSolveMenu({
    onSubmit: (expr) => {
      input.value = expr;
      submit({ force: true });
      input.focus();
    },
    onCancel: () => input.focus(),
  });
  const settingsMenu = SettingsMenu({
    onAngleModeChange: handleAngleModeChange,
    onApproxChange: handleApproxModeChange,
    onAutosimplifyChange: handleAutosimplifyChange,
    onTauModeChange: handleTauModeChange,
    onThemeChange: handleThemeChange,
    onShowTextChange: handleShowTextChange,
  });
  const variablesMenu = VariablesMenu({ onPurge: purgeVariable });
  const statusPill = h('span', { class: 'status-pill' });

  const header = h(
    'header',
    { class: 'header' },
    title,
    h(
      'div',
      { class: 'header__actions' },
      printBtn,
      plotBtn,
      tableBtn,
      functionsMenu.root,
      variablesMenu.root,
      settingsMenu.root,
      statusPill,
    ),
  );

  const historyList = h('main', { class: 'history' });
  const emptyHint = h('div', { class: 'empty-hint' });
  const loadingHint = h(
    'div',
    { class: 'empty-hint' },
    h('div', { class: 'loading-bar' }, h('div', { class: 'loading-bar__fill' })),
    h('p', null, 'Downloading and starting the Xcas computer algebra engine…'),
    h('p', { class: 'empty-hint__small' }, "First load pulls ~18MB of WebAssembly; it's cached by the browser afterwards."),
  );
  const errorHint = h('div', { class: 'empty-hint empty-hint--error' });

  const previewSpan = h('span');
  const previewWrap = h('div', { class: 'formula-preview formula-preview--empty' }, previewSpan);
  let previewDebounce = null;

  const input = h('textarea', {
    class: 'input-row__field',
    rows: 1,
    placeholder: 'Waiting for engine…',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: false,
  });
  const submitBtn = h('button', { type: 'button', class: 'input-row__submit', onclick: () => submit({}) }, '=');
  const stopBtn = h('button', { type: 'button', class: 'input-row__submit input-row__submit--stop', onclick: () => cancelCurrentEval() }, 'Stop');
  stopBtn.style.display = 'none';

  // Floats directly under the input, overlapping the toolbar below it rather than pushing
  // it down, while a completion session is open - opened automatically as the user types a
  // matching identifier (see updateLiveCompletions) or explicitly via Tab (see tryCompleteWord);
  // both go through startCompletion/selectCompletion/hideCompletions. Arrow keys, Tab and mouse
  // clicks all select a candidate, Escape dismisses the list (see handleKeyDown); items use
  // tabindex="-1" so clicking one never steals focus via the browser's own tab order, only via
  // the explicit selection logic here.
  const completionsBar = h('div', { class: 'completions-bar' });
  completionsBar.style.display = 'none';
  const inputRow = h('div', { class: 'input-row' }, input, submitBtn, stopBtn, completionsBar);

  function renderToolbarGroup(g) {
    return h(
      'div',
      { class: `toolbar__group toolbar__group--${g.key}` },
      g.items.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: `toolbar__btn${t.span2 ? ' toolbar__btn--span2' : ''}`,
            title: t.title,
            onclick: () => {
              if (t.nav === 'backspace') backspaceAtCursor();
              else if (t.nav === 'newline') insertNewline();
              else if (t.nav) moveCursor(t.nav);
              else if (t.wrap === false) insertPlain(t.prefix);
              else insertSnippet(t.prefix, t.suffix);
            },
          },
          t.label,
        ),
      ),
    );
  }
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h(
      'div',
      { class: 'toolbar__col toolbar__col--left' },
      TOOLBAR_GROUPS.filter((g) => g.col === 'left').map(renderToolbarGroup),
    ),
    h(
      'div',
      { class: 'toolbar__col toolbar__col--right' },
      TOOLBAR_GROUPS.filter((g) => g.col === 'right').map(renderToolbarGroup),
    ),
  );
  const toolbarToggle = h(
    'button',
    { type: 'button', class: 'bar-toggle', onclick: () => setToolbarVisible(!state.toolbarVisible) },
    '',
  );

  const warningBar = h('div', { class: 'warning-bar' });
  warningBar.style.display = 'none';

  const hintBar = h(
    'footer',
    { class: 'hint-bar' },
    h('span', null, '↑ / ↓ select an output or input'),
    h('span', null, 'Enter/Tab insert selection at cursor'),
    h('span', null, 'Function names suggest as you type - Tab picks a candidate, then ←/→/Tab cycle, Enter or click confirms, Esc dismisses'),
    h('span', null, 'Enter evaluate (no selection)'),
    h('span', null, 'Shift+Enter new line - one equation per line solves as a system'),
    h('span', null, 'Ctrl+Enter evaluate numerically'),
    h('span', null, 'Enter on empty input repeats the last one'),
    h('span', null, 'Esc clear selection (or return to input from plot/table)'),
    h('span', null, 'Backspace on a selected entry deletes it'),
    h('span', null, 'p on a selected input/output sends it to the plot panel, if plottable'),
    h('span', null, 's on a selected input/output saves it, if saveable'),
    h('span', null, 'Alt+P plot · Alt+T table'),
  );
  const hintsToggle = h(
    'button',
    { type: 'button', class: 'bar-toggle', onclick: () => setHintsVisible(!state.hintsVisible) },
    '',
  );
  // Both toggles share one row (rather than each getting its own bar-toggle-row above the
  // section it controls) so that collapsing both the math keyboard and the hints - the
  // common "just give me the input" state - leaves only a single slim row, not two.
  const togglesWrap = h('div', { class: 'bar-toggle-row' }, toolbarToggle, hintsToggle);

  const appColumn = h(
    'div',
    { class: 'app' },
    header,
    historyList,
    previewWrap,
    inputRow,
    togglesWrap,
    toolbar,
    warningBar,
    hintBar,
    Credits(),
  );

  function setToolbarVisible(visible) {
    state.toolbarVisible = visible;
    toolbar.style.display = visible ? '' : 'none';
    toolbarToggle.textContent = visible ? 'Hide math keyboard ▲' : 'Show math keyboard ▼';
    // inputmode="none" tells mobile browsers this field manages its own on-screen input, so
    // they suppress the OS virtual keyboard - without it, focusing/tapping the field to use the
    // math keyboard also pops the OS keyboard up over it. Only relevant while the math keyboard
    // is shown; with it hidden the field should behave like a normal text input again.
    if (visible) input.setAttribute('inputmode', 'none');
    else input.removeAttribute('inputmode');
    try {
      localStorage.setItem('toolbarVisible', visible ? '1' : '0');
    } catch {
      // ignore - see getInitialShowText for why storage can throw.
    }
  }
  function setHintsVisible(visible) {
    state.hintsVisible = visible;
    hintBar.style.display = visible ? '' : 'none';
    hintsToggle.textContent = visible ? 'Hide keyboard hints ▲' : 'Show keyboard hints ▼';
    try {
      localStorage.setItem('hintsVisible', visible ? '1' : '0');
    } catch {
      // ignore - see getInitialShowText for why storage can throw.
    }
  }
  setToolbarVisible(state.toolbarVisible);
  setHintsVisible(state.hintsVisible);

  const calcColumn = h('div', { class: 'layout__calc' }, appColumn);

  const tabCalc = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('calculator') }, 'Calculator');
  const tabPlot = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('plot') }, 'Plot');
  const tabTable = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('table') }, 'Table');
  const tabsBar = h('div', { class: 'layout__tabs' }, tabCalc, tabPlot, tabTable);
  tabsBar.style.display = 'none';

  const plotItem = h('div', { class: 'layout__plotItem' });
  const tableItem = h('div', { class: 'layout__tableItem' });
  const sideColumn = h('div', { class: 'layout__side' }, plotItem, tableItem);
  sideColumn.style.display = 'none';

  const layout = h('div', { class: 'layout' }, tabsBar, calcColumn, sideColumn);

  clear(root);
  root.appendChild(layout);
  root.appendChild(distributionMenu.root);
  root.appendChild(regressionMenu.root);
  root.appendChild(sysSolveMenu.root);
  root.appendChild(saveMenu.root);

  // ---------- rendering helpers ----------

  function renderLayout() {
    const split = state.plotOpen || state.tableOpen;
    layout.className = `layout${split ? ' layout--split' : ''}`;
    layout.dataset.mobileView = state.mobileView;
    tabsBar.style.display = split ? '' : 'none';
    tabPlot.style.display = state.plotOpen ? '' : 'none';
    tabTable.style.display = state.tableOpen ? '' : 'none';
    tabCalc.classList.toggle('layout__tab--active', state.mobileView === 'calculator');
    tabPlot.classList.toggle('layout__tab--active', state.mobileView === 'plot');
    tabTable.classList.toggle('layout__tab--active', state.mobileView === 'table');
    sideColumn.style.display = split ? '' : 'none';
    plotItem.style.display = state.plotOpen ? '' : 'none';
    tableItem.style.display = state.tableOpen ? '' : 'none';

    plotBtn.classList.toggle('header__plotBtn--active', state.plotOpen);
    tableBtn.classList.toggle('header__plotBtn--active', state.tableOpen);
    printBtn.disabled = state.history.length === 0;
  }

  function renderStatus() {
    const engineReady = state.status === 'ready';
    statusPill.className = `status-pill status-pill--${state.busy ? 'busy' : state.status}`;
    statusPill.textContent =
      state.status === 'loading' ? 'Loading engine…' : state.status === 'ready' ? (state.busy ? 'Evaluating…' : 'Ready') : state.status === 'error' ? 'Failed to load' : '';

    input.disabled = !engineReady;
    input.placeholder = state.status === 'ready' ? 'Enter an expression…' : 'Waiting for engine…';
    submitBtn.disabled = !engineReady;
    submitBtn.style.display = state.busy ? 'none' : '';
    stopBtn.style.display = state.busy ? '' : 'none';

    functionsMenu.setDisabled(!engineReady);
    settingsMenu.update({
      angleMode: state.angleMode,
      approx: state.approxMode,
      autosimplify: state.autosimplify,
      tauMode: state.tauMode,
      showText: state.showText,
      theme: state.theme,
      disabled: !engineReady || state.busy,
    });

    for (const btn of toolbar.querySelectorAll('button')) btn.disabled = !engineReady;
  }

  function renderHistoryEmptyState() {
    const showEmpty = state.history.length === 0 && state.status === 'ready';
    const showLoading = state.status === 'loading';
    const showError = state.status === 'error';

    if (showEmpty && emptyHint.parentElement == null) historyList.insertBefore(emptyHint, historyList.firstChild);
    if (!showEmpty && emptyHint.parentElement) emptyHint.remove();
    if (showLoading && loadingHint.parentElement == null) historyList.insertBefore(loadingHint, historyList.firstChild);
    if (!showLoading && loadingHint.parentElement) loadingHint.remove();
    if (showError && errorHint.parentElement == null) historyList.insertBefore(errorHint, historyList.firstChild);
    if (!showError && errorHint.parentElement) errorHint.remove();
    if (showError) errorHint.textContent = state.error || '';
  }

  function renderWarning() {
    if (state.warning) {
      warningBar.textContent = state.warning;
      warningBar.style.display = '';
    } else {
      warningBar.style.display = 'none';
    }
  }

  if (emptyHint.children.length === 0) {
    emptyHint.append(
      h('p', null, 'Type an expression and press Enter. Examples:'),
      h(
        'ul',
        null,
        EXAMPLES.map((expr) => h('li', { onclick: () => selectExample(expr) }, expr)),
      ),
    );
  }

  // ---------- history ----------

  function steps() {
    return buildHistorySteps(state.history);
  }
  function currentStep() {
    const s = steps();
    return state.navPos >= 0 ? s[state.navPos] : null;
  }

  function updateSelection() {
    const step = currentStep();
    entryViews.forEach((view, idx) => {
      view.setSelected(step && step.idx === idx ? step.part : null);
    });
    if (step) {
      document.getElementById(`entry-${step.idx}`)?.scrollIntoView({ block: 'nearest' });
    }
    input.scrollIntoView({ block: 'nearest' });
  }

  function scrollHistoryToBottom() {
    historyList.scrollTop = historyList.scrollHeight;
    // MathJax typesets the newest entry's math asynchronously (see lib/mathjax), so its
    // final height isn't known yet on this first scroll - re-pin to bottom once that
    // layout settles a moment later.
    const observer = new MutationObserver(() => {
      historyList.scrollTop = historyList.scrollHeight;
      observer.disconnect();
    });
    observer.observe(historyList, { childList: true, subtree: true, characterData: true });
    setTimeout(() => observer.disconnect(), 1000);
  }

  function pushHistoryEntry(entry) {
    state.history.push(entry);
    const idx = state.history.length - 1;
    const view = HistoryEntry({
      entry,
      index: idx,
      onSelect: selectHistory,
      onDelete: deleteEntry,
      onPlot: (i, spec) => addExpressionToPlot(spec),
      onSave: (i, info) => handleSaveEntry(i, info),
      definitions: state.definitions,
    });
    view.setShowText(state.showText);
    const wrapper = h('div', { id: `entry-${idx}` }, view.root);
    historyList.appendChild(wrapper);
    entryViews.push(view);
    renderHistoryEmptyState();
    renderLayout();
    scrollHistoryToBottom();
  }

  // Removes one In/Out pair from the visible history - via the hover × button, or Backspace
  // while that entry's input or output is selected. This only drops the entry from the
  // notebook view; it doesn't (and can't cleanly) unwind any variable the engine assigned
  // while evaluating it, same as deleting a cell in a notebook doesn't rewind the kernel.
  function deleteEntry(idx) {
    state.history.splice(idx, 1);
    // Entries after the deleted one shift down one slot - their In[]/Out[] numbers and
    // captured index change, so tear down the deleted entry's wrapper *and* every
    // wrapper after it (whose ids/labels are about to change) before rebuilding.
    for (let i = idx; i < entryViews.length; i++) {
      document.getElementById(`entry-${i}`)?.remove();
    }
    entryViews.length = idx;
    for (let i = idx; i < state.history.length; i++) {
      const view = HistoryEntry({
        entry: state.history[i],
        index: i,
        onSelect: selectHistory,
        onDelete: deleteEntry,
        onPlot: (idx, spec) => addExpressionToPlot(spec),
        onSave: (idx, info) => handleSaveEntry(idx, info),
        definitions: state.definitions,
      });
      view.setShowText(state.showText);
      const wrapper = h('div', { id: `entry-${i}` }, view.root);
      historyList.appendChild(wrapper);
      entryViews.push(view);
    }
    state.navPos = -1;
    renderHistoryEmptyState();
    renderLayout();
    updateSelection();
  }

  // Clicking In[]/Out[] copies that part to the clipboard (see historyEntry.js) - this just
  // mirrors the click into the same selection state Up/Down browsing uses, so the copied
  // part is highlighted.
  function selectHistory(idx, part) {
    const pos = steps().findIndex((s) => s.idx === idx && s.part === part);
    state.navPos = pos;
    updateSelection();
  }

  // ---------- input helpers ----------

  function insertAtCursor(text, { wrapSelection = false } = {}) {
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const selected = wrapSelection ? value.slice(start, end) : '';
    const next = value.slice(0, start) + text.before + selected + text.after + value.slice(end);
    input.value = next;
    const pos = start + text.before.length + selected.length;
    input.focus();
    input.setSelectionRange(pos, pos);
    onInputChanged();
  }

  function insertSnippet(prefix, suffix) {
    insertAtCursor({ before: prefix, after: suffix }, { wrapSelection: true });
  }

  // Shared by the Enter-key handler and the hamburger FunctionsMenu: a bare command name
  // (no parentheses/arguments yet) that has a parameter-entry menu built for it opens that
  // menu instead of being left to error on evaluation. Returns true if a menu was opened.
  function openMenuForBareCommand(value) {
    const trimmed = value.trim();
    const menu = findDistributionMenu(trimmed);
    if (menu) {
      distributionMenu.open(menu);
      return true;
    }
    if (isRegressionMenuCommand(trimmed)) {
      regressionMenu.open();
      return true;
    }
    if (isSysSolveMenuCommand(trimmed)) {
      sysSolveMenu.open();
      return true;
    }
    return false;
  }

  // FunctionsMenu items insert a bare command name (see functionsMenu.js's CATEGORIES) -
  // if that leaves the input holding just that command, open its parameter menu right away
  // instead of making the user press Enter first.
  function handleFunctionsMenuInsert(prefix, suffix) {
    insertSnippet(prefix, suffix);
    openMenuForBareCommand(input.value);
  }

  // Moves the textarea's cursor the way the physical arrow keys would - used by the nav
  // group on the math keyboard (see TOOLBAR_GROUPS) for touchscreens where those keys
  // aren't reachable. Synthetic key events don't trigger a textarea's native cursor
  // movement, so this reimplements it: left/right collapse a selection to its near edge or
  // else step by one character, up/down keep the column offset and clamp to the target
  // line's length, the same way native caret movement does.
  function moveCursor(dir) {
    input.focus();
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    let pos;
    if (dir === 'left') {
      pos = start !== end ? start : Math.max(0, start - 1);
    } else if (dir === 'right') {
      pos = start !== end ? end : Math.min(value.length, end + 1);
    } else {
      const lines = value.split('\n');
      let lineIdx = 0;
      let col = 0;
      let offset = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i].length;
        if (i === lines.length - 1 || start <= offset + lineLen) {
          lineIdx = i;
          col = start - offset;
          break;
        }
        offset += lineLen + 1;
      }
      const targetIdx = dir === 'up' ? lineIdx - 1 : lineIdx + 1;
      if (targetIdx < 0) {
        pos = 0;
      } else if (targetIdx >= lines.length) {
        pos = value.length;
      } else {
        let targetOffset = 0;
        for (let i = 0; i < targetIdx; i++) targetOffset += lines[i].length + 1;
        pos = targetOffset + Math.min(col, lines[targetIdx].length);
      }
    }
    input.setSelectionRange(pos, pos);
  }

  // Deletes like the physical Backspace key would - used by the nav group's ⌫ button (see
  // TOOLBAR_GROUPS) for touchscreens. Deletes the current selection if there is one,
  // otherwise the one character before the cursor.
  function backspaceAtCursor() {
    input.focus();
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    if (start === end && start === 0) return;
    const delStart = start === end ? start - 1 : start;
    const next = value.slice(0, delStart) + value.slice(end);
    input.value = next;
    input.setSelectionRange(delStart, delStart);
    onInputChanged();
  }

  // Inserts literal text at the cursor, replacing any current selection like normal typing
  // would - used for bare identifiers (variable names, digits, constants, "=", ":=") on the
  // math keyboard, where wrapping a selection (see insertSnippet) would glue it onto the
  // identifier instead of replacing it, e.g. selecting "2" and tapping "x" should leave "x",
  // not "x2".
  function insertPlain(text) {
    insertAtCursor({ before: text, after: '' });
  }

  // Mirrors the textarea's own Shift+Enter handling (see handleKeyDown) as a button, for
  // mobile keyboards where holding Shift while tapping Enter is awkward or unavailable -
  // lets a system of equations (one per line) be typed without a physical keyboard.
  function insertNewline() {
    insertPlain('\n');
  }

  // Used by the example expressions shown on the empty history screen.
  function selectExample(expr) {
    input.value = expr;
    input.focus();
    input.setSelectionRange(expr.length, expr.length);
    onInputChanged();
  }

  // Grows the textarea to fit its content (one equation per line - see joinInputLines/the
  // Enter handling below), capped so a long paste scrolls internally instead of pushing the
  // rest of the page around. Reset to 'auto' first so shrinking (deleting a line) is picked
  // up too, not just growth - scrollHeight never reports smaller than the current height
  // otherwise.
  function autosizeInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }

  function updatePreview() {
    autosizeInput();
    const latex = giacToLatex(displayListIndexAliases(joinInputLines(input.value), state.definitions)) || '';
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(() => {
      if (latex) {
        previewWrap.className = 'formula-preview';
        previewSpan.textContent = '\\[' + latex + '\\]';
        typesetNode(previewSpan);
      } else {
        previewWrap.className = 'formula-preview formula-preview--empty';
        previewSpan.textContent = 'Formula preview';
      }
    }, 60);
  }

  function onInputChanged() {
    updatePreview();
    updateLiveCompletions();
    if (state.navPos >= 0) {
      state.navPos = -1;
      updateSelection();
    }
    if (state.warning) {
      state.warning = null;
      renderWarning();
    }
  }

  input.addEventListener('input', onInputChanged);

  // Inserts the given history step's value at the cursor, merging into whatever is
  // already typed rather than replacing it (e.g. typing "2*", selecting an entry, then
  // confirming leaves "2*entry" - it never overwrites the "2*" that was already there).
  function insertStepAtCursor(step) {
    const entry = state.history[step.idx];
    const text = step.part === 'input' ? entry.input : reinsertableValue(entry.raw);
    insertAtCursor({ before: text, after: '' });
  }

  // ---------- tab completion ----------

  // The identifier being typed right up to the cursor, e.g. "sq" in "2+sq|rt(9)" (| = caret) -
  // empty when the caret isn't right after a name (nothing typed, or it follows an operator).
  function wordBeforeCursor() {
    if (input.selectionStart !== input.selectionEnd) return '';
    const upToCaret = input.value.slice(0, input.selectionStart ?? input.value.length);
    return upToCaret.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
  }

  // Case-insensitive so a set of candidates that only differ by case (e.g. matching "fmax"
  // against "fMax") doesn't collapse the shared prefix to nothing - the casing kept for each
  // shared character comes from whichever candidate is first (typically enough to matter only
  // for the handful of names that are otherwise identical letter-for-letter).
  function longestCommonPrefix(words) {
    return words.reduce((prefix, word) => {
      let i = 0;
      while (i < prefix.length && i < word.length && prefix[i].toLowerCase() === word[i].toLowerCase()) i++;
      return prefix.slice(0, i);
    });
  }

  // An active Tab-completion session: the full candidate list, which one (if any) is
  // currently highlighted, and the input range the chosen candidate currently occupies (start
  // is fixed at the original word's position; end moves as selectCompletion swaps candidates
  // in and out). completionMatches.length === 0 means no session is active.
  let completionMatches = [];
  let completionIndex = -1;
  let completionStart = -1;
  let completionEnd = -1;

  // Renders the candidate list floating under the input (see completionsBar's wiring above) -
  // items are clickable (mousedown, so the input never loses focus) but not part of the
  // browser's own tab order, so Tab can never land on one by accident.
  function renderCompletions() {
    clear(completionsBar);
    completionsBar.append(
      h('span', { class: 'completions-bar__count' }, `${completionMatches.length} match${completionMatches.length === 1 ? '' : 'es'}:`),
    );
    completionMatches.forEach((name, idx) => {
      const item = h(
        'span',
        {
          class: `completions-bar__item${idx === completionIndex ? ' completions-bar__item--selected' : ''}`,
          title: XCAS_COMMANDS[name] || '',
          tabindex: -1,
          onmousedown: (e) => {
            e.preventDefault();
            selectCompletion(idx);
            hideCompletions();
          },
        },
        name,
      );
      completionsBar.append(item);
      if (idx === completionIndex) item.scrollIntoView({ block: 'nearest' });
    });
    completionsBar.style.display = '';
  }

  function hideCompletions() {
    completionsBar.style.display = 'none';
    completionMatches = [];
    completionIndex = -1;
    completionStart = -1;
    completionEnd = -1;
  }

  // Opens an interactive completion session over `matches`, with `start`/`end` the input
  // range the (already inserted) common-prefix fill occupies - nothing is highlighted yet, so
  // arrow keys/Tab start from the top and Enter simply accepts the prefix as typed.
  function startCompletion(matches, start, end) {
    completionMatches = matches;
    completionIndex = -1;
    completionStart = start;
    completionEnd = end;
    renderCompletions();
  }

  // Moves the highlighted candidate to `index` (wrapping around both ends) and writes it
  // into the input in place of whatever the completion range currently holds.
  function selectCompletion(index) {
    const n = completionMatches.length;
    completionIndex = ((index % n) + n) % n;
    const name = completionMatches[completionIndex];
    input.value = input.value.slice(0, completionStart) + name + input.value.slice(completionEnd);
    completionEnd = completionStart + name.length;
    input.focus();
    input.setSelectionRange(completionEnd, completionEnd);
    updatePreview();
    renderCompletions();
  }

  // Known Giac/Xcas command names (see lib/xcasCommands.js) and the user's own defined
  // variables/functions whose name starts with `word`, matched case-insensitively (so typing
  // "fmax" matches "fMax") and sorted for display.
  function matchCompletions(word) {
    const names = new Set([...STATIC_COMPLETION_NAMES, ...state.definitions.keys()]);
    return [...names].filter((name) => name.length >= word.length && name.toLowerCase().startsWith(word.toLowerCase())).sort();
  }

  // Refreshes the completion dropdown as the user types (see onInputChanged), without
  // touching the input's text - unlike tryCompleteWord below, this never auto-fills anything,
  // since doing so under the user's still-moving cursor would fight with their typing. It just
  // keeps the candidate list (if any) in sync with the identifier currently under the caret, so
  // the dropdown appears on its own - useful on mobile, where Tab isn't easily reachable.
  // Arrow keys/Tab/Enter/click (see handleKeyDown/renderCompletions) then pick a candidate.
  function updateLiveCompletions() {
    const word = wordBeforeCursor();
    if (!word) return hideCompletions();
    const matches = matchCompletions(word);
    if (matches.length === 0 || (matches.length === 1 && matches[0] === word)) return hideCompletions();
    const pos = input.selectionStart;
    const start = pos - word.length;
    startCompletion(matches, start, pos);
  }

  // Completes the identifier before the caret the same way (see matchCompletions), but as an
  // explicit action: a single match completes (and fixes its case) immediately; several matches
  // fill in as far as they agree and open an interactive session (see startCompletion) for arrow
  // keys/Tab/click to pick among; no match leaves the input untouched so Tab falls back to its
  // history-insert behavior below. In practice updateLiveCompletions above has usually already
  // opened a session by the time Tab is pressed, so this mainly matters right after the caret
  // moves into a word without any typing (e.g. a mouse click) - the live update never fires then.
  function tryCompleteWord() {
    const word = wordBeforeCursor();
    if (!word) return false;
    const matches = matchCompletions(word);
    if (matches.length === 0) return false;
    const pos = input.selectionStart;
    const start = pos - word.length;

    if (matches.length === 1) {
      if (matches[0] === word) return false; // already typed in full, with the right case
      input.value = input.value.slice(0, start) + matches[0] + input.value.slice(pos);
      const newPos = start + matches[0].length;
      input.focus();
      input.setSelectionRange(newPos, newPos);
      onInputChanged();
      return true;
    }

    const prefix = longestCommonPrefix(matches);
    const filled = prefix.length > word.length ? prefix : word;
    input.value = input.value.slice(0, start) + filled + input.value.slice(pos);
    const newEnd = start + filled.length;
    input.focus();
    input.setSelectionRange(newEnd, newEnd);
    onInputChanged();
    startCompletion(matches, start, newEnd);
    return true;
  }

  // ---------- evaluation ----------

  async function submit({ force = false, approx = false } = {}) {
    const engineReady = state.status === 'ready';
    // An empty input on Enter/Ctrl+Enter repeats the last expression (in that key's mode -
    // exact or approx) rather than doing nothing, so re-running the previous computation
    // doesn't require retyping or reaching for history browsing. `displayInput` keeps
    // multiple lines (Shift+Enter for a new one - see handleKeyDown) as-typed, one equation
    // per line, for the history entry; `expr` is the single " and "-joined line actually
    // handed to the engine, e.g. solving "x+y=5" and "y-x=3" together.
    const displayInput = normalizeMultilineInput(input.value) || state.history[state.history.length - 1]?.input || '';
    const expr = normalizeDelCommand(joinInputLines(displayInput));
    if (!expr || !engineReady || state.busy) return;
    // Easter eggs: typing one of these literal words toggles/selects how pi-multiple results
    // are displayed - handled here, before any of them ever reaches the engine, since none is
    // real Giac syntax. "paumode" toggles pau (= 3/2*pi, see the "pau" constant above) on or
    // off, on top of whatever pi/tau choice is already in effect (see setPauMode/piToTau in
    // lib/giac.js - pau wins over tau whenever both are on). "pimode"/"taumode" instead pick a
    // side outright, the same explicit either/or choice as the settings menu's π/τ segmented
    // control (see handleTauModeChange below, which also always turns pau back off - a
    // deliberate "plain pi" or "tau" pick shouldn't keep being silently overridden by it).
    if (/^paumode$/i.test(expr.trim())) {
      state.pauMode = !state.pauMode;
      giacSetPauMode(state.pauMode);
      document.documentElement.classList.toggle('pau-mode', state.pauMode);
      if (state.pauMode) playBarrelRoll();
      finishModeCommandEntry(displayInput, expr, state.pauMode ? 'pau mode enabled' : 'pau mode disabled', state.pauMode ? 'https://xkcd.com/1292/' : null);
      return;
    }
    if (/^pimode$/i.test(expr.trim())) {
      handleTauModeChange(false);
      finishModeCommandEntry(displayInput, expr, 'pi mode enabled');
      return;
    }
    if (/^taumode$/i.test(expr.trim())) {
      handleTauModeChange(true);
      finishModeCommandEntry(displayInput, expr, 'tau mode enabled');
      return;
    }
    if (!force && looksIncomplete(expr)) {
      state.warning = 'This expression looks unfinished (dangling operator or unmatched parenthesis) - evaluating it can take a very long time. Press Enter to run it anyway.';
      renderWarning();
      return;
    }
    state.warning = null;
    renderWarning();
    state.busy = true;
    renderStatus();
    const result = approx ? await giacEvaluateApprox(expr, state.definitions) : await giacEvaluate(expr, state.definitions);
    state.busy = false;
    renderStatus();
    pushHistoryEntry({ input: displayInput, ...result });
    setDefinitions(applyEntryToDefinitions(state.definitions, expr, result));
    input.value = '';
    state.navPos = -1;
    updatePreview();
    updateSelection();
  }

  // Plays the barrel-roll animation (see the ".barrel-roll" keyframes in styles/index.css)
  // once on the body - triggered each time pau mode is switched *on* (see the "paumode"
  // easter egg above). The class is stripped first and its removal forced through with a
  // reflow read so re-triggering it (paumode off then on again) always restarts the
  // animation instead of a no-op re-add of a class that's already there; it's then removed
  // again once the animation ends so the class doesn't linger and block the next replay.
  function playBarrelRoll() {
    document.body.classList.remove('barrel-roll');
    void document.body.offsetWidth;
    document.body.classList.add('barrel-roll');
    document.body.addEventListener(
      'animationend',
      () => document.body.classList.remove('barrel-roll'),
      { once: true },
    );
  }

  // Shared tail of the "paumode"/"pimode"/"taumode" easter eggs above - pushes their
  // announcement as a history entry and resets the input box exactly like a normal submit(),
  // just without ever handing `expr` to the engine. isCommand marks it as not a real
  // evaluation, so saveableForEntry (lib/saveable.js) doesn't offer to save `expr` itself
  // (e.g. the bare word "paumode") as if it were a computed value.
  function finishModeCommandEntry(displayInput, expr, text, link = null) {
    pushHistoryEntry({ input: displayInput, raw: expr, isError: false, text, link, latex: null, isGraphics: false, isCommand: true });
    input.value = '';
    state.navPos = -1;
    updatePreview();
    updateSelection();
  }

  // Returns the "a" / "f(x)" / "a, b" label a just-run "name:=value" (or multi-variable
  // "a,b:=1,2") assignment statement defines, for display on the source entry's save button
  // (see setSavedLabel below) - or null if `saveExpr` isn't a definition after all (shouldn't
  // happen given how saveExpr is always built, but guards against surprises rather than
  // asserting).
  function labelForSaveExpr(saveExpr) {
    const def = parseDefinition(saveExpr);
    if (def) return definitionLabel(def);
    const multiDefs = parseMultiDefinition(saveExpr);
    if (multiDefs) return multiDefs.map((d) => d.name).join(', ');
    return null;
  }

  // Runs a "name:=value" (or "f(x):=value") assignment statement exactly like submit() would
  // if the user had typed and pressed Enter on it, and folds the resulting definitions in -
  // but without touching the CAS input box at all (unlike submit(), which always reads/clears
  // `input.value`), since the user didn't type this into it. Unlike submit(), a successful
  // save doesn't get its own history entry either - it's not something the user typed, so
  // cluttering the notebook with "a:=5" would just be noise; instead the entry the value came
  // from (`sourceIndex`, when known) has its own "save" button relabelled "saved to a" (see
  // setSavedLabel/historyEntry.js) so the outcome is still visible right where it happened. A
  // failed save (e.g. an invalid name) still gets a history entry, same as before, so the
  // error is visible somewhere. Called either with an entry's own ready-made saveExpr (the
  // "quick save" path - see handleSaveEntry) or with what the save menu just built from a
  // typed name (see saveMenu.js's onSubmit above).
  async function saveEntryVariables(saveExpr, sourceIndex) {
    if (!saveExpr || state.status !== 'ready' || state.busy) return;
    state.busy = true;
    renderStatus();
    const result = await giacEvaluate(saveExpr, state.definitions);
    state.busy = false;
    renderStatus();
    if (result.isError) {
      pushHistoryEntry({ input: saveExpr, ...result });
    } else {
      const label = labelForSaveExpr(saveExpr);
      if (label && sourceIndex != null && state.history[sourceIndex]) {
        state.history[sourceIndex].savedAs = label;
        entryViews[sourceIndex]?.setSavedLabel(label);
      }
    }
    setDefinitions(applyEntryToDefinitions(state.definitions, saveExpr, result));
    state.navPos = -1;
    updateSelection();
  }

  // Entry point for the entry's own "save" button (or the "s" shortcut) - see
  // pushHistoryEntry/deleteEntry's own HistoryEntry() calls and the "s" shortcut in
  // handleKeyDown below, same pairing as addExpressionToPlot/plottableInputForEntry/
  // plottableOutputForEntry for "plot".
  // `index` is that entry's position in state.history, threaded through to saveEntryVariables
  // so it knows which entry's save button to relabel once the name is known. `info` is
  // whatever saveableForEntry (lib/saveable.js) found: a solve()-style result already carries
  // an unambiguous name to save under, so that runs immediately, same as before the naming
  // menu existed; anything else has no name of its own, so this opens the menu instead and
  // lets saveMenu's onSubmit (above) call saveEntryVariables once one's typed.
  function handleSaveEntry(index, info) {
    if (!info) return;
    if (info.quickExpr) saveEntryVariables(info.quickExpr, index);
    else saveMenu.open({ ...info, index });
  }

  function setDefinitions(next) {
    if (next === state.definitions) return;
    state.definitions = next;
    plotPanelInstance?.setDefinitions(state.definitions);
    variablesMenu.update(state.definitions);
    bridgeHost?.notifyDefinitionsChanged();
  }

  // ---------- key handling ----------

  function handleKeyDown(e) {
    // A completion session can be open just because the user is typing (see
    // updateLiveCompletions) without them having asked to pick from it - so Up/Down always
    // stay history browsing's (below), never the dropdown's, and Left/Right only move
    // between candidates once Tab has actually engaged it (completionIndex >= 0; Tab always
    // moves it to 0 or beyond). Until then, or once Escape backs out again, Left/Right fall
    // through untouched to their usual job (moving the text cursor). Handled first, before
    // anything below (including the catch-all that would otherwise drop the list) sees these
    // keys.
    if (completionMatches.length > 0) {
      if (e.key === 'Tab') {
        e.preventDefault();
        selectCompletion(completionIndex + 1);
        return;
      }
      if (completionIndex >= 0 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        selectCompletion(completionIndex + (e.key === 'ArrowLeft' ? -1 : 1));
        return;
      }
      if (completionIndex >= 0 && e.key === 'Enter') {
        e.preventDefault();
        hideCompletions();
        return;
      }
      // Escape backs out of completion mode only - it dismisses the dropdown and hands
      // Up/Down and Left/Right straight back to their usual jobs (below) without also
      // touching navPos or any warning, so a second Escape is free to do its own usual thing.
      // The explicit focus() guards against focus having landed anywhere else (e.g. a tap on
      // a candidate on mobile) so the caret is always back in the input, ready to keep typing.
      if (e.key === 'Escape') {
        hideCompletions();
        input.focus();
        return;
      }
    }

    // Any key other than Tab means the user has moved on from the candidates Tab last
    // showed (typed further, submitted, browsed history, etc.) - drop the list so it never
    // lingers stale. The Tab branch below manages its own show/hide.
    if (e.key !== 'Tab') hideCompletions();

    if (e.key === 'Enter') {
      const step = currentStep();
      // With a step selected (via Up/Down below), Enter inserts it instead of submitting -
      // browsing never touched the input, so this is the only way its selection actually
      // reaches the input.
      if (step) {
        e.preventDefault();
        insertStepAtCursor(step);
        state.navPos = -1;
        updateSelection();
        return;
      }
      // Shift+Enter inserts a newline (the textarea's own default behavior, left
      // untouched) so a system of equations can be typed one per line - see joinInputLines,
      // which folds them into a single " and "-joined expression on submit. Plain Enter
      // always runs the expression as-is, skipping the completeness check below (see
      // submit's `force` param) so the everyday key never second-guesses what was typed.
      // Ctrl+Enter (or Cmd+Enter) evaluates numerically instead of exactly.
      if (e.shiftKey) return;
      // A bare command name (no parentheses/arguments yet - see openMenuForBareCommand)
      // opens its parameter menu instead of being submitted as-is, since evaluating it
      // without arguments would just error.
      if (openMenuForBareCommand(input.value)) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      submit({ force: true, approx: e.ctrlKey || e.metaKey });
      return;
    }

    // Up/Down only move which output/input is selected - they never touch the input's
    // text. Confirm with Enter or Tab to actually insert it.
    if (e.key === 'ArrowUp') {
      const s = steps();
      if (s.length === 0) return;
      e.preventDefault();
      state.navPos = state.navPos < 0 ? 0 : Math.min(s.length - 1, state.navPos + 1);
      updateSelection();
      return;
    }

    if (e.key === 'ArrowDown') {
      if (state.navPos < 0) return;
      e.preventDefault();
      state.navPos = state.navPos <= 0 ? -1 : state.navPos - 1;
      updateSelection();
      return;
    }

    if (e.key === 'Escape') {
      state.warning = null;
      renderWarning();
      state.navPos = -1;
      updateSelection();
      return;
    }

    // Left/Right scroll the selected input/output sideways instead of moving the
    // (otherwise empty, while browsing) input's text cursor.
    const step = currentStep();

    // "p" with an entry selected sends whichever half is currently selected - its input or
    // its output (see currentStep/setSelected) - straight to the plot panel instead of typing
    // "p" into the input, using whichever of plottableInputForEntry/plottableOutputForEntry
    // matches that half so e.g. a selected "y'=x-y" input plots the differential equation
    // itself while its selected output plots the solution curve instead (see lib/plottable.js).
    // Only intercepted when that check actually finds something (see there and the entry's own
    // always-visible "plot" buttons in historyEntry.js, which show under the same checks) -
    // otherwise "p" types normally, same as any other key while browsing (see onInputChanged,
    // which drops the selection the moment typing resumes).
    if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey && step) {
      const entry = state.history[step.idx];
      const plotSpec = step.part === 'input' ? plottableInputForEntry(entry) : plottableOutputForEntry(entry);
      if (plotSpec) {
        e.preventDefault();
        addExpressionToPlot(plotSpec);
        return;
      }
    }

    // "s" with an entry selected saves that entry's output - same idea as "p" above, but for
    // saveableForEntry/handleSaveEntry instead of plottableOutputForEntry/addExpressionToPlot
    // (see there, and the entry's own always-visible "save" button in historyEntry.js, which
    // shows under the same check).
    if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && step) {
      const saveInfo = saveableForEntry(state.history[step.idx]);
      if (saveInfo) {
        e.preventDefault();
        handleSaveEntry(step.idx, saveInfo);
        return;
      }
    }

    // "c" or Ctrl/Cmd+C with an entry selected copies whichever half is currently
    // highlighted (its input or output - see currentStep/setSelected) to the clipboard,
    // same as clicking that In[]/Out[] row would (see historyEntry.js's copy()). Unlike
    // "p"/"s" above, Ctrl/Cmd+C is intercepted too, not just the bare key - it's normally
    // the browser's own copy shortcut, but there's nothing selected in the (empty, while
    // browsing) expression input for it to act on anyway, so taking it over here doesn't
    // give anything up.
    if (e.key.toLowerCase() === 'c' && !e.altKey && step) {
      e.preventDefault();
      entryViews[step.idx].copy(step.part);
      return;
    }

    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && step) {
      const wrapper = document.getElementById(`entry-${step.idx}`);
      const row = wrapper?.querySelector(step.part === 'input' ? '.entry__input' : '.entry__output');
      if (row) {
        e.preventDefault();
        row.scrollBy({ left: e.key === 'ArrowLeft' ? -60 : 60 });
      }
      return;
    }

    // Backspace with a step selected deletes that whole entry instead of editing the
    // input field.
    if (e.key === 'Backspace' && step) {
      e.preventDefault();
      deleteEntry(step.idx);
      return;
    }

    if (e.key === 'Tab') {
      // Tab must never leave the input for the browser's default focus-change behavior,
      // regardless of which branch below actually handles it (or whether none does).
      e.preventDefault();
      // A step explicitly selected via Up/Down wins outright. Otherwise, try completing
      // the identifier under the caret first - only when that's a no-op (nothing typed, or
      // no name matches) does Tab fall back to inserting the last output, same as before.
      if (!step && tryCompleteWord()) return;
      const s = step ?? (state.history.length ? { idx: state.history.length - 1, part: 'output' } : null);
      if (!s) return;
      insertStepAtCursor(s);
      state.navPos = -1;
      updateSelection();
    }
  }
  input.addEventListener('keydown', handleKeyDown);
  input.addEventListener('blur', hideCompletions);

  // Alt+P/Alt+T toggle the plot and table panels from anywhere, including while the
  // expression input is focused. Esc also jumps back to the expression input from a
  // plot/table field - the input's own keydown handler already owns Esc for itself, so
  // this only fires when focus is actually inside one of the side panels.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'p') {
        e.preventDefault();
        (state.plotOpen ? closePlot : openPlot)();
        return;
      }
      if (key === 't') {
        e.preventDefault();
        (state.tableOpen ? closeTable : openTable)();
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        variablesMenu.toggle();
        return;
      }
    }
    if (e.key === 'Escape' && document.activeElement?.closest('.plot-panel, .table-panel')) {
      e.preventDefault();
      input.focus();
    }
  });

  // ---------- settings ----------

  function handleAngleModeChange(mode) {
    state.angleMode = mode;
    giacEvaluateRaw(mode === 'DEG' ? 'angle_radian(0)' : 'angle_radian(1)');
    renderStatus();
  }

  function handleApproxModeChange(on) {
    state.approxMode = on;
    giacEvaluateRaw(on ? 'approx_mode(1)' : 'approx_mode(0)');
    renderStatus();
  }

  function handleAutosimplifyChange(level) {
    state.autosimplify = level;
    giacSetAutosimplifyLevel(level);
    renderStatus();
  }

  // Like angleMode/approxMode/autosimplify above, this only affects evaluations from this
  // point forward - an existing history entry keeps showing whatever it already computed
  // (its text/latex are fixed strings from evaluate()-time, see piToTau in giac.js), the
  // same way switching RAD/DEG never retroactively reformats a past result either.
  function handleTauModeChange(on) {
    state.tauMode = on;
    giacSetTauMode(on);
    // Explicitly picking pi or tau is a deliberate choice of unit - pau mode (which
    // otherwise wins over tau mode, see piToTau in giac.js) shouldn't silently keep
    // overriding it from here on.
    if (state.pauMode) {
      state.pauMode = false;
      giacSetPauMode(false);
      document.documentElement.classList.remove('pau-mode');
    }
    try {
      localStorage.setItem('tauMode', on ? '1' : '0');
    } catch {
      // Ignore - the preference just won't persist across reloads in this environment.
    }
    renderStatus();
  }

  function handleThemeChange(next) {
    state.theme = next;
    document.documentElement.dataset.theme = state.theme;
    try {
      localStorage.setItem('theme', state.theme);
    } catch {
      // Ignore - theme just won't persist across reloads in this environment.
    }
    renderStatus();
  }

  function handleShowTextChange(next) {
    state.showText = next;
    try {
      localStorage.setItem('showText', next ? '1' : '0');
    } catch {
      // Ignore - the preference just won't persist across reloads in this environment.
    }
    for (const view of entryViews) view.setShowText(state.showText);
    renderStatus();
  }

  document.documentElement.dataset.theme = state.theme;

  // ---------- plot / table panels ----------

  function setMobileView(view) {
    state.mobileView = view;
    renderLayout();
  }

  function openPlot() {
    state.plotOpen = true;
    state.mobileView = 'plot';
    mountPlotPanel();
    renderLayout();
  }

  // Sends a history entry's plottable input or output (see lib/plottable.js) to the plot
  // panel - wired to both the entry's own two "plot" buttons (historyEntry.js) and the "p"
  // keyboard shortcut on whichever half is currently selected (handleKeyDown above). `spec` is
  // `{mode, expr}` - 'function' for an ordinary y=f(x) curve (from either a function-defining
  // input or a plain output, see plottableInputForEntry/plottableOutputForEntry), 'diffeq' for
  // a differential equation's vector field. Reuses the first still-blank row of that *same*
  // mode if there is one (the spare row a freshly opened/emptied panel always keeps ready to
  // type into - see focusOnMount in plotPanel.js) rather than always adding a new one, so
  // plotting right after opening the panel for the first time doesn't leave two rows where one
  // would do; a blank row of a *different* mode is left alone, since e.g. a blank function row
  // isn't a valid place to drop a differential equation's text.
  const PLOT_SPEC_FIELD = { function: 'expr', diffeq: 'exprDE' };
  function addExpressionToPlot({ mode, expr }) {
    const field = PLOT_SPEC_FIELD[mode];
    const blankIdx = state.plotRows.findIndex((r) => r.mode === mode && !r[field].trim());
    const nextRows =
      blankIdx !== -1
        ? state.plotRows.map((r, i) => (i === blankIdx ? { ...r, [field]: expr } : r))
        : [...state.plotRows, { ...makeRow(), mode, [field]: expr }];
    state.plotRows = nextRows;

    if (state.plotOpen) {
      plotPanelInstance?.setRows(nextRows);
      state.mobileView = 'calculator';
      renderLayout();
      input.focus();
    } else {
      openPlot();
      // mountPlotPanel() above schedules its own focus onto a fresh input row a tick from
      // now (see focusOnMount in plotPanel.js) - queuing this after it, rather than calling
      // it right here, is what lets it win and land focus back on the CAS input as intended.
      state.mobileView = 'calculator';
      renderLayout();
      setTimeout(() => input.focus(), 0);
    }
  }

  function closePlot() {
    state.plotOpen = false;
    if (state.mobileView === 'plot') state.mobileView = state.tableOpen ? 'table' : 'calculator';
    unmountPlotPanel();
    renderLayout();
    input.focus();
  }

  function openTable() {
    state.tableOpen = true;
    state.mobileView = 'table';
    mountTablePanel();
    renderLayout();
  }

  function closeTable() {
    state.tableOpen = false;
    if (state.mobileView === 'table') state.mobileView = state.plotOpen ? 'plot' : 'calculator';
    unmountTablePanel();
    renderLayout();
    input.focus();
  }

  function mountPlotPanel() {
    plotPanelInstance = PlotPanel({
      evaluateRaw: giacEvaluateRaw,
      rows: state.plotRows,
      view: state.plotView,
      onRowsChange: (rows) => {
        state.plotRows = rows;
      },
      onViewChange: (next) => {
        state.plotView = typeof next === 'function' ? next(state.plotView) : next;
        plotPanelInstance?.setView(state.plotView);
      },
      onPopOut: popOutPlot,
      onClose: closePlot,
    });
    plotPanelInstance.setDefinitions(state.definitions);
    clear(plotItem);
    plotItem.appendChild(plotPanelInstance.root);
  }

  function unmountPlotPanel() {
    plotPanelInstance?.destroy();
    plotPanelInstance = null;
    clear(plotItem);
  }

  function mountTablePanel() {
    tablePanelInstance = TablePanel({
      columns: state.tableColumns,
      onColumnsChange: (cols) => {
        state.tableColumns = cols;
      },
      onAssign: assignTableColumn,
      onPurge: purgeVariable,
      onClose: closeTable,
    });
    clear(tableItem);
    tableItem.appendChild(tablePanelInstance.root);
  }

  function unmountTablePanel() {
    tablePanelInstance?.destroy();
    tablePanelInstance = null;
    clear(tableItem);
  }

  // Pushes one table column's cells into the CAS session as a list variable - same
  // evaluate-and-fold-into-definitions path submit() uses for the main input line, so a
  // table column shows up everywhere a calculator-typed variable would.
  async function assignTableColumn(expr) {
    if (state.status !== 'ready') return { ok: false, message: 'Engine not ready.' };
    const out = await giacEvaluateRaw(expr);
    if (out.startsWith('GIAC_ERROR')) {
      return { ok: false, message: out.slice(11).trim() || 'Could not evaluate this column.' };
    }
    setDefinitions(applyEntryToDefinitions(state.definitions, expr, { isError: false }));
    return { ok: true, message: null };
  }

  // Purges a name straight from the engine (not through submit()'s text-input path) - used
  // by both the table panel's per-column remove button and the variables menu's per-row
  // delete button.
  function purgeVariable(name) {
    if (!name) return;
    giacEvaluateRaw(`purge(${name})`);
    setDefinitions(applyEntryToDefinitions(state.definitions, `purge(${name})`, { isError: false }));
  }

  // "Move" the embedded panel into its own window: the popup fetches the current rows/view
  // over the bridge (mode=move, see plotStandalone.js) instead of starting blank, and the
  // embedded copy closes and resets so the plot isn't left open in two places at once.
  function popOutPlot() {
    plotHandoff = { rows: state.plotRows, view: state.plotView };
    const url = `${window.location.origin}${window.location.pathname}?popout=plot&session=${sessionId}&mode=move`;
    window.open(url, `onlinecas-plot-${sessionId}-${Math.random().toString(36).slice(2)}`, 'width=1000,height=700');
    state.plotOpen = false;
    if (state.mobileView === 'plot') state.mobileView = state.tableOpen ? 'table' : 'calculator';
    unmountPlotPanel();
    state.plotRows = [makeRow()];
    state.plotView = DEFAULT_VIEW;
    renderLayout();
  }

  // ---------- boot ----------

  renderLayout();
  renderStatus();
  renderHistoryEmptyState();
  renderWarning();

  ensureGiacLoaded().then(
    () => {
      state.status = 'ready';
      renderStatus();
      renderHistoryEmptyState();
      // Push the current settings into the engine once it's up, so its own defaults
      // (radian, exact) can never silently diverge from what the UI shows.
      giacEvaluateRaw(state.angleMode === 'DEG' ? 'angle_radian(0)' : 'angle_radian(1)');
      giacEvaluateRaw(state.approxMode ? 'approx_mode(1)' : 'approx_mode(0)');
      giacSetAutosimplifyLevel(state.autosimplify);
      input.focus();

      // Answers eval requests from any window this session pops the plot panel out into
      // (see plotStandalone.js) so it can reuse this same Giac session's variables and
      // functions.
      bridgeHost = startBridgeHost({
        sessionId,
        evaluateRaw: giacEvaluateRaw,
        getDefinitions: () => state.definitions,
        getPlotState: () => plotHandoff ?? { rows: state.plotRows, view: state.plotView },
      });
    },
    (err) => {
      state.status = 'error';
      state.error = err.message || String(err);
      renderStatus();
      renderHistoryEmptyState();
    },
  );
}
