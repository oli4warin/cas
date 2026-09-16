// Talks to the Giac/Xcas WASM engine running in public/giac-worker.js (see that file for
// why it's a worker: some malformed input can send Giac's parser into a very long
// synchronous computation, and isolating it means the page never freezes for it - a
// timeout here just terminates and respawns the worker to recover).

import { giacToLatex } from './giacToLatex.js';

const EVAL_TIMEOUT_MS = 15000;

// Resolved relative to this module's own file, so it works regardless of what path the
// app is served from (no bundler-injected BASE_URL here, unlike the React version).
const WORKER_URL = new URL('../../public/giac-worker.js', import.meta.url);

let worker = null;
let readyPromise = null;
let readyResolve = null;
let readyReject = null;
let nextId = 1;
// Requests currently in flight, keyed by id. The worker only ever runs one `caseval` at a
// time and replies strictly in the order requests were posted, so several callers can
// have a request pending at once (e.g. two plot rows resampling together, or a table
// pushing more than one column) - a map keyed by id resolves each caller's own promise,
// unlike a single "current" slot which would silently orphan every request but the last.
const pending = new Map(); // id -> { resolve, timer }

function spawnWorker() {
  const w = new Worker(WORKER_URL);
  worker = w;
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  w.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'ready') {
      readyResolve();
    } else if (data.type === 'load-error') {
      readyReject(new Error(data.message));
    } else if (data.type === 'result') {
      const entry = pending.get(data.id);
      if (entry && w === worker) {
        clearTimeout(entry.timer);
        pending.delete(data.id);
        entry.resolve(data.out);
      }
    }
  };
  w.onerror = (e) => {
    if (readyReject) readyReject(new Error(e.message || 'Failed to load the Xcas engine.'));
  };
}

export function ensureGiacLoaded() {
  if (!worker) spawnWorker();
  return readyPromise;
}

function restart() {
  if (worker) worker.terminate();
  spawnWorker();
}

// A single blocking `caseval` call hangs the worker for every request queued behind it,
// not just its own - the only way to recover is to terminate the worker, which drops all
// of them, so every pending request (not just the one that timed out) needs to settle.
function cancelAll(message) {
  if (pending.size === 0) return;
  const entries = Array.from(pending.values());
  pending.clear();
  restart();
  for (const { resolve, timer } of entries) {
    clearTimeout(timer);
    resolve('GIAC_ERROR ' + message);
  }
}

// Aborts whatever is currently being evaluated (if anything) and recovers the engine.
export function cancelCurrentEval() {
  cancelAll('Cancelled.');
}

function rawEvalAsync(expr) {
  return ensureGiacLoaded().then(
    () =>
      new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            cancelAll('This expression took too long to evaluate and was cancelled.');
          }
        }, EVAL_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        worker.postMessage({ type: 'eval', id, expr });
      }),
  );
}

const TRAILING_OPERATOR_RE = /[+\-*/^,.=<>]$/;

// A fast, local pre-check to avoid even sending obviously-unfinished input (dangling
// operator, unmatched parenthesis) to the engine - most such cases are the accidental
// early Enter that would otherwise cost a full timeout round-trip.
export function looksIncomplete(expr) {
  const s = expr.trim();
  if (!s) return false;
  if (TRAILING_OPERATOR_RE.test(s)) return true;
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth < 0) return true;
  }
  return depth > 0;
}

// Giac's default display auto-appends "=<decimal>" to any non-integer exact result, both
// rational (e.g. "1/2=0.5") and irrational (e.g. "sqrt(2)=1.4142135623731") - nice to read,
// but not something you want copied verbatim into a new expression. Strip that tail
// whenever it's present (see EXACT_DECIMAL_TAIL_RE below for why a genuine equation result
// like "x=5" from solve is left untouched: its right side never has a decimal point).
export function reinsertableValue(raw) {
  const m = raw.match(EXACT_DECIMAL_TAIL_RE);
  return m ? m[1] : raw;
}

function findMatchingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const UINT_RE = /\d+/y;

// Giac's own parser reads "cos^2(x)" (no explicit multiplication) as building a
// composed/powered *function object*, not as squaring the value cos(x). That happens to
// collapse back to a plain expression when it's the whole input (Out[5] above renders
// fine), but combine two of them - "cos^2(x)+sin^2(x)" - and Giac adds the two function
// objects into a new program instead of two numbers, and a variable-substitution bug in
// that path corrupts both the exponent and the bound variable's name in the result (and
// its latex()). Rewriting "f^n(args)" to "f(args)^n" before it ever reaches Giac sidesteps
// that path entirely and matches what every user typing "cos^2(x)" actually means.
// Exponent -1 is deliberately left alone (the regex only matches a bare digit run right
// after "^", never a leading "-") since "f^-1(x)" is standard inverse-function notation
// (e.g. sin^-1(x) = arcsin(x)) - genuine composition, not squaring.
export function normalizePowerCalls(expr) {
  let out = '';
  let i = 0;
  const n = expr.length;
  while (i < n) {
    if (/[A-Za-z_]/.test(expr[i])) {
      IDENT_RE.lastIndex = i;
      const ident = IDENT_RE.exec(expr)[0];
      let j = i + ident.length;
      if (expr[j] === '^') {
        UINT_RE.lastIndex = j + 1;
        const intMatch = UINT_RE.exec(expr);
        if (intMatch) {
          const exponent = intMatch[0];
          let k = j + 1 + exponent.length;
          while (k < n && /\s/.test(expr[k])) k++;
          if (expr[k] === '(') {
            const close = findMatchingParen(expr, k);
            if (close !== -1) {
              const inner = normalizePowerCalls(expr.slice(k + 1, close));
              out += `${ident}(${inner})^${exponent}`;
              i = close + 1;
              continue;
            }
          }
        }
      }
      out += ident;
      i = j;
      continue;
    }
    out += expr[i];
    i++;
  }
  return out;
}

// Giac itself has no "ncr" identifier (only "nCr", "comb" and "binomial" are real function
// names there) - typing the all-lowercase calculator-familiar spelling would otherwise reach
// the engine as an unknown identifier and fail to evaluate, even though the live preview (see
// giacToLatex.js, which recognizes the same spelling) happily renders it as \binom{n}{k}.
// Rewriting it to "comb" here, case-insensitively, before the expression ever reaches the
// engine keeps both spellings ("ncr" and the already-working "nCr") calculating identically.
const NCR_ALIAS_RE = /\bncr(?=\s*\()/gi;

export function normalizeNcrAlias(expr) {
  return expr.replace(NCR_ALIAS_RE, 'comb');
}

function findMatchingBracket(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Splits `s` on `sep` only where it isn't nested inside ()/[]/{}, e.g. splitting
// "f(1,2),3;4" on ";" gives ["f(1,2),3", "4"] rather than cutting inside the call.
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// Giac's own matrix literal syntax is nested brackets, "[[1,2],[3,4]]" - it doesn't
// understand the TI-Nspire shorthand "[1,2;3,4]" (semicolons as row separators) at all, so
// this expands that shorthand into Giac's own form before anything reaches the engine.
// Only semicolons that sit directly inside a "[...]" (not inside a further-nested call's
// parens, e.g. "[f(1,2),3;4,5]") count as row separators, and a bracket with no semicolon
// in it (an ordinary list/vector, or Giac's own "[[...],[...]]" form) is left untouched. A
// stray trailing ";" right before "]" (a row nspire itself tolerates) is dropped rather
// than turned into a bogus empty last row.
export function normalizeNspireMatrices(expr) {
  let out = '';
  let i = 0;
  const n = expr.length;
  while (i < n) {
    if (expr[i] === '[') {
      const close = findMatchingBracket(expr, i);
      if (close !== -1) {
        const inner = normalizeNspireMatrices(expr.slice(i + 1, close));
        const rows = splitTopLevel(inner, ';').filter((row, idx, arr) => row.trim() !== '' || idx !== arr.length - 1);
        out += rows.length > 1 ? `[${rows.map((row) => `[${row}]`).join(',')}]` : `[${inner}]`;
        i = close + 1;
        continue;
      }
    }
    out += expr[i];
    i++;
  }
  return out;
}

// True iff `s` has a "bare" `=` outside any (), [], {} nesting - i.e. one that means
// "equation", not `:=` (assignment), `==`/`!=`/`<=`/`>=` (comparison), or an `=` already
// sitting inside a call's arguments (e.g. `plot(x=1,...)`, or an equation already handed to
// `solve(...)` by the user themselves).
function hasTopLevelBareEquals(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '=' && depth === 0) {
      const prev = s[i - 1];
      const next = s[i + 1];
      if (prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && prev !== ':' && next !== '=') {
        return true;
      }
    }
  }
  return false;
}

