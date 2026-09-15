import { h, reconcileOrder } from '../lib/dom.js';
import { makeColumn } from '../lib/tableColumns.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN_DEBOUNCE_MS = 400;

// Lets the user type a small spreadsheet and turns each named column into a Giac list
// variable (see lib/tableColumns.js). Columns push to the CAS session on their own,
// debounced, the same way PlotPanel resamples on a timer - there's no explicit "submit".
export function TablePanel({ columns: initialColumns, onColumnsChange, onAssign, onPurge, onClose }) {
  let columns = initialColumns;
  const errors = {}; // colId -> message | null
  // Tracks which variable name is currently live in the engine for each column, so a
  // rename or a column becoming empty can purge the *old* name instead of leaving it
  // bound to stale data.
  const assigned = {};
  let assignTimer = null;
  let pendingFocus = null; // { colId, rowIdx }

  const colViews = new Map(); // colId -> { th, nameInput, errorSpan, removeBtn }
  const rowEls = []; // rowIdx -> { tr, rowHead, cells: Map(colId -> input), removeBtn }

  const headRowCorner = h('th', { class: 'table-panel__rowHead' });
  const headRow = h('tr', null, headRowCorner);
  const addColHead = h(
    'th',
    { class: 'table-panel__addColHead' },
    h('button', { type: 'button', class: 'table-panel__iconBtn', title: 'Add column', onclick: () => addColumn() }, '+'),
  );
  headRow.appendChild(addColHead);
  const thead = h('thead', null, headRow);
  const tbody = h('tbody');
  const grid = h('table', { class: 'table-panel__grid' }, thead, tbody);
  const gridWrap = h('div', { class: 'table-panel__gridWrap' }, grid);

  const closeBtn = h('button', { type: 'button', class: 'table-panel__iconBtn', title: 'Close table', onclick: () => onClose?.() }, '×');
  if (!onClose) closeBtn.style.display = 'none';
  const header = h(
    'div',
    { class: 'table-panel__header' },
    h('span', { class: 'table-panel__title' }, 'Table'),
    h('div', { class: 'table-panel__headerActions' }, closeBtn),
  );

  const addRowBtn = h('button', { type: 'button', class: 'table-panel__addRow', onclick: () => addRow() }, '+ Add row');
  const footer = h(
    'div',
    { class: 'table-panel__footer' },
    addRowBtn,
    h(
      'span',
      { class: 'table-panel__hint' },
      'Each named column becomes a list variable (e.g. ',
      h('code', null, 'name := [ … ]'),
      ') usable anywhere, including a scatter plot row. Arrow keys move between cells · Enter moves down (adds a row past the bottom) · Esc returns to the input.',
    ),
  );

  const root = h('div', { class: 'table-panel' }, header, gridWrap, footer);

  function rowCount() {
    return columns.reduce((max, c) => Math.max(max, c.cells.length), 1);
  }

  function emitColumns(next) {
    columns = next;
    onColumnsChange(columns);
    renderGrid();
    scheduleAssign();
  }

  function addColumn() {
    emitColumns([...columns, makeColumn('', columns[0]?.cells.length)]);
  }

  function removeColumn(id) {
    if (columns.length <= 1) return;
    const name = assigned[id];
    if (name) {
      onPurge(name);
      delete assigned[id];
    }
    delete errors[id];
    emitColumns(columns.filter((c) => c.id !== id));
  }

  function addRow() {
    emitColumns(columns.map((c) => ({ ...c, cells: [...c.cells, ''] })));
  }

  function removeRow(rowIdx) {
    emitColumns(columns.map((c) => ({ ...c, cells: c.cells.length > 1 ? c.cells.filter((_, i) => i !== rowIdx) : c.cells })));
  }

  function updateColumnName(id, name) {
    emitColumns(columns.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function updateCell(id, rowIdx, value) {
    emitColumns(columns.map((c) => (c.id === id ? { ...c, cells: c.cells.map((v, i) => (i === rowIdx ? value : v)) } : c)));
  }

  function focusCell(colId, rowIdx) {
    rowEls[rowIdx]?.cells.get(colId)?.focus();
  }
  function focusColName(colId) {
    colViews.get(colId)?.nameInput.focus();
  }

  const atStart = (e) => e.target.selectionStart === 0 && e.target.selectionEnd === 0;
  const atEnd = (e) => e.target.selectionStart === e.target.value.length && e.target.selectionEnd === e.target.value.length;

  function handleCellKeyDown(e, colId, rowIdx) {
    const colIdx = columns.findIndex((c) => c.id === colId);

    if (e.key === 'Enter') {
      e.preventDefault();
      const nextRowIdx = rowIdx + 1;
      if (nextRowIdx < rowCount()) {
        focusCell(colId, nextRowIdx);
      } else {
        pendingFocus = { colId, rowIdx: nextRowIdx };
        addRow();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rowIdx + 1 < rowCount()) focusCell(colId, rowIdx + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rowIdx === 0) focusColName(colId);
      else focusCell(colId, rowIdx - 1);
      return;
    }
    if (e.key === 'ArrowLeft' && atStart(e) && colIdx > 0) {
      e.preventDefault();
      focusCell(columns[colIdx - 1].id, rowIdx);
      return;
    }
    if (e.key === 'ArrowRight' && atEnd(e) && colIdx < columns.length - 1) {
      e.preventDefault();
      focusCell(columns[colIdx + 1].id, rowIdx);
    }
  }

  function handleColNameKeyDown(e, colId) {
    const colIdx = columns.findIndex((c) => c.id === colId);

    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      focusCell(colId, 0);
      return;
    }
    if (e.key === 'ArrowLeft' && atStart(e) && colIdx > 0) {
      e.preventDefault();
      focusColName(columns[colIdx - 1].id);
      return;
    }
    if (e.key === 'ArrowRight' && atEnd(e) && colIdx < columns.length - 1) {
      e.preventDefault();
      focusColName(columns[colIdx + 1].id);
    }
  }

  function createColView(col) {
    const nameInput = h('input', {
      class: 'table-panel__colName',
      type: 'text',
      placeholder: 'name',
      oninput: (e) => updateColumnName(col.id, e.target.value),
      onkeydown: (e) => handleColNameKeyDown(e, col.id),
    });
    const removeBtn = h(
      'button',
      { type: 'button', class: 'table-panel__removeCol', title: 'Remove column', onclick: () => removeColumn(col.id) },
      '×',
    );
    const errorSpan = h('span', { class: 'table-panel__colError' });
    errorSpan.style.display = 'none';
    const th = h(
      'th',
      { class: 'table-panel__colHead' },
      h('span', { class: 'table-panel__colHeadRow' }, nameInput, removeBtn),
      errorSpan,
    );
    return { th, nameInput, removeBtn, errorSpan };
  }

  function createCellInput(colId, rowIdx) {
    return h('input', {
      class: 'table-panel__cell',
      type: 'text',
      oninput: (e) => updateCell(colId, rowIdx, e.target.value),
      onkeydown: (e) => handleCellKeyDown(e, colId, rowIdx),
    });
  }

  function renderGrid() {
    const n = rowCount();

    // Reconcile column headers (order = columns array order).
    const seenCols = new Set();
    const desiredCols = [];
    columns.forEach((col) => {
      seenCols.add(col.id);
      let view = colViews.get(col.id);
      if (!view) {
        view = createColView(col);
        colViews.set(col.id, view);
      }
      if (view.nameInput.value !== col.name) view.nameInput.value = col.name;
      view.removeBtn.disabled = columns.length <= 1;
      const err = errors[col.id];
      if (err) {
        view.errorSpan.textContent = err;
        view.errorSpan.style.display = '';
      } else {
        view.errorSpan.style.display = 'none';
      }
      desiredCols.push(view.th);
    });
    for (const [id, view] of colViews) {
      if (!seenCols.has(id)) {
        view.th.remove();
        colViews.delete(id);
      }
    }
    const currentCols = Array.from(headRow.children).filter((el) => el !== headRowCorner && el !== addColHead);
    reconcileOrder(headRow, currentCols, desiredCols, addColHead);

    // Reconcile rows.
    while (rowEls.length < n) {
      const rowIdx = rowEls.length;
      const rowHead = h('td', { class: 'table-panel__rowHead' }, String(rowIdx + 1));
      const removeBtn = h(
        'button',
        { type: 'button', class: 'table-panel__removeRow', title: 'Remove row', onclick: () => removeRow(rowIdx) },
        '×',
      );
      const removeCell = h('td', { class: 'table-panel__rowRemoveCell' }, removeBtn);
      const tr = h('tr', null, rowHead);
      tbody.appendChild(tr);
      tr.appendChild(removeCell);
      rowEls.push({ tr, rowHead, removeCell, removeBtn, cells: new Map() });
    }
    while (rowEls.length > n) {
      rowEls.pop().tr.remove();
    }

    rowEls.forEach((rowEl, rowIdx) => {
      rowEl.rowHead.textContent = String(rowIdx + 1);
      rowEl.removeBtn.disabled = n <= 1;
      rowEl.removeBtn.onclick = () => removeRow(rowIdx);

      const seenColsForRow = new Set();
      const desiredCells = [];
      columns.forEach((col) => {
        seenColsForRow.add(col.id);
        let input = rowEl.cells.get(col.id);
        if (!input) {
          input = createCellInput(col.id, rowIdx);
          rowEl.cells.set(col.id, input);
        }
        input.oninput = (e) => updateCell(col.id, rowIdx, e.target.value);
        input.onkeydown = (e) => handleCellKeyDown(e, col.id, rowIdx);
        const value = col.cells[rowIdx] ?? '';
        if (input.value !== value) input.value = value;
        desiredCells.push(input.parentElement ?? h('td', null, input));
      });
      for (const [id, input] of rowEl.cells) {
        if (!seenColsForRow.has(id)) {
          input.parentElement?.remove();
          rowEl.cells.delete(id);
        }
      }
      const currentCells = Array.from(rowEl.tr.children).filter((el) => el !== rowEl.rowHead && el !== rowEl.removeCell);
      reconcileOrder(rowEl.tr, currentCells, desiredCells, rowEl.removeCell);
    });

    if (pendingFocus) {
      const { colId, rowIdx } = pendingFocus;
      pendingFocus = null;
      focusCell(colId, rowIdx);
    }
  }

  function scheduleAssign() {
    clearTimeout(assignTimer);
    assignTimer = setTimeout(() => {
      for (const col of columns) {
        const name = col.name.trim();
        const values = col.cells.map((v) => v.trim()).filter((v) => v !== '');
        const already = assigned[col.id];

        if (name && IDENT_RE.test(name) && values.length > 0) {
          if (already && already !== name) onPurge(already);
          onAssign(`${name}:=[${values.join(',')}]`).then(({ ok, message }) => {
            assigned[col.id] = ok ? name : null;
            errors[col.id] = ok ? null : message;
            renderGrid();
          });
        } else {
          if (already) {
            onPurge(already);
            assigned[col.id] = null;
          }
          errors[col.id] = !name ? null : !IDENT_RE.test(name) ? 'Column name must be a valid variable name.' : null;
        }
      }
      renderGrid();
    }, ASSIGN_DEBOUNCE_MS);
  }

  // Panel mounts fresh each time it's opened (see app.js): an unnamed first column means
  // the sheet is still blank, so start there; otherwise land in the most useful spot to
  // keep typing - the last entry of the last column that's actually wired up to a variable.
  function focusOnMount() {
    if (columns.length === 0) return;
    if (!columns[0].name.trim()) {
      focusColName(columns[0].id);
      return;
    }
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].name.trim()) {
        focusCell(columns[i].id, columns[i].cells.length - 1);
        break;
      }
    }
  }

  renderGrid();
  setTimeout(focusOnMount, 0);

  function destroy() {
    clearTimeout(assignTimer);
  }

  return { root, destroy };
}
