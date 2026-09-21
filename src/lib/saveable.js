// Decides whether a history entry's output can be offered for saving - shared by the entry's
// own "save" button (see components/historyEntry.js) and the "s" keyboard shortcut on a
// selected output (see app.js), so both agree on exactly which entries offer this, and by the
// naming menu they both open (see components/saveMenu.js). Mirrors lib/plottable.js's role for
// the "plot" button/"p" shortcut.

import { parseDefinition } from './definitions.js';
import { reinsertableValue, hasTopLevelRelation } from './giac.js';

// Returns { defaultName, value } - `value` is the Giac expression the save menu will assign
// to whatever name the user types ("a" saves as "a:=value", "f(x)" as "f(x):=value" - see
// saveMenu.js), and `defaultName` is what the menu's name field starts prefilled with.
// Returns null when there's nothing plain enough here to save: an error, an unrendered
// graphics result, a mode-command easter egg (see isCommand/app.js's finishModeCommandEntry),
// an entry whose own input already named it (e.g. the user typed "a:=5" or "f(x):=5"
// themselves - saving that again would just redefine the same name to the same value), or a
// bare relation (e.g. an unsolved inequality) that has no single value to pin a name to.
//
// A solve()/csolve()/fsolve()/zeros()/czeros() result carries its own ready-made assignment
// statement (see buildSaveAssignment in giac.js, computed once from the same solved
// values/variable names the result's own display text is built from) - "a=sqrt(2)" offers
// default name "a" with value "sqrt(2)"; several solutions for one variable ("x_1=sqrt(2)",
// "x_2=2") offer default name "x" with value "list[sqrt(2),2]"; several variables (a system)
// offer default name "a,b" with value "1,2", saving simultaneously via Xcas's own
// comma-separated assignment form. Absent (or null, for a result that isn't a plain value - an
// inequality solution, say) for anything else, in which case this falls back to the entry's own
// raw output value with no default name.
export function saveableForEntry(entry) {
  if (!entry || entry.isError || entry.isGraphics || entry.isCommand) return null;
  if (parseDefinition(entry.input)) return null;

  if (entry.saveExpr) {
    const eq = entry.saveExpr.indexOf(':=');
    if (eq < 0) return null;
    return { defaultName: entry.saveExpr.slice(0, eq), value: entry.saveExpr.slice(eq + 2) };
  }

  const raw = entry.raw;
  if (!raw || hasTopLevelRelation(raw)) return null;
  return { defaultName: '', value: reinsertableValue(raw) };
}
