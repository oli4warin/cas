// Lets a variable that currently holds a list (e.g. "x:=list[sqrt(2),2]" - see the entry's own
// "save" button, lib/saveable.js) be indexed with a short subscript-looking name instead of
// having to write out Giac's own a(n) call syntax by hand: "x_1" or "x1" both mean "x(1)",
// Giac's 1-indexed function-call form for list access (as opposed to its 0-indexed bracket
// form, x[0]) - so a saved multi-solution result can be referred to afterward as simply
// "x_1"/"x1" for its first value, "x_2"/"x2" for its second, and so on, matching the "x_1"/
// "x_2" subscript labels solve() itself already uses when showing several solutions at once
// (see parseSolveSolutions in giac.js).
//
// Two functions share the same detection (see resolvableAlias below): expandListIndexAliases
// rewrites aliases into real a(n) calls for the copy of an expression actually sent to the
// engine (see giac.js), while displayListIndexAliases only normalizes a bare "x1" spelling
// into "x_1" - never touching the engine-bound text - so it renders with the same subscript
// giacToLatex.js already knows how to draw for an underscored identifier, with no changes
// needed there at all. Used for the live formula preview and each history entry's own input
// line (see app.js/components/historyEntry.js) - never for the *result* side, since by the
// time Giac evaluates an alias it's already a concrete value, not a symbolic a(n) call left
// over to relabel.

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

function isListBody(body) {
  const s = body.trim();
  return (s.startsWith('list[') && s.endsWith(']')) || (s.startsWith('[') && s.endsWith(']'));
}

// Splits a bare identifier into {base, index} if it's shaped like a list-index alias - the
// longest trailing run of digits, optionally preceded by "_", with at least one non-digit
// character of base left before it ("x1" -> {base:"x", index:"1"}, "x_12" -> {base:"x",
// index:"12"}) - or returns null if it doesn't end in a digit at all.
function splitAlias(name) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*?)_?([0-9]+)$/.exec(name);
  return m ? { base: m[1], index: m[2] } : null;
}

// Resolves `name` to a list-index alias only when its base is *currently* a plain variable
// definition whose own right-hand side looks like a list literal - never for a name that's
// itself already separately defined (so typing "x3:=99" of one's own makes "x3" mean exactly
// that from then on, not "x(3)" any more), and never for a function definition (calling a
// user-defined function with a numeric-looking name is a different thing entirely).
function resolvableAlias(name, definitions) {
  if (definitions.has(name)) return null;
  const alias = splitAlias(name);
  if (!alias) return null;
  const def = definitions.get(alias.base);
  if (!def || def.kind !== 'variable' || !isListBody(def.body)) return null;
  return alias;
}

function replaceIdentifiers(text, definitions, rewrite) {
  return text.replace(IDENT_RE, (name, offset, str) => {
    if (str[offset + name.length] === '(') return name; // a real call, e.g. "x3(y)" - never an alias
    // A name about to be *defined* ("x3:=5", "x3 := 5") is never an alias either, even if "x"
    // happens to be a list right now - it's the name of a brand-new variable the user is
    // creating, not a reference to an existing one, and treating it as one would silently
    // assign into the list instead of defining "x3" (definitions.has(name) above can't catch
    // this case: the name doesn't exist *yet*, that's exactly what this statement is about to
    // fix).
    let j = offset + name.length;
    while (str[j] === ' ' || str[j] === '\t') j++;
    if (str[j] === ':' && str[j + 1] === '=') return name;
    const alias = resolvableAlias(name, definitions);
    return alias ? rewrite(name, alias) : name;
  });
}

export function expandListIndexAliases(expr, definitions) {
  return replaceIdentifiers(expr, definitions, (_name, alias) => `${alias.base}(${alias.index})`);
}

export function displayListIndexAliases(text, definitions) {
  return replaceIdentifiers(text, definitions, (name, alias) => (name.includes('_') ? name : `${alias.base}_${alias.index}`));
}
