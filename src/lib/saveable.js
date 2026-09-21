// Decides whether a history entry's output can be offered for saving, and how - shared by the
// entry's own "save" button (see components/historyEntry.js) and the "s" keyboard shortcut on
// a selected output (see app.js), so both agree on exactly which entries offer this and what
// happens when it's triggered. Mirrors lib/plottable.js's role for the "plot" button/"p"
// shortcut.

import { parseDefinition } from './definitions.js';
import { reinsertableValue, hasTopLevelRelation } from './giac.js';

// Returns one of two shapes, or null when there's nothing plain enough here to save at all: an
// error, an unrendered graphics result, a mode-command easter egg (see isCommand/app.js's
// finishModeCommandEntry), an entry whose own input already named it (e.g. the user typed
// "a:=5" or "f(x):=5" themselves - saving that again would just redefine the same name to the
// same value), or a bare relation (e.g. an unsolved inequality) that has no single value to pin
// a name to.
//
// - { quickExpr } - the name is already unambiguous, so saving just runs `quickExpr` outright
//   (see saveEntryVariables/app.js) with no menu in the way, exactly like it did before the
//   naming menu existed. This is a solve()/csolve()/fsolve()/zeros()/czeros() result, which
//   carries its own ready-made assignment statement (see buildSaveAssignment in giac.js,
//   computed once from the same solved values/variable names the result's own display text is
//   built from) - "x=sqrt(2)" saves outright as "x:=sqrt(2)"; several solutions for one
//   variable ("x_1=sqrt(2)", "x_2=2") as "x:=list[sqrt(2),2]"; several variables (a system) as
//   "a,b:=1,2", Xcas's own comma-separated simultaneous-assignment form.
// - { defaultName, value } - anything else: a plain result with no name of its own to offer,
//   so saving opens the naming menu (see saveMenu.js) with `value` (the entry's own raw output)
//   ready to assign to whatever name the user types, `defaultName` empty since there's nothing
//   sensible to prefill it with.
export function saveableForEntry(entry) {
  if (!entry || entry.isError || entry.isGraphics || entry.isCommand) return null;
  if (parseDefinition(entry.input)) return null;

  if (entry.saveExpr) return { quickExpr: entry.saveExpr };

  const raw = entry.raw;
  if (!raw || hasTopLevelRelation(raw)) return null;
  return { defaultName: '', value: reinsertableValue(raw) };
}
