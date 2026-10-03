import { t } from './i18n.js';
// Serializes the calculator's visible session (history notebook + plot/3D-plot/table panel
// state) to/from a plain JSON-safe snapshot - used for the browser-storage autosave and the
// "save to file"/"load from file" buttons in the session menu (see components/sessionMenu.js
// and mountApp's own restoreSession/persistSession in app.js).
//
// Deliberately doesn't touch state.definitions or the Giac engine itself: a defined variable
// only really lives inside the Giac WASM worker's own memory, which a page reload always
// restarts from scratch, and the app already reconstructs state.definitions as a side effect
// of replaying each history entry's input back through the engine (see restoreSession in
// app.js) rather than storing it separately - so there's nothing for this module to know about
// the engine at all, only the plain data.

const STORAGE_KEY = 'onlinecas-session-v1';
const SESSION_VERSION = 1;

// Every field a restored history entry actually needs - exactly what HistoryEntry.js,
// lib/plottable.js, lib/plottable3d.js and lib/saveable.js read off an entry (see their own
// `entry.*` accesses); anything else on the live objects (there isn't currently anything else)
// would just be dead weight in the saved file.
function serializeEntry({ input, isError, isGraphics, isCommand, text, latex, raw, link, saveExpr, savedAs }) {
  return {
    input,
    isError: !!isError,
    isGraphics: !!isGraphics,
    isCommand: !!isCommand,
    text: text ?? null,
    latex: latex ?? null,
    raw: raw ?? null,
    link: link ?? null,
    saveExpr: saveExpr ?? null,
    savedAs: savedAs ?? null,
  };
}

function stripId({ id, ...rest }) {
  return rest;
}

export function buildSessionSnapshot({ history, plotRows, plotView, plot3dRows, plot3dView, tableColumns }) {
  return {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    history: history.map(serializeEntry),
    plotRows: plotRows.map(stripId),
    plotView,
    plot3dRows: plot3dRows.map(stripId),
    plot3dView,
    tableColumns: tableColumns.map(stripId),
  };
}

function isValidSnapshot(obj) {
  return !!obj && typeof obj === 'object' && Array.isArray(obj.history);
}

// Rebuilds a saved rows/columns array against `makeFn` (makeRow/makeRow3d/makeColumn), the
// same "one incrementing id per instance" factories used everywhere else - a saved id could
// otherwise collide with one handed out later in this fresh page load. Spreading `makeFn()`
// first (rather than just overwriting `.id` afterward) also means a field added to the shape
// after a session was saved quietly falls back to that fresh row's own default instead of
// coming back `undefined`.
export function reviveList(saved, makeFn) {
  if (!Array.isArray(saved)) return null;
  return saved.map((item) => {
    const fresh = makeFn();
    return { ...fresh, ...item, id: fresh.id };
  });
}

export function saveSnapshotToLocalStorage(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // localStorage can throw in locked-down environments (private mode, disabled storage, or
    // simply full) - same fallback story as every other localStorage use in app.js: the
    // session just won't survive a reload here.
  }
}

export function loadSnapshotFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSnapshotFromLocalStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore - see saveSnapshotToLocalStorage above.
  }
}

// Parses a ".json" session file picked via the "load from file" button - thrown errors (bad
// JSON, or valid JSON that isn't shaped like a session) are left for the caller to catch and
// show as a warning, same as any other user-supplied file.
export function parseSessionFileText(text) {
  const parsed = JSON.parse(text);
  if (!isValidSnapshot(parsed)) throw new Error(t('That file doesn’t look like a saved session.'));
  return parsed;
}

// Triggers a browser download of the snapshot as a .json file - a plain <a download> click
// rather than window.open, so it never navigates the page or risks a popup blocker.
export function downloadSessionSnapshot(snapshot) {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = (snapshot.savedAt || new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
  const a = document.createElement('a');
  a.href = url;
  a.download = `calculator-session-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
