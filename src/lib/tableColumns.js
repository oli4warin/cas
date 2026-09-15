// Shared column model for the Table panel. Each column is named after a Giac variable -
// its cells (once non-empty and the name is a valid identifier) get pushed to the CAS
// session as `name:=[cell1,cell2,...]`, the same list literal you'd type by hand, so it's
// usable anywhere else (formulas, scatter plots) exactly like any other user variable.

export const DEFAULT_ROWS = 5;

let nextColId = 1;
export function makeColumn(name = '', rows = DEFAULT_ROWS) {
  return { id: nextColId++, name, cells: Array.from({ length: rows }, () => '') };
}

export function makeInitialColumns() {
  return [makeColumn(''), makeColumn('')];
}
