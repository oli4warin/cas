import { t } from './i18n.js';
// Jspreadsheet CE (+ its jSuites dependency) powers the Table panel's grid (see
// components/tablePanel.js) with Excel-like editing: multi-cell selection, copy/paste to and
// from a real spreadsheet, drag-to-fill, resizable/draggable columns, undo/redo, and a
// right-click menu for inserting/deleting rows and columns. Only the grid, though - "=A2+B3"
// formulas are evaluated by Giac instead of the library's own engine (see lib/tableFormulas.js). Like Plotly (see lib/plotly.js)
// it's a library most sessions never touch, so it's loaded on demand - the first time the
// Table panel is opened - via plain injected <script>/<link> tags (no bundler here to import
// it through) rather than paid for on every page load.
//
// jspreadsheet-ce's own bundle expects a global `jSuites` to already exist rather than
// bundling it (its dist/index.min.js does `require("jsuites")`, which is a no-op in a plain
// <script> context - see its own UMD wrapper), so jSuites' script/stylesheet must be injected
// first. Versions are pinned together since jspreadsheet-ce 5.0.4 depends on jsuites ^5.12.0,
// a different (older) major than jsuites' own latest release.
const JSUITES_VERSION = '5.13.5';
const JSPREADSHEET_VERSION = '5.0.4';
const JSUITES_JS = `https://cdn.jsdelivr.net/npm/jsuites@${JSUITES_VERSION}/dist/jsuites.min.js`;
const JSUITES_CSS = `https://cdn.jsdelivr.net/npm/jsuites@${JSUITES_VERSION}/dist/jsuites.min.css`;
const JSPREADSHEET_JS = `https://cdn.jsdelivr.net/npm/jspreadsheet-ce@${JSPREADSHEET_VERSION}/dist/index.min.js`;
const JSPREADSHEET_CSS = `https://cdn.jsdelivr.net/npm/jspreadsheet-ce@${JSPREADSHEET_VERSION}/dist/jspreadsheet.min.css`;
// Not a theme by itself: it's the stylesheet that makes the grid's colors read from CSS custom
// properties at all (--content_background, --border_color, ...), which styles/tablePanel.css
// then points at this app's own light/dark palette.
const JSPREADSHEET_THEMES_CSS = `https://cdn.jsdelivr.net/npm/jspreadsheet-ce@${JSPREADSHEET_VERSION}/dist/jspreadsheet.themes.min.css`;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(script);
  });
}

function loadStylesheet(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

let loadPromise = null;

export function loadJspreadsheet() {
  if (window.jspreadsheet) return Promise.resolve(window.jspreadsheet);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    loadStylesheet(JSUITES_CSS);
    loadStylesheet(JSPREADSHEET_CSS);
    loadStylesheet(JSPREADSHEET_THEMES_CSS);
    // jSuites has to actually finish loading before jspreadsheet's own script runs (see the
    // module comment above), so these await in sequence rather than via Promise.all.
    await loadScript(JSUITES_JS);
    await loadScript(JSPREADSHEET_JS);
    if (!window.jspreadsheet) throw new Error(t('Could not load the spreadsheet library.'));
    return window.jspreadsheet;
  })();
  loadPromise.catch(() => {
    loadPromise = null; // let a later call retry instead of replaying today's failure forever
  });
  return loadPromise;
}
