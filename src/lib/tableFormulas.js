import { t } from './i18n.js';
// Spreadsheet-style formulas for the Table panel (see components/tablePanel.js). A cell whose
// text starts with "=" is a formula: cell references like A2 or B3 (column letter + 1-based
// row number, exactly the labels the grid shows) and ranges like A1:A5 are swapped for the
// referenced cells' values, and whatever's left is handed to Giac - so "=A2+B3" works like in
// Excel, but "=sqrt(A2)/3" stays exact and "=sum(A1:A5)*k" can use any CAS command or variable.
//
// The cell references are resolved here, by plain text substitution, rather than by defining
// A2/B3/... as real Giac variables: they only mean anything inside the table and never leak
// into the CAS session (where only the *column* is a variable, under the name typed in its
// header - see lib/tableColumns.js).

// Uppercase only, unlike Excel: lowercase a2/b3 stay free to be ordinary CAS variables. The
// lookarounds keep this from firing inside a longer identifier (xA2, A2b), a decimal, or a
// function call that merely looks like a reference (F1(x)).
const REF_RE = /(?<![A-Za-z0-9_.])([A-Z]{1,3})([1-9][0-9]*)(?::([A-Z]{1,3})([1-9][0-9]*))?(?![A-Za-z0-9_(])/g;

export const isFormula = (raw) => typeof raw === 'string' && raw.trimStart().startsWith('=');

// 0 -> A, 25 -> Z, 26 -> AA, ... - the same letters Jspreadsheet uses for its own headers.
export function columnLetter(index) {
  let s = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}

function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const cellLabel = (col, row) => `${columnLetter(col)}${row + 1}`;

class CellError extends Error {}

// Runs `replacer` over every cell reference in a formula body, leaving "string literals" alone.
async function replaceRefs(body, replacer) {
  const parts = body.split(/("(?:[^"\\]|\\.)*")/);
  for (let i = 0; i < parts.length; i += 2) {
    const matches = [...parts[i].matchAll(REF_RE)];
    let out = '';
    let last = 0;
    for (const m of matches) {
      out += parts[i].slice(last, m.index) + (await replacer(m));
      last = m.index + m[0].length;
    }
    parts[i] = out + parts[i].slice(last);
  }
  return parts.join('');
}

// Evaluates a whole sheet. `columns` is column-major raw cell text (columns[c][r]); `evalRaw`
// is giac.js's evaluateRaw. Resolves to, per cell, { value, error }: `value` is the text to
// show and to put into the column's list variable ('' for an empty cell, the raw text for a
// plain cell, Giac's result for a formula), `error` a message when a formula couldn't be
// evaluated. `isStale`, if given, is polled between engine calls so a pass that's been
// superseded by a newer edit stops early (and resolves to null) instead of queueing up more
// work behind it.
export async function evaluateSheet(columns, evalRaw, isStale = () => false) {
  const results = columns.map((cells) => cells.map(() => null));
  const visiting = new Set();

  async function resolve(c, r) {
    if (results[c][r]) return results[c][r];
    const raw = (columns[c][r] ?? '').trim();
    if (!isFormula(raw)) return (results[c][r] = { value: raw, error: null });

    const key = `${c},${r}`;
    if (visiting.has(key)) throw new CellError(t('Circular reference.'));
    visiting.add(key);
    let result;
    try {
      const refValue = async (rc, rr, label) => {
        if (rc >= columns.length || rr >= columns[rc].length) throw new CellError(t('{cell} is outside the table.', { cell: label }));
        const ref = await resolve(rc, rr);
        if (ref.error) throw new CellError(rc === c && rr === r ? ref.error : `${label}: ${ref.error}`);
        return ref.value;
      };
      const expanded = await replaceRefs(raw.slice(1), async (m) => {
        const [text, col1, row1, col2, row2] = m;
        if (!col2) {
          // An empty cell counts as 0, like in any spreadsheet.
          const value = await refValue(columnIndex(col1), Number(row1) - 1, text);
          return `(${value === '' ? '0' : value})`;
        }
        // A range becomes a Giac list of its non-empty cells (column by column), ready for
        // sum(...), mean(...), max(...) and friends.
        const [c1, c2] = [columnIndex(col1), columnIndex(col2)].sort((a, b) => a - b);
        const [r1, r2] = [Number(row1) - 1, Number(row2) - 1].sort((a, b) => a - b);
        const values = [];
        for (let rc = c1; rc <= c2; rc++) {
          for (let rr = r1; rr <= r2; rr++) {
            const value = await refValue(rc, rr, cellLabel(rc, rr));
            if (value !== '') values.push(`(${value})`);
          }
        }
        return `[${values.join(',')}]`;
      });
      if (!expanded.trim()) throw new CellError(t('Empty formula.'));
      if (isStale()) throw new CellError('Cancelled.');
      const out = await evalRaw(expanded);
      if (typeof out !== 'string' || out.startsWith('GIAC_ERROR')) {
        throw new CellError((typeof out === 'string' && out.slice(11).trim()) || t('Could not evaluate this formula.'));
      }
      result = { value: out.trim(), error: null };
    } catch (e) {
      if (!(e instanceof CellError)) throw e;
      result = { value: '', error: e.message };
    } finally {
      visiting.delete(key);
    }
    return (results[c][r] = result);
  }

  for (let c = 0; c < columns.length; c++) {
    for (let r = 0; r < columns[c].length; r++) {
      await resolve(c, r);
      if (isStale()) return null;
    }
  }
  return results;
}
