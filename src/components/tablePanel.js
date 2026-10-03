import { h, clear } from '../lib/dom.js';
import { makeColumn } from '../lib/tableColumns.js';
import { loadJspreadsheet } from '../lib/jspreadsheet.js';
import { reinsertableValue } from '../lib/giac.js';
import { t } from '../lib/i18n.js';
import { evaluateSheet, isFormula, columnLetter, cellLabel } from '../lib/tableFormulas.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN_DEBOUNCE_MS = 400;
const COLUMN_WIDTH = 120;

// The library's own interface texts this panel can actually bring up (its right-click menu and
// the confirmations behind it) - handed back to it translated, see mountGrid.
const GRID_TEXTS = [
  'Insert a new row before',
  'Insert a new row after',
  'Delete selected rows',
  'Insert a new column before',
  'Insert a new column after',
  'Delete selected columns',
  'Copy',
  'Paste',
  'Are you sure to delete the selected rows?',
  'Are you sure to delete the selected columns?',
  'No cells selected',
];

// Lets the user type a small spreadsheet and turns each named column into a Giac list
// variable (see lib/tableColumns.js). Columns push to the CAS session on their own, the same
// way PlotPanel resamples on a timer - there's no explicit "submit".
//
// The grid itself is Jspreadsheet CE (see lib/jspreadsheet.js), which brings the Excel-like
// editing - cell selection, copy/paste, drag-to-fill, undo, a right-click menu for inserting
// and deleting rows/columns. Two things are this panel's own on top of it:
//  - each column header holds a name input next to the column's letter (A, B, ...): the name
//    is the CAS variable, the letter is only for cell references;
//  - cells starting with "=" are formulas ("=A2+B3"), evaluated by Giac rather than by the
//    library (see lib/tableFormulas.js) - the library is told not to parse them, keeps the
//    formula text as the cell's data, and this panel writes the results into the cells.
export function TablePanel({ columns: initialColumns, evaluateRaw, onColumnsChange, onAssign, onPurge, onClose }) {
  let columns = initialColumns;
  let jss = null; // the Jspreadsheet library function, once loaded
  let sheet = null; // the worksheet instance
  let destroyed = false;
  let passTimer = null;
  let passGeneration = 0;
  // Last evaluated sheet, { raw, results } (both column-major) - lets a cell whose own text
  // hasn't changed keep showing its previous result while a new pass is still running,
  // instead of flashing its formula text every time the library re-renders it.
  let shown = null;
  // Variable names this panel has put into the engine, so a rename or a column becoming
  // empty can purge the *old* name instead of leaving it bound to stale data.
  const assignedNames = new Set();
  const columnErrors = new Map(); // column index -> message

  const closeBtn = h('button', { type: 'button', class: 'table-panel__iconBtn', title: t('Close table'), onclick: () => onClose?.() }, '×');
  if (!onClose) closeBtn.style.display = 'none';
  const header = h(
    'div',
    { class: 'table-panel__header' },
    h('span', { class: 'table-panel__title' }, t('Table')),
    h('div', { class: 'table-panel__headerActions' }, closeBtn),
  );

  // tabindex so the grid can hold DOM focus while a cell is merely selected (the library
  // tracks its selection on its own and focuses nothing) - see onselection below.
  const gridHost = h('div', { class: 'table-panel__grid', tabindex: '-1' });
  const gridWrap = h('div', { class: 'table-panel__gridWrap' }, h('span', { class: 'table-panel__loading' }, t('Loading table…')), gridHost);

  const status = h('div', { class: 'table-panel__status' });
  status.style.display = 'none';
  const footer = h(
    'div',
    { class: 'table-panel__footer' },
    h('button', { type: 'button', class: 'table-panel__addRow', onclick: () => sheet?.insertRow() }, t('+ Add row')),
    h('button', { type: 'button', class: 'table-panel__addRow', onclick: () => sheet?.insertColumn() }, t('+ Add column')),
    h(
      'span',
      { class: 'table-panel__hint' },
      t('Each named column becomes a list variable (e.g. '),
      h('code', null, 'name := [ … ]'),
      t(') usable anywhere, including a scatter plot row. Formulas start with = and can use cells and any CAS command: '),
      h('code', null, '=A2+B3'),
      ', ',
      h('code', null, '=sum(A1:A5)'),
      t('. Right-click for rows/columns · drag the corner of a selection to fill · Esc returns to the input.'),
    ),
    status,
  );

  const root = h('div', { class: 'table-panel' }, header, gridWrap, footer);

  const columnName = (x) => sheet.options.columns[x]?.title ?? '';
  const columnCount = () => sheet.options.columns.length;

  // ---------- model <-> grid ----------

  function initialData() {
    const rows = columns.reduce((max, c) => Math.max(max, c.cells.length), 1);
    return Array.from({ length: rows }, (_, r) => columns.map((c) => c.cells[r] ?? ''));
  }

  // Rebuilds `columns` (the shape the session persists - see lib/sessionPersistence.js) from
  // the grid, which is the source of truth once it exists: the library moves each column's
  // title along with its cells through every insert/delete/drag/undo, so names stay attached
  // to the right data without this panel tracking any of that itself.
  function readColumns() {
    const data = sheet.getData();
    columns = Array.from({ length: columnCount() }, (_, x) => ({
      ...(columns[x] ?? makeColumn()),
      name: columnName(x),
      cells: data.map((row) => String(row[x] ?? '')),
    }));
    onColumnsChange(columns);
  }

  const rawSheet = () => columns.map((c) => c.cells);

  // ---------- header name inputs ----------

  // The library hands text to a selected cell on *any* document keydown/paste while it has a
  // "current" worksheet, wherever DOM focus actually is - so focus moving to a field that
  // isn't the grid (a column name, the calculator's own input) has to take that away, or
  // typing there would land in the last-selected cell instead.
  function releaseGrid() {
    if (!sheet) return;
    if (sheet.edition) sheet.closeEditor(sheet.edition[0], true);
    sheet.resetSelection();
    if (jss.current === sheet) jss.current = null;
  }

  function selectCell(x, y) {
    document.activeElement?.blur?.();
    jss.current = sheet;
    sheet.updateSelectionFromCoords(x, y, x, y);
    gridHost.focus({ preventScroll: true });
  }

  const nameInputAt = (x) => sheet.headers[x]?.querySelector('.table-panel__colName');
  const xOfInput = (input) => Number(input.closest('td').getAttribute('data-x'));

  function createNameInput() {
    const atStart = (el) => el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = (el) => el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const stop = (e) => e.stopPropagation();
    const input = h('input', {
      class: 'table-panel__colName',
      type: 'text',
      placeholder: t('name'),
      // Kept from the library's own document-level handlers, which would otherwise treat a
      // click in here as "select/drag this column" and swap the context menu for its own.
      onmousedown: stop,
      ondblclick: stop,
      ontouchstart: stop,
      oncontextmenu: stop,
      onfocus: releaseGrid,
      oninput: (e) => {
        // Written straight into the library's column config rather than through its
        // setHeader(), which would re-render the header cell (dropping this very input) and
        // push an undo step per keystroke.
        sheet.options.columns[xOfInput(e.target)].title = e.target.value;
        readColumns();
        schedulePass(ASSIGN_DEBOUNCE_MS);
      },
      onkeydown: (e) => {
        const x = xOfInput(e.target);
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          // selectCell hands the keyboard back to the library, whose own document-level
          // keydown handler would otherwise act on this very keystroke too (and move on to
          // the second row).
          e.stopPropagation();
          selectCell(x, 0);
        } else if (e.key === 'ArrowLeft' && atStart(e.target) && x > 0) {
          e.preventDefault();
          nameInputAt(x - 1)?.focus();
        } else if (e.key === 'ArrowRight' && atEnd(e.target) && x < columnCount() - 1) {
          e.preventDefault();
          nameInputAt(x + 1)?.focus();
        }
      },
    });
    input.spellcheck = false;
    return input;
  }

  // Idempotent: (re)builds whatever header cells the library has just created or re-rendered
  // as plain text, and refreshes letters/names/error marks on the rest.
  function decorateHeaders() {
    sheet.headers.forEach((td, x) => {
      let input = td.querySelector('.table-panel__colName');
      if (!input) {
        clear(td);
        input = createNameInput();
        td.append(h('span', { class: 'table-panel__colLetter' }), input);
      }
      td.querySelector('.table-panel__colLetter').textContent = columnLetter(x);
      if (document.activeElement !== input && input.value !== columnName(x)) input.value = columnName(x);
      const error = columnErrors.get(x);
      input.classList.toggle('table-panel__colName--error', !!error);
      td.setAttribute('title', error ?? '');
    });
  }

  // ---------- formulas ----------

  // Writes formula results into the cells. Plain cells are left exactly as the library
  // rendered them; so is a cell that's currently open in the editor.
  function paintCells(results) {
    columns.forEach((col, x) => {
      col.cells.forEach((raw, y) => {
        const td = sheet.records[y]?.[x]?.element;
        if (!td || td.classList.contains('editor')) return;
        const formula = isFormula(raw);
        const result = formula ? results?.[x]?.[y] : null;
        td.classList.toggle('table-panel__cell--formula', formula);
        td.classList.toggle('table-panel__cell--error', !!result?.error);
        if (!formula) {
          td.removeAttribute('title');
        } else if (result) {
          td.textContent = result.error ? '#ERR' : result.value;
          td.setAttribute('title', result.error ? `${raw.trim()}\n${result.error}` : raw.trim());
        }
      });
    });
  }

  // Results from the last pass, for every cell whose text is still what that pass saw. A
  // dependency may have changed underneath it, in which case this is briefly stale - the pass
  // that's about to run repaints it either way.
  function carriedOverResults() {
    if (!shown) return null;
    return columns.map((col, x) => col.cells.map((raw, y) => (shown.raw[x]?.[y] === raw ? shown.results[x]?.[y] : null)));
  }

  // Every change to the grid ends up here.
  function sheetChanged() {
    if (destroyed) return;
    readColumns();
    decorateHeaders();
    paintCells(carriedOverResults());
    schedulePass(0);
  }

  function schedulePass(delay) {
    clearTimeout(passTimer);
    passTimer = setTimeout(runPass, delay);
  }

  async function runPass() {
    const generation = ++passGeneration;
    const stale = () => destroyed || generation !== passGeneration;
    const raw = rawSheet().map((cells) => [...cells]);
    const names = columns.map((c) => c.name.trim());
    // reinsertableValue: Giac answers "1/3" with "1/3=0.333..." (see lib/giac.js) - only the
    // exact half belongs in a cell that other formulas and the column's list will reuse.
    const results = await evaluateSheet(raw, async (expr) => reinsertableValue(await evaluateRaw(expr)), stale);
    if (!results || stale()) return;
    shown = { raw, results };
    paintCells(results);

    // Push each named column into the CAS session as a list of its (evaluated) cells.
    columnErrors.clear();
    const assignments = new Map(); // name -> { x, expr }
    names.forEach((name, x) => {
      if (!name) return;
      if (!IDENT_RE.test(name)) {
        columnErrors.set(x, t('Column name must be a valid variable name.'));
        return;
      }
      if (assignments.has(name)) {
        columnErrors.set(x, t('Column {column} is already named {name}.', { column: columnLetter(assignments.get(name).x), name }));
        return;
      }
      const failed = results[x].findIndex((cell) => cell.error);
      if (failed !== -1) {
        columnErrors.set(x, `${cellLabel(x, failed)}: ${results[x][failed].error}`);
        return;
      }
      const values = results[x].map((cell) => cell.value).filter((v) => v !== '');
      if (values.length > 0) assignments.set(name, { x, expr: `${name}:=[${values.join(',')}]` });
    });

    for (const name of assignedNames) {
      if (!assignments.has(name)) {
        onPurge(name);
        assignedNames.delete(name);
      }
    }
    await Promise.all(
      [...assignments].map(async ([name, { x, expr }]) => {
        const { ok, message } = await onAssign(expr);
        if (ok) assignedNames.add(name);
        else columnErrors.set(x, message);
      }),
    );
    if (stale()) return;
    renderErrors(results);
  }

  function renderErrors(results) {
    decorateHeaders();
    const lines = [...columnErrors].map(([x, message]) => `${columns[x]?.name.trim() || columnLetter(x)}: ${message}`);
    // Formula errors in columns that aren't named (so aren't reported above) still deserve a
    // line - the cell itself only has room for "#ERR".
    results.forEach((cells, x) => {
      if (columnErrors.has(x)) return;
      const y = cells.findIndex((cell) => cell.error);
      if (y !== -1) lines.push(`${cellLabel(x, y)}: ${cells[y].error}`);
    });
    status.textContent = lines.join(' · ');
    status.style.display = lines.length ? '' : 'none';
  }

  // ---------- grid ----------

  // Focus leaving the panel by keyboard (Esc back to the calculator input, Alt+P, a menu...)
  // has to release the grid the same way a column name gaining focus does - see releaseGrid.
  function handleDocumentFocusIn(e) {
    if (sheet && jss.current === sheet && !root.contains(e.target)) releaseGrid();
  }

  function mountGrid(lib) {
    jss = lib;
    gridWrap.querySelector('.table-panel__loading')?.remove();
    jss.setDictionary(Object.fromEntries(GRID_TEXTS.map((text) => [text, t(text)])));
    const data = initialData();
    [sheet] = jss(gridHost, {
      // Formulas are Giac's business (lib/tableFormulas.js), not the library's: with this off
      // it keeps "=A2+B3" as the cell's plain data - while still rewriting the references
      // when rows/columns are inserted, deleted or moved, and when a formula is drag-filled.
      parseFormulas: false,
      about: false,
      allowExport: false,
      worksheets: [
        {
          data,
          columns: columns.map((c) => ({ type: 'text', title: c.name, width: COLUMN_WIDTH })),
          minDimensions: [1, 1],
          defaultColWidth: COLUMN_WIDTH,
          defaultColAlign: 'left',
          allowRenameColumn: false,
          columnSorting: false,
          allowComments: false,
        },
      ],
      onafterchanges: sheetChanged,
      oninsertrow: sheetChanged,
      ondeleterow: sheetChanged,
      onmoverow: sheetChanged,
      oninsertcolumn: sheetChanged,
      ondeletecolumn: sheetChanged,
      onmovecolumn: sheetChanged,
      onundo: sheetChanged,
      onredo: sheetChanged,
      onselection: () => {
        // Gives the panel real DOM focus while a cell is selected, so the app-wide "Esc
        // returns to the expression input from inside a panel" shortcut (see app.js) sees it.
        if (!root.contains(document.activeElement)) gridHost.focus({ preventScroll: true });
      },
    });
    document.addEventListener('focusin', handleDocumentFocusIn);
    readColumns();
    decorateHeaders();
    schedulePass(0);
    focusOnMount();
  }

  // Panel mounts fresh each time it's opened (see app.js): an unnamed first column means
  // the sheet is still blank, so start there; otherwise land in the most useful spot to
  // keep typing - the last entry of the last column that's actually wired up to a variable.
  function focusOnMount() {
    if (!columns[0].name.trim()) {
      nameInputAt(0)?.focus();
      return;
    }
    for (let x = columns.length - 1; x >= 0; x--) {
      if (columns[x].name.trim()) {
        selectCell(x, columns[x].cells.length - 1);
        break;
      }
    }
  }

  loadJspreadsheet().then(
    (lib) => {
      if (!destroyed) mountGrid(lib);
    },
    (err) => {
      if (destroyed) return;
      clear(gridWrap);
      gridWrap.appendChild(h('span', { class: 'table-panel__loading table-panel__loading--error' }, err.message));
    },
  );

  function destroy() {
    destroyed = true;
    clearTimeout(passTimer);
    document.removeEventListener('focusin', handleDocumentFocusIn);
    if (!sheet) return;
    if (jss.current === sheet) jss.current = null;
    // Not its document-level event handlers too (the second argument): those are shared by
    // every grid the library ever makes, including the one the next mount creates.
    jss.destroy(gridHost, false);
    sheet = null;
  }

  // The table as it reads on screen, for the printed page (see app.js's printSession):
  // {names, rows} with formula cells replaced by their results and trailing empty rows
  // dropped - or null while there's nothing in it.
  function getPrintData() {
    const results = carriedOverResults();
    const cols = columns.map((col, x) =>
      col.cells.map((raw, y) => {
        if (!isFormula(raw)) return raw;
        const result = results?.[x]?.[y];
        return result ? (result.error ? '#ERR' : result.value) : raw;
      }),
    );
    const length = cols.reduce((max, cells) => Math.max(max, cells.findLastIndex((c) => String(c).trim()) + 1), 0);
    if (length === 0) return null;
    return {
      names: columns.map((c, x) => c.name.trim() || columnLetter(x)),
      rows: Array.from({ length }, (_, y) => cols.map((cells) => cells[y] ?? '')),
    };
  }

  return { root, destroy, getPrintData };
}