// Splits `s` on a keyword (e.g. "and") only where the match is a whole word (not part of a
// longer identifier) sitting outside any ()/[]/{} nesting - mirrors splitTopLevel above, but
// for a word separator like Xcas's `eq1 and eq2` (rather than a single punctuation char).
function splitTopLevelKeyword(s, word) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && s.startsWith(word, i)) {
      const before = i === 0 ? '' : s[i - 1];
      const after = s[i + word.length] ?? '';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
        parts.push(s.slice(start, i));
        i += word.length;
        start = i;
        continue;
      }
    }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

// Xcas syntax words and constants that can appear bare in an equation but are never
// themselves "the unknown" - `and`-joining equations for solve(), or names like `pi`/`i`
// that already have a fixed meaning to Giac.
const EQUATION_KEYWORDS = new Set(['and', 'or', 'not', 'xor', 'true', 'false']);
const BUILTIN_CONSTANT_NAMES = new Set(['pi', 'e', 'i', 'inf', 'infinity', 'euler_gamma']);
const FREE_VAR_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

// Collects the identifiers in `s` that stand for an unknown to solve for, in first-appearance
// order: skips Xcas keywords, skips names followed by "(" (those are function calls, e.g.
// `sin` in `sin(x)`, not variables), and skips anything in `knownConstants` - names the user
// has already assigned this session (see state.definitions in app.js), since a variable
// that's been given a value is a constant as far as the equation is concerned.
function collectFreeVariables(s, knownConstants) {
  const seen = new Set();
  const result = [];
  let m;
  FREE_VAR_IDENT_RE.lastIndex = 0;
  while ((m = FREE_VAR_IDENT_RE.exec(s))) {
    const name = m[0];
    if (seen.has(name)) continue;
    seen.add(name);
    if (EQUATION_KEYWORDS.has(name) || BUILTIN_CONSTANT_NAMES.has(name) || knownConstants.has(name)) continue;
    let j = m.index + name.length;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (s[j] === '(') continue; // function name, not a variable
    result.push(name);
  }
  return result;
}

