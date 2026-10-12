// Alt+H hides/shows the equation rows of every open plot panel (2D and 3D) at once. The panels
// share one listener instead of each toggling its own rows, so they can't drift out of sync:
// if any panel still shows its rows, all get hidden; only when all are hidden do they show
// again. Works from anywhere in the window, a popped-out one included (see plotStandalone.js).
const panels = new Set();

function onKeydown(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 'h') return;
  e.preventDefault();
  const hide = [...panels].some((panel) => !panel.isHidden());
  for (const panel of panels) panel.setHidden(hide);
}

// panel: { isHidden(), setHidden(value) }. Returns the matching unregister function.
export function registerRowsHotkey(panel) {
  if (panels.size === 0) window.addEventListener('keydown', onKeydown);
  panels.add(panel);
  return () => {
    panels.delete(panel);
    if (panels.size === 0) window.removeEventListener('keydown', onKeydown);
  };
}
