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
  setDigits as giacSetDigits,
} from './lib/giac.js';
import { giacToLatex } from './lib/giacToLatex.js';
import { typesetNode } from './lib/mathjax.js';
import { applyEntryToDefinitions, parseDefinition, parseMultiDefinition, definitionLabel, vectorNames } from './lib/definitions.js';
import { plottableInputForEntry, plottableOutputForEntry } from './lib/plottable.js';
import { plottable3dInputForEntry, plottable3dOutputForEntry } from './lib/plottable3d.js';
import { saveableForEntry } from './lib/saveable.js';
import { displayListIndexAliases } from './lib/listIndexAlias.js';
import { startBridgeHost } from './lib/plotBridge.js';
import { DEFAULT_VIEW, makeRow } from './lib/plotRows.js';
import { DEFAULT_VIEW_3D, makeRow3d } from './lib/plotRows3d.js';
import { makeInitialColumns, makeColumn } from './lib/tableColumns.js';
import {
  buildSessionSnapshot,
  reviveList,
  saveSnapshotToLocalStorage,
  loadSnapshotFromLocalStorage,
  clearSnapshotFromLocalStorage,
  parseSessionFileText,
  downloadSessionSnapshot,
} from './lib/sessionPersistence.js';
import { HistoryEntry } from './components/historyEntry.js';
import { PlotPanel } from './components/plotPanel.js';
import { Plot3DPanel } from './components/plot3dPanel.js';
import { TablePanel } from './components/tablePanel.js';
import { Credits } from './components/credits.js';
import { SettingsMenu } from './components/settingsMenu.js';
import { VariablesMenu } from './components/variablesMenu.js';
import { FunctionsMenu } from './components/functionsMenu.js';
import { DistributionMenu } from './components/distributionMenu.js';
import { SaveMenu } from './components/saveMenu.js';
import { SessionMenu } from './components/sessionMenu.js';
import { RegressionMenu } from './components/regressionMenu.js';
import { SysSolveMenu } from './components/sysSolveMenu.js';
import { XCAS_COMMANDS } from './lib/xcasCommands.js';
import { findDistributionMenu } from './lib/distributionParams.js';
import { isRegressionMenuCommand } from './lib/regressionParams.js';
import { isSysSolveMenuCommand } from './lib/sysSolveParams.js';
import { t, HTML_LANG } from './lib/i18n.js';

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

// How many significant digits an approximate numeric result is displayed with (see the
// "Digits" settings row and giac.js's setDigits) - a pure display preference, same as
// tauMode, so it's persisted the same way and defaults to 6 when unset or unparsable.
function getInitialDigits() {
  try {
    const stored = parseInt(localStorage.getItem('digits'), 10);
    if (Number.isInteger(stored) && stored >= 1 && stored <= 15) return stored;
  } catch {
    // localStorage can throw in locked-down environments - fall through to the default below.
  }
  return 6;
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
    // keys aren't reachable - mirrors what each physical key does: ←/→ move the cursor (see
    // moveCursor), ↑/↓ browse history same as the physical keys (see
    // browseHistoryUp/browseHistoryDown), ⌫/⏎ delete or insert a newline (see
    // backspaceAtCursor/insertNewline) - instead of inserting a math snippet. Sits below the
    // keypad, same 4-column grid: arrows fill one row, then backspace and new-line share the
    // row below, half the width each.
    items: [
      { label: '←', nav: 'left' },
      { label: '↑', nav: 'up' },
      { label: '↓', nav: 'down' },
      { label: '→', nav: 'right' },
      { label: '⌫', nav: 'backspace', span2: true },
      { label: '⏎', nav: 'newline', span2: true, title: t('New line - same as Shift+Enter') },
    ],
  },
];