// A line that's just one or more equations and no command at all - "x^2-3=0", or a system
// as "x+y=5 and y-x=3" or "[x+y=5,y-x=3]" - almost always means "solve this", so wrap it the
// way a user reaching for the `solve` button (see EXPRESSION_BUTTONS in app.js) would.
// Anything already wrapped in a call (including `solve(...)` itself) has its "=" at depth > 0
// and is left untouched. `knownConstants` (names already assigned this session) are excluded
// from the appended variable list - solve() is asked for only the genuinely free unknowns.
// The list is always given explicitly, even for a single variable (Giac returns the exact
// same solutions either way - just each one wrapped one list level deeper - see
// parseSolveVarList/parseSolveSolutions below), so the result can always be relabeled with
// which variable each value belongs to.
export function wrapBareEquation(expr, knownConstants = new Set()) {
  const s = expr.trim();
  if (!s) return expr;
  const hasSemi = s.endsWith(';');
  const body = hasSemi ? s.slice(0, -1) : s;
  if (!body) return expr;

  let equationsText = null;

  if (body[0] === '[' && findMatchingBracket(body, 0) === body.length - 1) {
    const parts = splitTopLevel(body.slice(1, -1), ',');
    if (parts.length > 0 && parts.every((p) => hasTopLevelBareEquals(p.trim()))) {
      equationsText = body;
    }
  }

  if (equationsText == null) {
    const andParts = splitTopLevelKeyword(body, 'and');
    if (andParts.length > 1 && andParts.every((p) => hasTopLevelBareEquals(p.trim()))) {
      equationsText = body;
    }
  }

  if (equationsText == null && hasTopLevelBareEquals(body)) {
    equationsText = body;
  }

  if (equationsText == null) return expr;

  const freeVars = collectFreeVariables(equationsText, knownConstants);
  const varsArg = freeVars.length > 0 ? `,[${freeVars.join(',')}]` : '';
  const wrapped = `solve(${equationsText}${varsArg})`;
  return hasSemi ? `${wrapped};` : wrapped;
}

