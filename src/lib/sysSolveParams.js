// Menu config for the "syssolve" command (see components/sysSolveMenu.js) - lets a system of
// equations be entered one per line plus a list of variables to solve for, with the exact
// Giac command chosen from a dropdown. Both take the same "<equations>,<vars>" argument shape
// (see wrapBareEquation in giac.js, which builds solve() calls the same way for a hand-typed
// system), so switching modes here just swaps which command name gets built. fsolve is left
// out here - unlike solve/csolve it can't take a bracketed multi-variable list for a real
// system (see SYSTEM_CAPABLE_COMMANDS in giac.js), so it doesn't fit this menu.
export const SOLVE_MODES = [
  { name: 'solve', label: 'Solve - real solutions' },
  { name: 'csolve', label: 'Solve - complex solutions' },
];

// True when `name` is the bare "syssolve" command (no arguments yet) - mirrors
// isRegressionMenuCommand/findDistributionMenu's bare-name check, opening SysSolveMenu
// instead of submitting a call that would just error without its equations/variables filled
// in ("syssolve" isn't itself a Giac command - it only exists to trigger this menu).
export function isSysSolveMenuCommand(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === 'syssolve';
}
