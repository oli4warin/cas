// Decides whether a history entry's output can be offered as a variable-saving assignment -
// shared by the entry's own "save" button (see components/historyEntry.js) and the "s"
// keyboard shortcut on a selected output (see app.js), so both agree on exactly which entries
// offer this. Mirrors lib/plottable.js's role for the "plot" button/"p" shortcut.

// A solve()/csolve()/fsolve()/zeros()/czeros() result carries its own ready-made assignment
// statement (see buildSaveAssignment in giac.js, computed once from the same solved
// values/variable names the result's own display text is built from) - "a=sqrt(2)" saves as
// "a:=sqrt(2)"; several solutions for one variable ("x_1=sqrt(2)", "x_2=2") save as
// "x:=list[sqrt(2),2]"; several variables (a system) save simultaneously via
// "a,b:=1,2"/"x,y:=list[...],list[...]". Absent (or null, for a result that isn't a plain
// value - an inequality solution, say) for anything else.
export function saveableExprForEntry(entry) {
  if (!entry || entry.isError) return null;
  return entry.saveExpr ?? null;
}