// The input field is a multiline textarea so a system of equations can be typed one
// equation per line (Shift+Enter for a new line, plain Enter submits - see app.js). This
// trims each line and drops blank ones (so a trailing blank line from just pressing
// Shift+Enter isn't itself a missing equation), but otherwise leaves the line breaks alone -
// used for the history entry itself (see app.js's submit()), which keeps a system displayed
// the way it was typed, one equation per line. A single-line input passes through unchanged.
export function normalizeMultilineInput(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

// The string actually handed to the engine: same cleanup as normalizeMultilineInput, but
// each line joined with " and " instead of a newline - Xcas's own syntax for handing solve()
// several equations at once (see wrapBareEquation above), which is also exactly what
// giacToLatex already knows how to render.
export function joinInputLines(text) {
  return normalizeMultilineInput(text).replace(/\n/g, ' and ');
}

// Recognizes a `solve(<equations>,[<var1>,<var2>,...])` call - the shape wrapBareEquation
// now always produces - and returns the variable names in the order solve() was told them,
// or null if `sentExpr` (the exact string just sent to the engine) isn't shaped like that
// (any other command, or a `solve(...)` call typed by hand with no explicit variable list).
// Used to relabel the tuple(s) solve() hands back (see parseSolveSolutions below) with the
// variable each slot belongs to, since "(1 4)" on its own doesn't say which value is x and
// which is y.
function parseSolveVarList(sentExpr) {
  const s = sentExpr.trim();
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  if (!body.startsWith('solve(') || !body.endsWith(')')) return null;
  if (findMatchingParen(body, 5) !== body.length - 1) return null;
  const args = splitTopLevel(body.slice(6, -1), ',');
  if (args.length < 2) return null;
  const last = args[args.length - 1].trim();
  const m = last.match(/^\[\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\]$/);
  return m ? m[1].split(',').map((v) => v.trim()) : null;
}

// Turns solve()'s raw "list[[v1,v2],[v1,v2],...]" (each inner list one solution, in the same
// order as `varNames`) into one labeled clause per solution, e.g. "x=1 and y=4". With more
// than one solution each variable also gets a subscript naming which solution it belongs to
// ("x_1=1 and y_1=4", "x_2=3 and y_2=-2", ...) - the caller (evaluate()/evaluateApprox())
// puts one clause per line rather than running them together, so the subscript is what
// actually distinguishes them. Returns null for any shape that doesn't match - no solutions
// ("[]"), or a result that isn't actually a plain list of `varNames`-length tuples - so the
// caller falls back to showing Giac's own output untouched.
//
// Also returns `reinsertRaw`: a copy-friendly form of the solution(s), left undefined (meaning:
// caller keeps Giac's own raw list) whenever there's nothing worth simplifying - a system
// (more than one variable) with more than one solution, where the double nesting is the only
// thing that says which value belongs to which variable in which solution. Otherwise:
// - exactly one solution: unwrapped all the way down to its bare value for one equation
//   ("list[[6]]" -> "6"), or down to just its own value list for a system ("list[[6,5]]" ->
//   "[6,5]", since that inner list is still needed to tell the variables apart).
// - one equation, several solutions: flattened out of their needless one-per-solution
//   wrapping into a single flat list ("list[[-sqrt(2)],[sqrt(2)]]" -> "list[-sqrt(2),sqrt(2)]").
function parseSolveSolutions(raw, varNames) {
  let inner;
  if (raw.startsWith('list[') && raw.endsWith(']')) inner = raw.slice(5, -1);
  else if (raw.startsWith('[') && raw.endsWith(']')) inner = raw.slice(1, -1);
  else return null;
  if (!inner.trim()) return null;

  const tuples = [];
  for (const sol of splitTopLevel(inner, ',')) {
    const t = sol.trim();
    if (!(t.startsWith('[') && t.endsWith(']') && findMatchingBracket(t, 0) === t.length - 1)) return null;
    const values = splitTopLevel(t.slice(1, -1), ',').map((v) => v.trim());
    if (values.length !== varNames.length) return null;
    tuples.push(values);
  }

  const clauses = tuples.map((values, idx) => {
    const suffix = tuples.length > 1 ? `_${idx + 1}` : '';
    return varNames.map((name, i) => `${name}${suffix}=${values[i]}`).join(' and ');
  });

  let reinsertRaw;
  if (tuples.length === 1) {
    reinsertRaw = tuples[0].length === 1 ? tuples[0][0] : `[${tuples[0].join(',')}]`;
  } else if (varNames.length === 1) {
    reinsertRaw = `list[${tuples.map((values) => values[0]).join(',')}]`;
  }

  return { clauses, reinsertRaw };
}

// Stacks each already-labeled solution clause (see parseSolveSolutions) on its own row via
// MathJax's `gathered` environment - the same technique historyEntry.js uses for a
// multi-line input. Renders each clause separately (rather than the whole block as one
// string) since giacToLatex only understands one Giac expression at a time. Returns null,
// same as giacToLatex itself, if any clause fails to convert.
function renderGatheredLatex(clauses) {
  const rendered = clauses.map((clause) => giacToLatex(clause));
  return rendered.every(Boolean) ? `\\begin{gathered}${rendered.join('\\\\')}\\end{gathered}` : null;
}

// Builds the {text, latex} pair for a solve() result once it's known which variables solve()
// was given (see parseSolveVarList) - shared by evaluate() and both spots in evaluateApprox()
// that need it. Returns null (meaning: fall back to Giac's own rendering) whenever `varNames`
// is null or `raw` isn't actually shaped like a solve() result (see parseSolveSolutions).
function formatSolveResult(raw, varNames) {
  const parsed = varNames && parseSolveSolutions(raw, varNames);
  if (!parsed) return null;
  const { clauses, reinsertRaw } = parsed;
  return {
    text: clauses.join('\n'),
    latex: clauses.length === 1 ? giacToLatex(clauses[0]) || null : renderGatheredLatex(clauses),
    raw: reinsertRaw !== undefined ? reinsertRaw : raw,
  };
}

// Low-level access to the engine for callers (plotting) that need to run their own
// caseval expression and parse the raw string themselves, skipping the scalar-result
// shaping (quote stripping, latex round-trip) that evaluate() does.
export function evaluateRaw(expr) {
  return rawEvalAsync(expr);
}

function stripQuotes(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1);
  }
  return s;
}

function stripTrailingSemicolon(s) {
  return s.length > 1 && s[s.length - 1] === ';' ? s.slice(0, -1) : s;
}