const EXAMPLES = [
  'x^2-5*x+6=0',
  'x+y=5\ny-x=3',
	'x^2-2=0 | x>0',
	'int(x*sin(x),x,0,1)',
	'diff(x*sin(x),x)',
	'fMax(x-x^3,x) | x>0',
  "y'=y",
  'csolve(z^2+1=0,z)',
  'binomial_cdf',
  'regression',
];

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
    plot3dOpen: false,
    tableOpen: false,
    mobileView: 'calculator',
    plotRows: [makeRow()],
    plotView: DEFAULT_VIEW,
    plot3dRows: [makeRow3d()],
    plot3dView: DEFAULT_VIEW_3D,
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
    digits: getInitialDigits(),
  };
  // Purely a display preference (see piToTau in giac.js - it never changes what's actually
  // computed, only how a pi-valued result is shown), so unlike angleMode/approxMode/
  // autosimplify below it needs no "re-apply once the engine is ready" step - giac.js's own
  // module-level flag just needs to start out matching the persisted value.
  giacSetTauMode(state.tauMode);
  // Same story as tauMode above - digits only ever affects how a numeric result is rounded
  // for display (see roundForDisplay in giac.js), never the engine's own computation.
  giacSetDigits(state.digits);

  const sessionId = makeSessionId();
  // Snapshot of the rows/view being handed off to a popped-out window, taken at the
  // instant popOutPlot()/popOutPlot3d() fires - see the comment there for why this can't
  // just read the live plotRows/plotView (those get reset to blank in that same click
  // handler, and the popup's state request only arrives after that reset has already
  // landed). Two separate snapshots since the 2D and 3D panels can each be popped out
  // independently of the other.
  let plotHandoff = null;
  let plot3dHandoff = null;
  let bridgeHost = null;
  let plotPanelInstance = null;
  let plot3dPanelInstance = null;
  let tablePanelInstance = null;

  const entryViews = []; // parallel to state.history

  // ---------- session persistence ----------

  // True while restoreSession()/clearSessionState() are rebuilding history/panel state from
  // scratch - every individual step through there would otherwise trigger its own
  // schedulePersist() (pushHistoryEntry, the plot/table panels' onRowsChange/onViewChange/
  // onColumnsChange), which is both wasted work and, mid-restore, would overwrite the very
  // snapshot still being read with a half-rebuilt one. The caller re-enables it and persists
  // once, after the whole rebuild has landed.
  let suspendPersist = false;
  let persistTimer = null;

  // Debounced so a plot being dragged/zoomed (onViewChange fires continuously) doesn't hit
  // localStorage on every frame - see the plot/3D-plot/table panels' onRowsChange/onViewChange/
  // onColumnsChange callbacks below, and pushHistoryEntry/deleteEntry, which all call this.
  function schedulePersist() {
    if (suspendPersist) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      saveSnapshotToLocalStorage(buildSessionSnapshot(state));
    }, 400);
  }

  // Flushes a still-pending debounced save immediately - used right before an action that
  // itself replaces the session (load-from-file, clear) so the outgoing state is never lost
  // mid-debounce, and on page unload so the last few hundred milliseconds of edits aren't
  // dropped just because the tab closed before the timer fired.
  function flushPersist() {
    if (persistTimer == null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    saveSnapshotToLocalStorage(buildSessionSnapshot(state));
  }
  window.addEventListener('beforeunload', flushPersist);

  // ---------- static structure ----------

  const title = h('h1', null, t('Calculator'));
  // Header buttons that open/close the side panels. Their tooltips name the panel in full plus
  // its shortcut; the 3D one's own label is shortened to "3D" since it sits right between
  // "Plot" and "Table" in one joined group (see the header below).
  const panelBtn = (label, name, shortcut, onclick) =>
    h('button', { type: 'button', class: 'header__plotBtn', title: `${name} (${shortcut})`, onclick }, label);
  const plotBtn = panelBtn(t('Plot'), t('Plot'), 'Alt+P', () => (state.plotOpen ? closePlot() : openPlot()));
  const plot3dBtn = panelBtn('3D', t('3D Plot'), 'Alt+3', () => (state.plot3dOpen ? closePlot3d() : openPlot3d()));
  const tableBtn = panelBtn(t('Table'), t('Table'), 'Alt+T', () => (state.tableOpen ? closeTable() : openTable()));
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
    onDigitsChange: handleDigitsChange,
  });
  const variablesMenu = VariablesMenu({ onPurge: purgeVariable });
  const sessionMenu = SessionMenu({
    onSaveToFile: handleSaveSessionToFile,
    onLoadFile: handleLoadSessionFile,
    onPrint: printSession,
    onClear: handleClearSession,
  });
  const statusPill = h('span', { class: 'status-pill' });
  // Takes the status pill's place on the printed page (see the print stylesheet in app.css) -
  // stamped on 'beforeprint' so the browser's own print menu gets it too, not just printSession.
  const printDate = h('span', { class: 'print-date' });
  window.addEventListener('beforeprint', () => {
    printDate.textContent = new Date().toLocaleString(HTML_LANG, { dateStyle: 'medium', timeStyle: 'short' });
  });

  // Left: what this is and whether it's ready. Right: the controls, grouped by what they act
  // on - the side panels (one joined toggle group), the math helpers (function list,
  // variables), and the app itself (session incl. printing, settings).
  const header = h(
    'header',
    { class: 'header' },
    h('div', { class: 'header__brand' }, title, statusPill, printDate),
    h(
      'div',
      { class: 'header__actions' },
      h('div', { class: 'header__group header__group--joined' }, plotBtn, plot3dBtn, tableBtn),
      h('div', { class: 'header__group' }, functionsMenu.root, variablesMenu.root),
      h('div', { class: 'header__group' }, sessionMenu.root, settingsMenu.root),
    ),
  );

  const historyList = h('main', { class: 'history' });
  const emptyHint = h('div', { class: 'empty-hint' });
  const loadingHint = h(
    'div',
    { class: 'empty-hint' },
    h('div', { class: 'loading-bar' }, h('div', { class: 'loading-bar__fill' })),
    h('p', null, t('Downloading and starting the Xcas computer algebra engine…')),
    h('p', { class: 'empty-hint__small' }, t("First load pulls ~18MB of WebAssembly; it's cached by the browser afterwards.")),
  );
  const errorHint = h('div', { class: 'empty-hint empty-hint--error' });

  const previewSpan = h('span');
  const previewWrap = h('div', { class: 'formula-preview formula-preview--empty' }, previewSpan);
  let previewDebounce = null;

  const input = h('textarea', {
    class: 'input-row__field',
    rows: 1,
    placeholder: t('Waiting for engine…'),
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: false,
  });
  const submitBtn = h('button', { type: 'button', class: 'input-row__submit', onclick: () => submit({}) }, '=');
  const stopBtn = h('button', { type: 'button', class: 'input-row__submit input-row__submit--stop', onclick: () => cancelCurrentEval() }, t('Stop'));
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
              // up/down mirror the physical ArrowUp/ArrowDown keys (browse history - see
              // browseHistoryUp/browseHistoryDown) rather than moving the caret, same as
              // handleKeyDown's own plain-ArrowUp/ArrowDown branches; only left/right still
              // move the caret via moveCursor, since those have no history-browsing job to
              // do instead.
              else if (t.nav === 'up') browseHistoryUp();
              else if (t.nav === 'down') browseHistoryDown();
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
    h('span', null, t('↑ / ↓ select an output or input')),
    h('span', null, t('Enter/Tab insert selection at cursor')),
    h('span', null, t('Function names suggest as you type - Tab picks a candidate, then ←/→/Tab cycle, Enter or click confirms, Esc dismisses')),
    h('span', null, t('Enter evaluate (no selection)')),
    h('span', null, t('Shift+Enter new line - one equation per line solves as a system')),
    h('span', null, t('Ctrl+Enter evaluate numerically')),
    h('span', null, t('Enter on empty input repeats the last one')),
    h('span', null, t('Esc clear selection (or return to input from plot/table)')),
    h('span', null, t('Backspace on a selected entry deletes it')),
    h('span', null, t('p on a selected input/output sends it to the plot panel, if plottable')),
    h('span', null, t('s on a selected input/output saves it, if saveable')),
    h('span', null, t('Alt+P plot · Alt+T table')),
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

  // Only ever filled for the duration of a print - see printSession.
  const printExtras = h('div', { class: 'print-extras' });

  const appColumn = h(
    'div',
    { class: 'app' },
    header,
    historyList,
    printExtras,
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
    toolbarToggle.textContent = visible ? t('Hide math keyboard ▲') : t('Show math keyboard ▼');
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
    hintsToggle.textContent = visible ? t('Hide keyboard hints ▲') : t('Show keyboard hints ▼');
    try {
      localStorage.setItem('hintsVisible', visible ? '1' : '0');
    } catch {
      // ignore - see getInitialShowText for why storage can throw.
    }
  }
  setToolbarVisible(state.toolbarVisible);
  setHintsVisible(state.hintsVisible);

  const calcColumn = h('div', { class: 'layout__calc' }, appColumn);

  const tabCalc = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('calculator') }, t('Calculator'));
  const tabPlot = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('plot') }, t('Plot'));
  const tabPlot3d = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('plot3d') }, t('3D Plot'));
  const tabTable = h('button', { type: 'button', class: 'layout__tab', onclick: () => setMobileView('table') }, t('Table'));
  const tabsBar = h('div', { class: 'layout__tabs' }, tabCalc, tabPlot, tabPlot3d, tabTable);
  tabsBar.style.display = 'none';

  const plotItem = h('div', { class: 'layout__plotItem' });
  const plot3dItem = h('div', { class: 'layout__plot3dItem' });
  const tableItem = h('div', { class: 'layout__tableItem' });
  const sideColumn = h('div', { class: 'layout__side' }, plotItem, plot3dItem, tableItem);
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
    const split = state.plotOpen || state.plot3dOpen || state.tableOpen;
    layout.className = `layout${split ? ' layout--split' : ''}`;
    layout.dataset.mobileView = state.mobileView;
    tabsBar.style.display = split ? '' : 'none';
    tabPlot.style.display = state.plotOpen ? '' : 'none';
    tabPlot3d.style.display = state.plot3dOpen ? '' : 'none';
    tabTable.style.display = state.tableOpen ? '' : 'none';
    tabCalc.classList.toggle('layout__tab--active', state.mobileView === 'calculator');
    tabPlot.classList.toggle('layout__tab--active', state.mobileView === 'plot');
    tabPlot3d.classList.toggle('layout__tab--active', state.mobileView === 'plot3d');
    tabTable.classList.toggle('layout__tab--active', state.mobileView === 'table');
    sideColumn.style.display = split ? '' : 'none';
    plotItem.style.display = state.plotOpen ? '' : 'none';
    plot3dItem.style.display = state.plot3dOpen ? '' : 'none';
    tableItem.style.display = state.tableOpen ? '' : 'none';

    plotBtn.classList.toggle('header__plotBtn--active', state.plotOpen);
    plot3dBtn.classList.toggle('header__plotBtn--active', state.plot3dOpen);
    tableBtn.classList.toggle('header__plotBtn--active', state.tableOpen);
    sessionMenu.setPrintDisabled(state.history.length === 0 && !split);
  }

  function renderStatus() {
    const engineReady = state.status === 'ready';
    statusPill.className = `status-pill status-pill--${state.busy ? 'busy' : state.status}`;
    statusPill.textContent =
      state.status === 'loading' ? t('Loading engine…') : state.status === 'ready' ? (state.busy ? t('Evaluating…') : t('Ready')) : state.status === 'error' ? t('Failed to load') : '';

    input.disabled = !engineReady;
    input.placeholder = state.status === 'ready' ? t('Enter an expression…') : t('Waiting for engine…');
    submitBtn.disabled = !engineReady;
    submitBtn.style.display = state.busy ? 'none' : '';
    stopBtn.style.display = state.busy ? '' : 'none';

    functionsMenu.setDisabled(!engineReady);
    sessionMenu.setDisabled(!engineReady || state.busy);
    settingsMenu.update({
      angleMode: state.angleMode,
      approx: state.approxMode,
      autosimplify: state.autosimplify,
      tauMode: state.tauMode,
      showText: state.showText,
      theme: state.theme,
      digits: state.digits,
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
      h('p', null, t('Type an expression and press Enter. Examples:')),
      h(
        'ul',
        null,
        EXAMPLES.map((expr) => h('li', { onclick: () => selectExample(expr) }, expr)),
      ),
      h('p', { class: 'empty-hint__small empty-hint__privacy' }, t('Everything runs locally in your browser - no data is uploaded.')),
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

  // The actual "move browsing selection up/down one step" logic behind the physical
  // ArrowUp/ArrowDown keys (see handleKeyDown) and the math keyboard's ↑/↓ nav buttons on
  // touchscreens (see TOOLBAR_GROUPS/renderToolbarGroup) - kept as one shared pair of
  // functions so both agree on exactly the same browsing behavior. Returns whether it
  // actually moved anything (false at either end of history, or with nothing to browse at
  // all), so callers can tell a real move from a no-op - handleKeyDown only preventDefaults
  // the key on an actual move, letting it fall through to its normal job (typing/scrolling)
  // otherwise.
  function browseHistoryUp() {
    const s = steps();
    if (s.length === 0) return false;
    state.navPos = state.navPos < 0 ? 0 : Math.min(s.length - 1, state.navPos + 1);
    updateSelection();
    return true;
  }
  function browseHistoryDown() {
    if (state.navPos < 0) return false;
    state.navPos = state.navPos <= 0 ? -1 : state.navPos - 1;
    updateSelection();
    return true;
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
      onPlot3d: (i, spec) => addExpressionToPlot3d(spec),
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
    schedulePersist();
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
        onPlot3d: (idx, spec) => addExpressionToPlot3d(spec),
        onSave: (idx, info) => handleSaveEntry(idx, info),
        definitions: state.definitions,
      });
      view.setShowText(state.showText);
      const wrapper = h('div', { id: `entry-${i}` }, view.root);
      historyList.appendChild(wrapper);
      entryViews.push(view);
    }
    // Select the entry now sitting where the deleted one's own predecessor was (still at the
    // same idx afterward - only entries *after* the deleted one shift down) - its output, or
    // input for an error entry with none (see buildHistorySteps' own convention) - rather than
    // deselecting entirely, so repeated Backspace keeps deleting entries one after another
    // without having to re-select each time. Nothing above (the oldest entry was the one just
    // deleted) falls back to deselected, same as before.
    const aboveIdx = idx - 1;
    state.navPos =
      aboveIdx >= 0
        ? steps().findIndex((s) => s.idx === aboveIdx && s.part === (state.history[aboveIdx].isError ? 'input' : 'output'))
        : -1;
    renderHistoryEmptyState();
    renderLayout();
    updateSelection();
    schedulePersist();
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

  // Moves the textarea's cursor left/right the way the physical arrow keys would - used by
  // the nav group's ←/→ buttons on the math keyboard (see TOOLBAR_GROUPS) for touchscreens
  // where those keys aren't reachable. Synthetic key events don't trigger a textarea's
  // native cursor movement, so this reimplements it: collapses a selection to its near edge,
  // or else steps by one character. (Up/down are handled separately, by
  // browseHistoryUp/browseHistoryDown - see renderToolbarGroup - since on this app's
  // single-line-until-Shift+Enter input, up/down's real job is browsing history, not moving
  // the caret; see handleKeyDown's own plain-ArrowUp/ArrowDown branches for the physical-key
  // equivalent.)
  function moveCursor(dir) {
    input.focus();
    const value = input.value;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const pos =
      dir === 'left' ? (start !== end ? start : Math.max(0, start - 1)) : start !== end ? end : Math.min(value.length, end + 1);
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
    const latex = giacToLatex(displayListIndexAliases(joinInputLines(input.value), state.definitions), vectorNames(state.definitions)) || '';
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(() => {
      if (latex) {
        previewWrap.className = 'formula-preview';
        previewSpan.textContent = '\\[' + latex + '\\]';
        typesetNode(previewSpan);
      } else {
        previewWrap.className = 'formula-preview formula-preview--empty';
        previewSpan.textContent = t('Formula preview');
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
      h('span', { class: 'completions-bar__count' }, t(completionMatches.length === 1 ? '{count} match:' : '{count} matches:', { count: completionMatches.length })),
    );
    completionMatches.forEach((name, idx) => {
      const item = h(
        'span',
        {
          class: `completions-bar__item${idx === completionIndex ? ' completions-bar__item--selected' : ''}`,
          title: t(XCAS_COMMANDS[name] || ''),
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
      finishModeCommandEntry(displayInput, expr, state.pauMode ? t('pau mode enabled') : t('pau mode disabled'), state.pauMode ? 'https://xkcd.com/1292/' : null);
      return;
    }
    if (/^pimode$/i.test(expr.trim())) {
      handleTauModeChange(false);
      finishModeCommandEntry(displayInput, expr, t('pi mode enabled'));
      return;
    }
    if (/^taumode$/i.test(expr.trim())) {
      handleTauModeChange(true);
      finishModeCommandEntry(displayInput, expr, t('tau mode enabled'));
      return;
    }
    if (!force && looksIncomplete(expr)) {
      state.warning = t('This expression looks unfinished (dangling operator or unmatched parenthesis) - evaluating it can take a very long time. Press Enter to run it anyway.');
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
    plot3dPanelInstance?.setDefinitions(state.definitions);
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
      if (!browseHistoryUp()) return;
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowDown') {
      if (!browseHistoryDown()) return;
      e.preventDefault();
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
    // 2D only - "3" just below is its exact 3D sibling (lib/plottable3d.js), so a selected half
    // that's 3D-plottable (a 2-variable surface, or a system mentioning z) needs "3" instead;
    // "p" no longer falls back to 3D itself, so the two keys always agree with the entry's own
    // "plot"/"3d" buttons in historyEntry.js (which show under these same checks) about which
    // key does what. Only intercepted when the check actually finds something - otherwise "p"
    // types normally, same as any other key while browsing (see onInputChanged, which drops the
    // selection the moment typing resumes). Drops the browsing selection itself (same
    // state.navPos = -1/updateSelection() as Escape above) before handing off to the plot
    // panel, so the entry that was just sent there doesn't stay highlighted behind it -
    // addExpressionToPlot already returns focus to this input on its own, this just also exits
    // selection mode to match.
    if (e.key.toLowerCase() === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey && step) {
      const entry = state.history[step.idx];
      const plotSpec =
        step.part === 'input' ? plottableInputForEntry(entry, state.definitions) : plottableOutputForEntry(entry);
      if (plotSpec) {
        e.preventDefault();
        state.navPos = -1;
        updateSelection();
        addExpressionToPlot(plotSpec);
        return;
      }
    }

    // "3" is "p"'s exact 3D sibling - same idea, same shared selection (see currentStep/
    // setSelected), but sending whichever of plottable3dInputForEntry/plottable3dOutputForEntry
    // matches to the 3D plot panel instead (see lib/plottable3d.js). Kept as its own key rather
    // than a fallback inside "p" above so a half that's plottable *both* ways (there currently
    // isn't one - see lib/plottable3d.js's own module comment - but this keeps "p"/"3" meaning
    // exactly "2D"/"3D" regardless) always lets you ask for either explicitly.
    if (e.key === '3' && !e.ctrlKey && !e.metaKey && !e.altKey && step) {
      const entry = state.history[step.idx];
      const plot3dSpec =
        step.part === 'input' ? plottable3dInputForEntry(entry, state.definitions) : plottable3dOutputForEntry(entry);
      if (plot3dSpec) {
        e.preventDefault();
        state.navPos = -1;
        updateSelection();
        addExpressionToPlot3d(plot3dSpec);
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

  // Alt+P/Alt+3/Alt+T toggle the plot, 3D plot and table panels from anywhere, including while
  // the expression input is focused. Esc also jumps back to the expression input from a
  // plot/table field - the input's own keydown handler already owns Esc for itself, so
  // this only fires when focus is actually inside one of the side panels (both plot panels
  // share the ".plot-panel" class - see components/plot3dPanel.js - so this one selector
  // already covers both).
  window.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'p') {
        e.preventDefault();
        (state.plotOpen ? closePlot : openPlot)();
        return;
      }
      if (key === '3') {
        e.preventDefault();
        (state.plot3dOpen ? closePlot3d : openPlot3d)();
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
    // The browser's own print would leave the plots/table out - see printSession.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      printSession();
      return;
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

  // Same "display-only, from this point forward" story as tauMode above - an existing history
  // entry keeps whatever text/latex it already computed at its own digit setting.
  function handleDigitsChange(digits) {
    state.digits = digits;
    giacSetDigits(digits);
    try {
      localStorage.setItem('digits', String(digits));
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

  // Which side-panel tab a mobile layout should fall back to once the one it's currently
  // showing gets closed (see closePlot/closePlot3d/closeTable below) - whichever of the
  // remaining open panels comes first in this fixed order, or 'calculator' once none are.
  function fallbackMobileView() {
    if (state.plotOpen) return 'plot';
    if (state.plot3dOpen) return 'plot3d';
    if (state.tableOpen) return 'table';
    return 'calculator';
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
  // normally a single `{mode, patch}` - 'function' for an ordinary y=f(x) curve (from either a
  // function-defining input or a plain output, see plottableInputForEntry/
  // plottableOutputForEntry), 'diffeq' for a differential equation's vector field,
  // 'distribution' for a `_cdf` command's own distribution with its queried region shaded (see
  // parseDistributionCdfCall), 'scatter' for a regression command's own (x,y) data - but
  // plottableInputForEntry hands back an *array* of two specs for a regression command (that
  // same scatter plus the fitted curve as a 'function' row), so this also accepts an array and
  // applies each in turn. Each spec reuses the first still-blank row of that *same* mode if
  // there is one (the spare row a freshly opened/emptied panel always keeps ready to type into
  // - see focusOnMount in plotPanel.js) rather than always adding a new one, so plotting right
  // after opening the panel for the first time doesn't leave two rows where one would do; a
  // blank row of a *different* mode is left alone, since e.g. a blank function row isn't a
  // valid place to drop a differential equation's text. 'distribution' never reuses a blank
  // row - unlike a single text field, "blank" isn't well-defined for a family+params row, so a
  // fresh one is always appended. If no same-mode blank row exists, a still-pristine default
  // row (fresh from makeRow(), i.e. mode 'function' with nothing typed in) is repurposed
  // instead of appending - this is what a freshly opened/emptied panel always has exactly one
  // of, so the very first system/complexSystem/diffeq/distribution/scatter plot converts it in
  // place rather than leaving it behind as a stray empty entry ahead of the real one.
  const PLOT_SPEC_BLANK = {
    function: (r) => !r.expr.trim(),
    diffeq: (r) => !r.exprDE.trim(),
    distribution: () => false,
    integral: (r) => !r.expr.trim(),
    scatter: (r) => !r.exprX.trim() && !r.exprY.trim(),
    system: (r) => !r.exprSystem.trim(),
    complexSystem: (r) => !r.exprComplexSystem.trim(),
  };
  function applyPlotSpec(rows, { mode, patch }) {
    const isBlank = PLOT_SPEC_BLANK[mode];
    const sameModeIdx = rows.findIndex((r) => r.mode === mode && isBlank(r));
    if (sameModeIdx !== -1) {
      return rows.map((r, i) => (i === sameModeIdx ? { ...r, ...patch } : r));
    }
    const pristineIdx =
      mode !== 'function' ? rows.findIndex((r) => r.mode === 'function' && PLOT_SPEC_BLANK.function(r)) : -1;
    if (pristineIdx !== -1) {
      return rows.map((r, i) => (i === pristineIdx ? { ...r, ...patch, mode } : r));
    }
    return [...rows, { ...makeRow(), mode, ...patch }];
  }
  function addExpressionToPlot(spec) {
    const specs = Array.isArray(spec) ? spec : [spec];
    const nextRows = specs.reduce(applyPlotSpec, state.plotRows);
    state.plotRows = nextRows;

    if (state.plotOpen) {
      plotPanelInstance?.setRows(nextRows);
      // 'plot' rather than 'calculator': on a narrow/mobile layout the two are mutually
      // exclusive (see the [data-mobile-view] rules in app.css), so leaving this on
      // 'calculator' hid the very plot just added, forcing the tab to be tapped again by
      // hand. On a wide/desktop layout this has no visible effect either way - the side
      // column is always shown there regardless of mobileView - and input.focus() just below
      // still lands on the CAS input as before (on mobile the input's own column is now the
      // hidden one, so a focus call on it is a no-op there rather than popping the keyboard
      // up over the plot).
      state.mobileView = 'plot';
      renderLayout();
      input.focus();
    } else {
      openPlot();
      // mountPlotPanel() above schedules its own focus onto a fresh input row a tick from
      // now (see focusOnMount in plotPanel.js) - queuing this after it, rather than calling
      // it right here, is what lets it win and land focus back on the CAS input as intended.
      // openPlot() above already put mobileView on 'plot' - left as-is here for the same
      // mobile-visibility reason as the branch above.
      renderLayout();
      setTimeout(() => input.focus(), 0);
    }
  }

  function closePlot() {
    state.plotOpen = false;
    if (state.mobileView === 'plot') state.mobileView = fallbackMobileView();
    unmountPlotPanel();
    renderLayout();
    input.focus();
  }

  function openPlot3d() {
    state.plot3dOpen = true;
    state.mobileView = 'plot3d';
    mountPlot3dPanel();
    renderLayout();
  }

  // Sends a history entry's plottable-in-3D input or output (see lib/plottable3d.js) to the 3D
  // plot panel - the 3D sibling of addExpressionToPlot above, wired the same way to the entry's
  // "3d" buttons (historyEntry.js) and the "3" keyboard shortcut (handleKeyDown above). Kept
  // as its own separate function/state (plot3dRows/plot3dOpen, its
  // own panel instance) rather than a mode of the 2D plot - the 3D panel is a wholly different
  // kind of view (Plotly-rendered surfaces/isosurfaces, no shared canvas/curve model with the 2D
  // panel's own rows - see components/plot3dPanel.js).
  const PLOT3D_SPEC_BLANK = {
    surface: (r) => !r.expr.trim(),
    parametric: (r) => !r.exprX.trim() && !r.exprY.trim() && !r.exprZ.trim(),
    system: (r) => !r.exprSystem.trim(),
  };
  function applyPlot3dSpec(rows, { mode, patch }) {
    const isBlank = PLOT3D_SPEC_BLANK[mode];
    const sameModeIdx = rows.findIndex((r) => r.mode === mode && isBlank(r));
    if (sameModeIdx !== -1) {
      return rows.map((r, i) => (i === sameModeIdx ? { ...r, ...patch } : r));
    }
    const pristineIdx = mode !== 'surface' ? rows.findIndex((r) => r.mode === 'surface' && PLOT3D_SPEC_BLANK.surface(r)) : -1;
    if (pristineIdx !== -1) {
      return rows.map((r, i) => (i === pristineIdx ? { ...r, ...patch, mode } : r));
    }
    return [...rows, { ...makeRow3d(), mode, ...patch }];
  }
  function addExpressionToPlot3d(spec) {
    const specs = Array.isArray(spec) ? spec : [spec];
    const nextRows = specs.reduce(applyPlot3dSpec, state.plot3dRows);
    state.plot3dRows = nextRows;

    if (state.plot3dOpen) {
      plot3dPanelInstance?.setRows(nextRows);
      state.mobileView = 'plot3d';
      renderLayout();
      input.focus();
    } else {
      openPlot3d();
      renderLayout();
      // Not a fixed setTimeout(0) like addExpressionToPlot's own equivalent above - the 3D
      // panel's own initial focus (see plot3dPanel.js's focusOnMount) only fires once its
      // Plotly library has finished loading, a genuine network fetch (~4.5MB) the very first
      // time any session opens this panel, easily well past any fixed delay; chaining on its
      // own `ready` promise instead means this always lands last no matter how long that
      // took, cached-and-instant or not.
      plot3dPanelInstance?.ready.then(() => input.focus());
    }
  }

  function closePlot3d() {
    state.plot3dOpen = false;
    if (state.mobileView === 'plot3d') state.mobileView = fallbackMobileView();
    unmountPlot3dPanel();
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
    if (state.mobileView === 'table') state.mobileView = fallbackMobileView();
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
        schedulePersist();
      },
      onViewChange: (next) => {
        state.plotView = typeof next === 'function' ? next(state.plotView) : next;
        plotPanelInstance?.setView(state.plotView);
        schedulePersist();
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

  function mountPlot3dPanel() {
    plot3dPanelInstance = Plot3DPanel({
      evaluateRaw: giacEvaluateRaw,
      rows: state.plot3dRows,
      view: state.plot3dView,
      onRowsChange: (rows) => {
        state.plot3dRows = rows;
        schedulePersist();
      },
      onViewChange: (next) => {
        state.plot3dView = typeof next === 'function' ? next(state.plot3dView) : next;
        plot3dPanelInstance?.setView(state.plot3dView);
        schedulePersist();
      },
      onPopOut: popOutPlot3d,
      onClose: closePlot3d,
    });
    plot3dPanelInstance.setDefinitions(state.definitions);
    clear(plot3dItem);
    plot3dItem.appendChild(plot3dPanelInstance.root);
  }

  function unmountPlot3dPanel() {
    plot3dPanelInstance?.destroy();
    plot3dPanelInstance = null;
    clear(plot3dItem);
  }

  function mountTablePanel() {
    tablePanelInstance = TablePanel({
      columns: state.tableColumns,
      evaluateRaw: giacEvaluateRaw,
      onColumnsChange: (cols) => {
        state.tableColumns = cols;
        schedulePersist();
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
    if (state.status !== 'ready') return { ok: false, message: t('Engine not ready.') };
    const out = await giacEvaluateRaw(expr);
    if (out.startsWith('GIAC_ERROR')) {
      return { ok: false, message: out.slice(11).trim() || t('Could not evaluate this column.') };
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

  // The exact 3D sibling of popOutPlot above - see there - popped into its own window
  // (?popout=plot3d, see plot3dStandalone.js) rather than reusing ?popout=plot's, since the
  // popup needs Plot3DPanel/DEFAULT_VIEW_3D/makeRow3d instead of PlotPanel's own 2D versions
  // (see lib/plotBridge.js's `kind` for how the bridge itself tells the two apart).
  function popOutPlot3d() {
    plot3dHandoff = { rows: state.plot3dRows, view: state.plot3dView };
    const url = `${window.location.origin}${window.location.pathname}?popout=plot3d&session=${sessionId}&mode=move`;
    window.open(url, `onlinecas-plot3d-${sessionId}-${Math.random().toString(36).slice(2)}`, 'width=1000,height=700');
    state.plot3dOpen = false;
    if (state.mobileView === 'plot3d') state.mobileView = fallbackMobileView();
    unmountPlot3dPanel();
    state.plot3dRows = [makeRow3d()];
    state.plot3dView = DEFAULT_VIEW_3D;
    renderLayout();
  }

  // ---------- printing ----------

  // The live side panels are hidden on paper (see the print stylesheet in app.css) - what
  // gets printed below the history instead is a static copy of each open one that actually
  // has something in it: the plots as images, the table as a plain HTML table. Built right
  // before the print dialog opens and thrown away again once it closes.
  async function printSession() {
    const figure = (caption, body) => h('figure', { class: 'print-extras__item' }, h('figcaption', null, caption), body);
    const image = async (src) => {
      const img = h('img', { class: 'print-extras__plot', src });
      await img.decode().catch(() => {});
      return img;
    };
    const items = [];
    const plotImage = plotPanelInstance?.getPrintImage();
    if (plotImage) items.push(figure(t('Plot'), await image(plotImage)));
    const plot3dImage = await plot3dPanelInstance?.getPrintImage().catch(() => null);
    if (plot3dImage) items.push(figure(t('3D Plot'), await image(plot3dImage)));
    const table = tablePanelInstance?.getPrintData();
    if (table) {
      items.push(
        figure(
          t('Table'),
          h(
            'table',
            { class: 'print-extras__table' },
            h('thead', null, h('tr', null, ...table.names.map((name) => h('th', null, name)))),
            h('tbody', null, ...table.rows.map((row) => h('tr', null, ...row.map((cell) => h('td', null, cell))))),
          ),
        ),
      );
    }
    clear(printExtras);
    printExtras.append(...items);
    window.addEventListener('afterprint', () => clear(printExtras), { once: true });
    window.print();
  }

  // ---------- session management ----------

  // Re-mounts whichever of the plot/3D-plot/table panels are currently open, so a session
  // load/clear (which replaces state.plotRows/plot3dRows/plotView/plot3dView/tableColumns out
  // from under an already-mounted panel) is picked up immediately instead of only showing up
  // the next time that panel is opened by hand. A full remount rather than reaching for each
  // panel's own setRows/setView (the table panel doesn't even have one - see mountTablePanel/
  // TablePanel, which only ever reports column edits *outward* via onColumnsChange) is
  // simplest here, and exactly what closing and reopening the panel would do anyway.
  function remountOpenPanels() {
    if (state.plotOpen) {
      unmountPlotPanel();
      mountPlotPanel();
    }
    if (state.plot3dOpen) {
      unmountPlot3dPanel();
      mountPlot3dPanel();
    }
    if (state.tableOpen) {
      unmountTablePanel();
      mountTablePanel();
    }
  }

  // Wipes every trace of the current session - history, every defined variable/function
  // (purged from the engine itself via purgeVariable's own `purge()` call, not just forgotten
  // here), and the plot/3D-plot/table panels' own rows/view/columns - back to exactly what a
  // brand-new page load starts with. Used by the "Clear session" button, and by
  // handleLoadSessionFile before replaying a loaded one, so neither ever leaves the previous
  // session's entries sitting above the new ones.
  function clearSessionState() {
    for (const name of state.definitions.keys()) giacEvaluateRaw(`purge(${name})`);
    for (let i = 0; i < entryViews.length; i++) document.getElementById(`entry-${i}`)?.remove();
    entryViews.length = 0;
    state.history = [];
    state.navPos = -1;
    state.plotRows = [makeRow()];
    state.plotView = DEFAULT_VIEW;
    state.plot3dRows = [makeRow3d()];
    state.plot3dView = DEFAULT_VIEW_3D;
    state.tableColumns = makeInitialColumns();
    setDefinitions(new Map());
    renderHistoryEmptyState();
    renderLayout();
    updateSelection();
  }

  // Replays one saved history entry: restores its already-computed display (text/latex/raw/
  // etc. - see lib/sessionPersistence.js's serializeEntry) straight into the notebook with no
  // recomputation, so it reads exactly as it did when saved regardless of whatever the
  // *current* digits/tau settings happen to be now - the same "an entry keeps whatever it
  // already computed" rule handleDigitsChange/handleTauModeChange already follow for a plain
  // reload. Since a defined variable/function only really lives inside the Giac engine's own
  // memory - which a page reload always restarts from scratch - this then separately re-runs
  // the entry's input through the engine purely to rebuild that binding: the freshly computed
  // result is thrown away entirely, and state.definitions is instead folded forward from the
  // *saved* entry (applyEntryToDefinitions only ever looks at `result.isError`, never at
  // text/latex, so the saved entry serves that job exactly as well as a fresh evaluate() result
  // would). An error entry or a mode-command easter egg (isCommand - see
  // finishModeCommandEntry) never touched the engine to begin with, so both are skipped
  // outright; pau/pi/tau mode themselves are deliberately never replayed at all (see
  // state.pauMode's own "never persisted, session-only" comment above) - only the entry's own
  // announcement text comes back, not whichever mode it was announcing.
  async function replayHistoryEntry(entry) {
    pushHistoryEntry(entry);
    if (entry.isError || entry.isCommand) return;
    const expr = normalizeDelCommand(joinInputLines(entry.input));
    if (!expr) return;
    try {
      await giacEvaluate(expr, state.definitions);
    } catch {
      // Best-effort: if replaying this one line fails (e.g. it depended on some transient
      // engine state that was never itself part of the saved session) the entry above still
      // displays correctly either way - only a *later* entry that actually needs whatever
      // variable it would have defined is affected.
    }
    setDefinitions(applyEntryToDefinitions(state.definitions, expr, entry));
  }

  // Rebuilds the whole session from a snapshot (see lib/sessionPersistence.js) - either the
  // one silently restored from localStorage at boot, or one just picked via "Load from
  // file…" (see handleLoadSessionFile, which clears the current session first). Suspends
  // schedulePersist() for the duration: every step here (pushHistoryEntry, the rows/columns
  // assignments below) would otherwise trigger its own debounced save, which is both wasted
  // work and, mid-restore, would overwrite the very snapshot still being read.
  async function restoreSession(snapshot) {
    suspendPersist = true;
    try {
      for (const entry of snapshot.history ?? []) {
        await replayHistoryEntry(entry);
      }
      state.plotRows = reviveList(snapshot.plotRows, makeRow) ?? state.plotRows;
      if (snapshot.plotView) state.plotView = snapshot.plotView;
      state.plot3dRows = reviveList(snapshot.plot3dRows, makeRow3d) ?? state.plot3dRows;
      if (snapshot.plot3dView) state.plot3dView = snapshot.plot3dView;
      state.tableColumns = reviveList(snapshot.tableColumns, () => makeColumn()) ?? state.tableColumns;
      remountOpenPanels();
    } finally {
      suspendPersist = false;
    }
  }

  function handleSaveSessionToFile() {
    downloadSessionSnapshot(buildSessionSnapshot(state));
  }

  async function handleLoadSessionFile(file) {
    let snapshot;
    try {
      snapshot = parseSessionFileText(await file.text());
    } catch (err) {
      window.alert(t("Couldn't load that session file: {message}", { message: err.message || err }));
      return;
    }
    if (!window.confirm(t('Loading this file replaces your current session. Continue?'))) return;
    flushPersist();
    clearSessionState();
    input.disabled = true;
    await restoreSession(snapshot);
    input.disabled = false;
    schedulePersist();
    input.focus();
  }

  function handleClearSession() {
    if (!window.confirm(t("Clear the current session? This can't be undone."))) return;
    clearSessionState();
    remountOpenPanels();
    clearSnapshotFromLocalStorage();
    if (persistTimer != null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    input.focus();
  }

  // ---------- boot ----------

  renderLayout();
  renderStatus();
  renderHistoryEmptyState();
  renderWarning();

  ensureGiacLoaded().then(
    async () => {
      state.status = 'ready';
      renderStatus();
      renderHistoryEmptyState();
      // Push the current settings into the engine once it's up, so its own defaults
      // (radian, exact) can never silently diverge from what the UI shows.
      giacEvaluateRaw(state.angleMode === 'DEG' ? 'angle_radian(0)' : 'angle_radian(1)');
      giacEvaluateRaw(state.approxMode ? 'approx_mode(1)' : 'approx_mode(0)');
      giacSetAutosimplifyLevel(state.autosimplify);

      // Silently restore whatever session (history + plot/3D-plot/table state) was last
      // autosaved to this browser (see schedulePersist above) - so reloading the page picks
      // up right where it left off instead of starting from a blank notebook every time.
      // Input stays disabled for the duration - restoring replays every entry's input back
      // through the engine to rebuild its variable bindings (see replayHistoryEntry), so
      // typing something and submitting mid-restore could interleave with that replay.
      const savedSnapshot = loadSnapshotFromLocalStorage();
      if (savedSnapshot) {
        input.disabled = true;
        await restoreSession(savedSnapshot);
        input.disabled = false;
      }

      input.focus();

      // Answers eval requests from any window this session pops the 2D or 3D plot panel out
      // into (see plotStandalone.js/plot3dStandalone.js) so it can reuse this same Giac
      // session's variables and functions.
      bridgeHost = startBridgeHost({
        sessionId,
        evaluateRaw: giacEvaluateRaw,
        getDefinitions: () => state.definitions,
        getPlotState: () => plotHandoff ?? { rows: state.plotRows, view: state.plotView },
        getPlot3dState: () => plot3dHandoff ?? { rows: state.plot3dRows, view: state.plot3dView },
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