// Fetches LaTeX for an already-evaluated Giac output string. Returns null if Giac can't
// latex() it (e.g. it's not a re-parseable value).
async function fetchLatex(out) {
  let latexOut = await rawEvalAsync(`latex(quote(${out}))`);
  if (latexOut.startsWith('GIAC_ERROR')) return null;
  // Giac never doubles up backslashes in its raw output - a run of two is always a
  // genuine LaTeX "\\" row-break (e.g. inside a matrix's \begin{array}{cc}...\end{array}),
  // so it must survive untouched; collapsing it to one (an earlier version of this code did)
  // corrupted every matrix/piecewise ("\begin{cases}") result into a single garbled row.
  return stripQuotes(latexOut)
    .replace(/\\"/g, '"')
    // Giac's own latex() has a bug for squared trig functions: it emits e.g.
    // "\cos\^{2}\left(...\right)" where the stray backslash before "^" makes
    // MathJax read it as the circumflex-accent command instead of a superscript.
    // Drop that backslash so "\^{" renders as the intended "^{".
    .replace(/\\\^\{/g, '^{');
}

// Evaluate one line of Xcas input. Returns a promise for:
//   { raw, isError, text, latex, isGraphics }
// - raw: the string Giac returned, untouched - except a single-solution solve() result,
//   which is unwrapped out of Giac's outer solution-list (see parseSolveSolutions)
// - text: a plain-text form suitable as a fallback / for re-insertion into the input
// - latex: LaTeX source for MathJax, or null if not available (error / plain string / graphics)
export async function evaluate(expr, knownConstants) {
  const sentExpr = normalizePowerCalls(normalizeNspireMatrices(normalizeNcrAlias(wrapBareEquation(expr, knownConstants))));
  let out = stripTrailingSemicolon(await rawEvalAsync(sentExpr));

  if (out.startsWith('GIAC_ERROR')) {
    return { raw: out, isError: true, text: out.slice(11).trim(), latex: null, isGraphics: false };
  }

  const unquoted = stripQuotes(out);

  if (unquoted !== out) {
    if (unquoted.startsWith('<svg') || unquoted.startsWith('gr2d(') || unquoted.startsWith('gl3d')) {
      return {
        raw: out,
        isError: false,
        text: 'Graphics output (plot/draw) is not rendered in this interface yet.',
        latex: null,
        isGraphics: true,
      };
    }
    return { raw: out, isError: false, text: unquoted, latex: null, isGraphics: false };
  }

  // Giac auto-appends "=<decimal>" to a non-integer exact result (see EXACT_DECIMAL_TAIL_RE
  // below) using its display precision - that decimal is only exact when the left side is a
  // rational number whose expansion terminates (e.g. "1/2=0.5"). Otherwise (an irrational
  // left side like "20*pi", or a repeating rational like "1/3") it's a rounded
  // approximation, so "=" would be a false claim - show "\approx"/"≈" instead while leaving
  // the exact left side untouched.
  const tailMatch = out.match(EXACT_DECIMAL_TAIL_RE);
  if (tailMatch) {
    const [, exactPart, decimalPart] = tailMatch;
    const rational = parseExactRational(exactPart);
    const isExact = rational != null && terminatingDecimalString(rational.num, rational.den) != null;
    if (!isExact) {
      const leftLatex = await fetchLatex(exactPart);
      return {
        raw: out,
        isError: false,
        text: `${exactPart} ≈ ${decimalPart}`,
        latex: leftLatex != null ? `${leftLatex} \\approx ${decimalPart}` : null,
        isGraphics: false,
      };
    }
  }

  // solve()'s own "(1 4)"-style tuple doesn't say which value is which variable - relabel it
  // to "x=1 and y=4" (see parseSolveSolutions), one solution per line, whenever `sentExpr`
  // was a solve() call with an explicit variable list (wrapBareEquation's path above, or the
  // same thing typed by hand). With more than one solution `raw` is left untouched, so
  // copying the result (see historyEntry.js) still copies exactly what Giac returned; with
  // exactly one solution `raw` is replaced by that solution's own value(s), unwrapped out of
  // Giac's outer solution-list (see parseSolveSolutions's `reinsertRaw`).
  const solved = formatSolveResult(out, parseSolveVarList(sentExpr));
  if (solved) {
    return { raw: solved.raw, isError: false, text: solved.text, latex: solved.latex, isGraphics: false };
  }

  const latexOut = await fetchLatex(out);
  return { raw: out, isError: false, text: out, latex: latexOut, isGraphics: false };
}

function bigGcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

// Parses a Giac numeric output that's a plain integer, decimal, or exact fraction into an
// exact { num, den } BigInt pair (den > 0), or null if it's anything else (irrational,
// symbolic, an equation, a list, ...).
function parseExactRational(s) {
  let m = s.match(/^(-?\d+)\/(\d+)$/);
  if (m) return { num: BigInt(m[1]), den: BigInt(m[2]) };

  m = s.match(/^(-?\d+)$/);
  if (m) return { num: BigInt(m[1]), den: 1n };

  m = s.match(/^(-?)(\d+)\.(\d+)$/);
  if (m) {
    const sign = m[1] === '-' ? -1n : 1n;
    const den = 10n ** BigInt(m[3].length);
    const num = sign * (BigInt(m[2]) * den + BigInt(m[3]));
    return { num, den };
  }

  return null;
}

// A reduced fraction's decimal expansion terminates iff its denominator's only prime
// factors are 2 and 5 (any other prime factor forces an infinitely repeating decimal).
// Returns the exact terminating decimal string, or null if it doesn't terminate.
function terminatingDecimalString(num, den) {
  const g = bigGcd(num, den) || 1n;
  num /= g;
  den /= g;
  const sign = num < 0n ? '-' : '';
  num = num < 0n ? -num : num;

  let rest = den;
  let pow2 = 0;
  let pow5 = 0;
  while (rest % 2n === 0n) {
    rest /= 2n;
    pow2++;
  }
  while (rest % 5n === 0n) {
    rest /= 5n;
    pow5++;
  }
  if (rest !== 1n) return null;

  const digits = Math.max(pow2, pow5);
  if (digits === 0) return `${sign}${num}`;

  const scaled = num * 2n ** BigInt(digits - pow2) * 5n ** BigInt(digits - pow5);
  const scaledStr = scaled.toString().padStart(digits + 1, '0');
  const intPart = scaledStr.slice(0, scaledStr.length - digits);
  const fracPart = scaledStr.slice(scaledStr.length - digits);
  return `${sign}${intPart}.${fracPart}`;
}

// Giac's own caseval() auto-appends "=<decimal>" to any *non-integer* exact numeric result
// (rational or irrational alike), using its current display precision - e.g. "1/3" evaluates
// to "1/3=0.333333333333" and "sqrt(2)" to "sqrt(2)=1.41421356237". reinsertableValue()
// above strips this for reinsertion; evaluateApprox() below reuses it as a free decimal
// approximation instead of a second engine round trip. The left side is left unconstrained
// (it's a plain fraction for a rational value, or arbitrary symbolic Giac output like
// "sqrt(2)" for an irrational one) - only the right side is pinned to "a decimal with a
// point", which is what caseval's own auto-tail always produces and a genuine equation
// result (e.g. "x=5" from solve) essentially never does, keeping false positives rare.
const EXACT_DECIMAL_TAIL_RE = /^(.+)=(-?\d+\.\d+)$/;

// Evaluate one line of Xcas input as a numeric approximation (bound to Ctrl+Enter, see
// app.js). Returns the same shape as evaluate(), except:
// - the result is always a decimal, never an exact fraction/symbolic form
// - `latex`/`text` are prefixed with "\approx "/"≈ " whenever displaying the result as a
//   decimal actually loses information - i.e. the exact value's decimal expansion doesn't
//   terminate (1/3 -> 0.3333...) or isn't rational to begin with (sqrt(2), pi, ...).
//   1/2 -> 0.5 is exact, so it gets no marker.
export async function evaluateApprox(expr, knownConstants) {
  const normalized = normalizePowerCalls(normalizeNspireMatrices(normalizeNcrAlias(wrapBareEquation(expr, knownConstants))));

  // Force exact evaluation regardless of the engine's ambient approx_mode setting (see
  // app.js's settings toggle) - otherwise a global approx mode would have already thrown
  // away the exact form before we ever see it.
  let out = stripTrailingSemicolon(await rawEvalAsync(`exact(${normalized})`));
  if (out.startsWith('GIAC_ERROR')) {
    // exact() couldn't wrap this input (e.g. a graphics/plot command) - fall back to a
    // plain evaluation rather than failing the whole submission.
    return evaluate(expr, knownConstants);
  }

  const unquoted = stripQuotes(out);
  if (unquoted !== out) {
    // String/graphics result - nothing to approximate.
    if (unquoted.startsWith('<svg') || unquoted.startsWith('gr2d(') || unquoted.startsWith('gl3d')) {
      return {
        raw: out,
        isError: false,
        text: 'Graphics output (plot/draw) is not rendered in this interface yet.',
        latex: null,
        isGraphics: true,
      };
    }
    return { raw: out, isError: false, text: unquoted, latex: null, isGraphics: false };
  }

  const tailMatch = out.match(EXACT_DECIMAL_TAIL_RE);
  if (tailMatch) {
    const rational = parseExactRational(tailMatch[1]);
    const exactDecimal = rational && terminatingDecimalString(rational.num, rational.den);
    if (exactDecimal) {
      return { raw: exactDecimal, isError: false, text: exactDecimal, latex: exactDecimal, isGraphics: false };
    }
    // Doesn't terminate (or isn't a plain rational at all, e.g. sqrt(2)) - Giac's own
    // rounded decimal is the best we can show, so mark it as approximate.
    const decimal = tailMatch[2];
    return { raw: decimal, isError: false, text: `≈ ${decimal}`, latex: `\\approx ${decimal}`, isGraphics: false };
  }

  if (/^-?\d+$/.test(out)) {
    // Plain integer - already exact, nothing to round.
    return { raw: out, isError: false, text: out, latex: out, isGraphics: false };
  }

  // solve()'s own tuple form doesn't say which value is which variable - see the matching
  // comment in evaluate() above (same single-solution `raw` unwrapping applies below).
  const varNames = parseSolveVarList(normalized);

  // Anything else (an equation, list, matrix, complex number, ...) doesn't get Giac's
  // automatic "=decimal" tail, so approximate it explicitly.
  let approxOut = stripTrailingSemicolon(await rawEvalAsync(`evalf(${out})`));
  if (approxOut.startsWith('GIAC_ERROR')) {
    // evalf() failed for some reason - show the exact form rather than an error.
    const solvedExact = formatSolveResult(out, varNames);
    if (solvedExact) {
      return { raw: solvedExact.raw, isError: false, text: solvedExact.text, latex: solvedExact.latex, isGraphics: false };
    }
    const latexOut = await fetchLatex(out);
    return { raw: out, isError: false, text: out, latex: latexOut, isGraphics: false };
  }

  const approxUnquoted = stripQuotes(approxOut);
  if (approxUnquoted !== approxOut) {
    return { raw: approxOut, isError: false, text: approxUnquoted, latex: null, isGraphics: false };
  }

  const solvedApprox = formatSolveResult(approxOut, varNames);
  if (solvedApprox) {
    return { raw: solvedApprox.raw, isError: false, text: solvedApprox.text, latex: solvedApprox.latex, isGraphics: false };
  }

  const latexOut = await fetchLatex(approxOut);
  return {
    raw: approxOut,
    isError: false,
    text: `≈ ${approxOut}`,
    latex: latexOut != null ? `\\approx ${latexOut}` : null,
    isGraphics: false,
  };
}
