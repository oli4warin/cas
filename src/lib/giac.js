// Talks to the Giac/Xcas WASM engine running in public/giac-worker.js (see that file for
// why it's a worker: some malformed input can send Giac's parser into a very long
// synchronous computation, and isolating it means the page never freezes for it - a
// timeout here just terminates and respawns the worker to recover).

import { giacToLatex } from './giacToLatex.js';
import { XCAS_COMMAND_ALIASES } from './xcasCommands.js';

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

// Rewrites any calculator-familiar alias from XCAS_COMMAND_ALIASES (see xcasCommands.js for
// why those are kept out of XCAS_COMMANDS/tab completion) to its canonical Giac name,
// case-insensitively, before the expression reaches the engine - same treatment as
// NCR_ALIAS_RE above, generalized to a table since there's now more than one such alias.
const ALIAS_NAMES_PATTERN = Object.keys(XCAS_COMMAND_ALIASES).join('|');
const COMMAND_ALIAS_RE = new RegExp(`\\b(${ALIAS_NAMES_PATTERN})(?=\\s*\\()`, 'gi');

export function normalizeAliasCommands(expr) {
  return expr.replace(COMMAND_ALIAS_RE, (m) => XCAS_COMMAND_ALIASES[m.toLowerCase()]);
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

// Splits `s` on its own top-level '+'/'-' operators, keeping each term's own leading sign
// attached (e.g. "a-b+c" -> ["a", "-b", "+c"]). A '+'/'-' only counts as a split point when
// it's acting as a binary operator - i.e. the previous character can end a term (a digit,
// letter, '.', ')', ']' or '}') - so a unary sign at the very start, or right after another
// operator/opening delimiter ('*','/','^','+','-','(','[','{',','), stays attached to what
// follows instead (e.g. "x^-2+1" splits as ["x^-2", "+1"], not ["x^", "-2", "+1"]). A '-'/'+'
// that's part of scientific notation ("1.5e-3") is likewise left attached to its mantissa.
function splitTopLevelTerms(s) {
  const terms = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === '+' || c === '-')) {
      const prev = s[i - 1];
      const isSciExponent = (prev === 'e' || prev === 'E') && /[0-9.]/.test(s[i - 2] ?? '');
      if (prev !== undefined && !isSciExponent && /[A-Za-z0-9_.)\]}]/.test(prev)) {
        terms.push(s.slice(start, i));
        start = i;
      }
    }
  }
  terms.push(s.slice(start));
  return terms;
}

// True for a term that's a bare numeric constant (an integer, decimal, or simple fraction,
// with an optional leading sign) and nothing else - "-3", "1/2", "0.25", but not "2*x" or
// "sqrt(5)".
function isNumericConstantTerm(term) {
  return /^[+-]?\d+(\.\d+)?(\/\d+)?$/.test(term);
}

// True for a term that's a single radical - "sqrt(5)", "-sqrt(2)", "2*sqrt(5)" - and nothing
// beyond it (not "sqrt(2)*sqrt(3)" or "sqrt(5)+1", which have more going on than one plain
// surd). Scoped this narrowly - rather than "any non-numeric term" - so an ordinary sum with
// a variable is never touched by reorderConstantRadicalSum below: "x+1" must stay "x+1", not
// become "1+x".
function isPureRadicalTerm(term) {
  const s = term[0] === '+' || term[0] === '-' ? term.slice(1) : term;
  const m = /^(?:\d+(?:\.\d+)?\*)?sqrt\(/.exec(s);
  if (!m) return false;
  const openIdx = s.indexOf('(');
  return findMatchingParen(s, openIdx) === s.length - 1;
}

// Rewrites a giac-syntax sum so a bare numeric constant sits before a lone radical term -
// "sqrt(5)+1" becomes "1+sqrt(5)", "-sqrt(5)+1" becomes "1-sqrt(5)" - matching how these are
// conventionally written by hand (e.g. the golden ratio as "(1+sqrt(5))/2", not
// "(sqrt(5)+1)/2", which is what Giac itself returns). Recurses into every
// parenthesized/bracketed subexpression first, so the same reordering reaches nested sums too
// - inside a product like "2*(1+sqrt(5))", or a solve() result buried in a list. Only the
// specific two-term "one constant + one lone radical" shape is reordered; anything else (no
// constant term, more than one of either, a third term, a variable) is left exactly as Giac
// gave it.
function reorderConstantRadicalSum(s) {
  let rebuilt = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '(' || c === '[') {
      const close = c === '(' ? findMatchingParen(s, i) : findMatchingBracket(s, i);
      if (close === -1) {
        rebuilt += s.slice(i);
        break;
      }
      rebuilt += c + reorderConstantRadicalSum(s.slice(i + 1, close)) + s[close];
      i = close + 1;
    } else {
      rebuilt += c;
      i++;
    }
  }
  s = rebuilt;

  const terms = splitTopLevelTerms(s);
  if (terms.length !== 2) return s;
  const [a, b] = terms;
  const [constant, radical] = isNumericConstantTerm(a) && isPureRadicalTerm(b) ? [a, b] : isNumericConstantTerm(b) && isPureRadicalTerm(a) ? [b, a] : [];
  if (!constant) return s;

  return constant.replace(/^\+/, '') + (/^[+-]/.test(radical) ? radical : `+${radical}`);
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

// True iff `s` has a top-level "bare" relation outside any (), [], {} nesting - either a
// plain `=` meaning "equation" (not `:=` assignment, `==`/`!=` comparison, or an `=` already
// sitting inside a call's arguments, e.g. `plot(x=1,...)`, or an equation already handed to
// `solve(...)` by the user themselves), an ordering relation (`<`, `<=`, `>`, `>=`) meaning
// "inequality", or a top-level `and`/`or` joining several such relations (Giac's own way of
// writing a system of inequalities on one variable, e.g. solve()'s own raw answer to
// "x>2 and x<5" comes back as "(x>2) and (x<5)" - each individual `<`/`>` there sits inside
// its own parens, at depth > 0, so only the `and`/`or` between them is visible at depth 0;
// see parseSolveSolutions below, which relies on this to recognize the whole thing as already
// a condition rather than a plain value). Any of these shapes is something wrapBareEquation
// below treats as "solve this".
function hasTopLevelRelation(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === '<' || c === '>')) {
      return true;
    } else if (c === '=' && depth === 0) {
      const prev = s[i - 1];
      const next = s[i + 1];
      if (prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>' && prev !== ':' && next !== '=') {
        return true;
      }
    }
  }
  return splitTopLevelKeyword(s, 'and').length > 1 || splitTopLevelKeyword(s, 'or').length > 1;
}

// True iff `s` has a top-level "|" outside any (), [], {} nesting - Giac's own "evaluate
// at"/substitution operator, e.g. "2*x+1|x=7" (giac substitutes x=7 and returns 15 directly,
// no subst() call needed) or "x+y|x=1,y=2" for several variables at once. A bare `var=value`
// after such a "|" is part of that substitution, not a separate equation to solve - without
// this check, hasTopLevelRelation above would spot that "=" and wrapBareEquation below would
// wrap the whole thing as `solve(2*x+1|x=7,x)`, which is a different (and broken) computation
// than what the user typed. A "|" nested inside a call the user already wrote themselves (e.g.
// `solve(x^2=1|x>0,x)`) sits at depth > 0 and is untouched by this.
function hasTopLevelPipe(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '|' && depth === 0) return true;
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

// Xcas's derivative shorthand - "y'", "f''", etc, meaning "y differentiated once w.r.t. its
// (implicit) independent variable". Collects the distinct base names that appear this way in
// `s`, in first-appearance order - these are exactly the unknown functions a desolve() call
// needs telling about (see wrapBareEquation below). Unlike collectFreeVariables, this doesn't
// care whether the name is also followed by "(" (an ODE is often typed either as "y'=y" or
// "y'(x)=y(x)" - both mean the same unknown function y).
const PRIMED_IDENT_RE = /([A-Za-z_][A-Za-z0-9_]*)'+/g;

function collectPrimedFunctionNames(s) {
  const seen = new Set();
  const result = [];
  let m;
  PRIMED_IDENT_RE.lastIndex = 0;
  while ((m = PRIMED_IDENT_RE.exec(s))) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

// desolve()'s independent variable has to be named explicitly (see wrapBareEquation below) -
// 'x' is the obvious default (matches diff/derive's own default elsewhere in this file), but
// falls back to the first of these candidates that isn't itself one of the unknown functions
// (e.g. an equation naming its unknown function "x" instead of the usual "y").
const INDEPENDENT_VAR_CANDIDATES = ['x', 't', 's'];

function pickIndependentVar(funcNames) {
  return INDEPENDENT_VAR_CANDIDATES.find((v) => !funcNames.includes(v)) || 'x';
}

// A line that's just one or more equations and no command at all - "x^2-3=0", or a system
// as "x+y=5 and y-x=3" or "[x+y=5,y-x=3]" - almost always means "solve this", so wrap it the
// way a user reaching for the `solve` button (see EXPRESSION_BUTTONS in app.js) would. The
// same detection, but for equations involving a derivative of a *single* unknown function
// ("y'=y", "f''+f=0", or an initial-value problem spread over two lines like "y'=y" and
// "y(0)=8") means "solve this ODE" instead - wrapped in
// desolve(equations,independent_var,function) rather than solve(equations,vars); Giac accepts
// a list of equations there the same way it does for solve(), so any number of extra
// conditions on the same function are fine. What's still disallowed is a derivative *system*
// naming more than one distinct unknown function (e.g. "y'=z and z'=-y") - that's deliberately
// left going through solve() below for now, since desolve()'s own multi-function shape
// ([eq1,eq2],x,[f1,f2]) doesn't work yet and producing that call would just fail. Anything
// already wrapped in a call (including
// `solve(...)`/`desolve(...)` themselves) has its "=" at depth > 0 and is left untouched.
// `knownConstants` (names already assigned this session) are excluded from solve()'s appended
// variable list - it's asked for only the genuinely free unknowns. That variable is always
// given explicitly (see parseSolveVarList/parseSolveSolutions below, so the result can always
// be relabeled with which variable each value belongs to) - as a bracketed list for a system
// of more than one variable, but deliberately *not* bracketed for a single variable, even
// though Giac accepts "solve(eq,[x])" too and normally treats it the same as "solve(eq,x)":
// for a bare inequality specifically, the bracketed form has been observed to make Giac fall
// back to a numeric "Certificate of existence" result instead of solving it symbolically
// (e.g. "x>2" wrapped as "solve(x>2,[x])" comes back wrong; "solve(x>2,x)" is correct) - so
// the one-variable case always uses the plain, unbracketed form to avoid that.
export function wrapBareEquation(expr, knownConstants = new Set()) {
  const s = expr.trim();
  if (!s) return expr;
  const hasSemi = s.endsWith(';');
  const body = hasSemi ? s.slice(0, -1) : s;
  if (!body) return expr;
  if (hasTopLevelPipe(body)) return expr;

  let equationsText = null;
  let equationParts = null;

  if (body[0] === '[' && findMatchingBracket(body, 0) === body.length - 1) {
    const parts = splitTopLevel(body.slice(1, -1), ',');
    if (parts.length > 0 && parts.every((p) => hasTopLevelRelation(p.trim()))) {
      equationsText = body;
      equationParts = parts.map((p) => p.trim());
    }
  }

  if (equationsText == null) {
    const andParts = splitTopLevelKeyword(body, 'and');
    if (andParts.length > 1 && andParts.every((p) => hasTopLevelRelation(p.trim()))) {
      equationsText = body;
      equationParts = andParts.map((p) => p.trim());
    }
  }

  if (equationsText == null && hasTopLevelRelation(body)) {
    equationsText = body;
    equationParts = [body.trim()];
  }

  if (equationsText == null) return expr;

  // Multi-function systems disabled for now - desolve() doesn't handle the
  // [eq1,eq2],x,[f1,f2] shape correctly yet, so anything naming more than one distinct
  // primed function (e.g. "y'=z and z'=-y") falls through to solve() below same as before,
  // rather than producing a desolve() call that doesn't actually work. Multiple *equations*
  // for the *same* function (e.g. "y'=y" and "y(0)=8", an initial condition) are fine, though
  // - desolve() takes a list of those exactly like solve() does for a system.
  const funcNames = collectPrimedFunctionNames(equationsText);
  if (funcNames.length === 1) {
    const indepVar = pickIndependentVar(funcNames);
    const eqsArg = equationParts.length > 1 ? `[${equationParts.join(',')}]` : equationParts[0];
    const wrapped = `desolve(${eqsArg},${indepVar},${funcNames[0]})`;
    return hasSemi ? `${wrapped};` : wrapped;
  }

  const freeVars = collectFreeVariables(equationsText, knownConstants);
  const varsArg = freeVars.length > 1 ? `,[${freeVars.join(',')}]` : freeVars.length === 1 ? `,${freeVars[0]}` : '';
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

// All five take their variable as the last argument, either bare ("solve(x^2=2,x)",
// "fsolve(cos(x)=x,x)" - how they're most naturally typed by hand) or as a bracketed list
// ("solve(x^2=2,[x])" - what wrapBareEquation always produces for a bare equation). Only
// solve/csolve can take a *multi*-variable bracketed list ("[x,y]") for a system - Giac
// errors if fsolve/zeros/czeros are given one, so that shape is rejected for them here too
// (falling back to plain, unlabeled rendering) rather than mislabeling a result that doesn't
// actually correspond to a solved system.
const SOLVE_LIKE_COMMANDS = new Set(['solve', 'csolve', 'fsolve', 'zeros', 'czeros']);
const SYSTEM_CAPABLE_COMMANDS = new Set(['solve', 'csolve']);

// Recognizes a solve-like call in any of the shapes above and returns the variable name(s) in
// argument order, or null if `sentExpr` (the exact string just sent to the engine) isn't
// shaped like one (any other command, or a call to one of these typed with no variable at all,
// or a plain default-guess numeral in fsolve's place, etc). Used to relabel the solution(s)
// handed back (see parseSolveSolutions below) with the variable each slot belongs to, since a
// bare tuple/list on its own doesn't say which value is which variable.
function parseSolveVarList(sentExpr) {
  const s = sentExpr.trim();
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
  if (!nameMatch || !body.endsWith(')')) return null;
  const name = nameMatch[1];
  if (!SOLVE_LIKE_COMMANDS.has(name)) return null;
  const openIdx = nameMatch[0].length - 1;
  if (findMatchingParen(body, openIdx) !== body.length - 1) return null;
  const args = splitTopLevel(body.slice(openIdx + 1, -1), ',');
  if (args.length < 2) return null;
  const last = args[args.length - 1].trim();

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return [last];

  const bracketed = last.match(/^\[\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*\]$/);
  if (!bracketed) return null;
  const vars = bracketed[1].split(',').map((v) => v.trim());
  return vars.length === 1 || SYSTEM_CAPABLE_COMMANDS.has(name) ? vars : null;
}

// True when `sentExpr` (the exact string just sent to the engine) is a bare top-level call to
// integrate()/int() with no integration bounds - integrate(f), integrate(f,x) - i.e. an
// indefinite integral, whose result is an antiderivative that's only unique up to an additive
// constant, unlike integrate(f,x,a,b)'s definite (4-argument) form. Used to append "+C" to the
// *rendered* LaTeX only (see evaluate()/evaluateApprox()) - Giac's own output never includes an
// arbitrary constant, and `raw`/`text` are left untouched since those are what gets
// copied/reinserted (see reinsertableValue in historyEntry.js).
const INTEGRATE_NAME_RE = /^(integrate|int)$/i;

function isIndefiniteIntegral(sentExpr) {
  const s = sentExpr.trim();
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
  if (!nameMatch || !body.endsWith(')') || !INTEGRATE_NAME_RE.test(nameMatch[1])) return false;
  const openIdx = nameMatch[0].length - 1;
  if (findMatchingParen(body, openIdx) !== body.length - 1) return false;
  const args = splitTopLevel(body.slice(openIdx + 1, -1), ',');
  return args.length === 1 || args.length === 2;
}

// Appends "+C" to a rendered LaTeX antiderivative - "\\int ... dx" style spacing isn't in play
// here (this runs on the *result*, not the integral notation itself), so a plain textual
// append is enough; skipped when there's no LaTeX to append to (e.g. fetchLatex failed).
function appendArbitraryConstant(latex) {
  return latex == null ? latex : `${latex}+C`;
}

// Strips as many layers of a fully-enclosing, matched outer "(...)" pair as `s` has - used
// below (see normalizeSolutionValue) because Giac sometimes wraps a whole conjunction of
// relations in its own redundant outer parens (e.g. "((x>5) and (x<10))" for
// "solve(x>5 and x<10,x)"), on top of the parens each individual relation already carries.
function stripRedundantOuterParens(s) {
  while (s.length >= 2 && s[0] === '(' && s[s.length - 1] === ')' && findMatchingParen(s, 0) === s.length - 1) {
    s = s.slice(1, -1);
  }
  return s;
}

// A solve() value that's really a relation (see hasTopLevelRelation) - a single inequality
// or a conjunction/disjunction of several - can come wrapped in its own redundant outer
// parens. Unwrapping first, only when doing so actually reveals a relation (never for a
// plain value that legitimately starts and ends with its own parens), means both the
// relation check and the value ultimately shown (see parseSolveSolutions below) drop that
// outer wrapping - "(x>5) and (x<10)" rather than "x=((x>5) and (x<10))". Each individual
// relation keeps its own parens; only the single redundant pair around the whole thing goes.
function normalizeSolutionValue(value) {
  const stripped = stripRedundantOuterParens(value);
  return reorderConstantRadicalSum(stripped !== value && hasTopLevelRelation(stripped) ? stripped : value);
}

// Turns a solve-like call's raw result - solve/csolve's own "list[[v1,v2],[v1,v2],...]" (each
// inner list one solution, in the same order as `varNames`), or fsolve/zeros/czeros's flatter
// "[v1,v2,...]" (always single-variable, so each element directly *is* one solution's value,
// not wrapped in its own one-element tuple) - into one labeled clause per solution, e.g.
// "x=1 and y=4". With more than one solution each variable also gets a subscript naming which
// solution it belongs to ("x_1=1 and y_1=4", "x_2=3 and y_2=-2", ...) - the caller
// (evaluate()/evaluateApprox()) puts one clause per line rather than running them together, so
// the subscript is what actually distinguishes them. Returns null for any shape that doesn't
// match - no solutions ("[]"), or a result that isn't actually a plain list of
// `varNames`-length tuples (or, for one variable, of bare values) - so the caller falls back
// to showing Giac's own output untouched.
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
// Parses solve/csolve's own "list[[v1,v2],[v1,v2],...]" (each inner list one solution, in the
// same order as `varNames`), or fsolve/zeros/czeros's flatter "[v1,v2,...]" (always
// single-variable, so each element directly *is* one solution's value, not wrapped in its own
// one-element tuple), into an array of tuples - one array of `varNames.length` values per
// solution. Returns null for anything that isn't actually shaped like one of those (not
// bracket-wrapped at all, no solutions ("[]"), or a tuple whose length doesn't match
// `varNames`) - shared by parseSolveSolutions (the exact/"=" path) and
// formatSolveResultApprox (evaluateApprox()'s "≈" path) below.
function parseSolveTuples(raw, varNames) {
  let inner;
  if (raw.startsWith('list[') && raw.endsWith(']')) inner = raw.slice(5, -1);
  else if (raw.startsWith('[') && raw.endsWith(']')) inner = raw.slice(1, -1);
  else return null;
  if (!inner.trim()) return null;

  const tuples = [];
  for (const sol of splitTopLevel(inner, ',')) {
    const t = sol.trim();
    if (t.startsWith('[') && t.endsWith(']') && findMatchingBracket(t, 0) === t.length - 1) {
      const values = splitTopLevel(t.slice(1, -1), ',').map((v) => normalizeSolutionValue(v.trim()));
      if (values.length !== varNames.length) return null;
      tuples.push(values);
    } else if (varNames.length === 1) {
      tuples.push([normalizeSolutionValue(t)]);
    } else {
      return null;
    }
  }
  return tuples;
}

function parseSolveSolutions(raw, varNames) {
  const tuples = parseSolveTuples(raw, varNames);
  if (!tuples) return null;

  // solve() hands back an inequality solution (e.g. "x>6") as just another list element,
  // exactly like it would a plain value - labeling it the same way a plain value gets
  // labeled would double up on the variable ("x=x>6"). A value that's already its own
  // top-level relation is shown as-is instead, dropping the "name[_idx]=" prefix entirely
  // (not just the "name=" part) since the value already says which variable it constrains.
  const clauses = tuples.map((values, idx) => {
    const suffix = tuples.length > 1 ? `_${idx + 1}` : '';
    return varNames
      .map((name, i) => {
        const value = values[i];
        return hasTopLevelRelation(value) ? value : `${name}${suffix}=${value}`;
      })
      .join(' and ');
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

// Recognizes a desolve(...) call and returns the name of the unknown function it solves for,
// or null if `sentExpr` isn't shaped like one desolve() can be labeled for. Mirrors
// parseSolveVarList above, but desolve's own return value is already just the solution
// expression itself (not a tuple/list needing unwrapping - see parseSolveSolutions), so all
// that's needed here is the function's name to prefix it with (see formatDesolveResult).
// Only a single, bare function name is handled - a bracketed list (a system, e.g.
// "desolve([...],x,[y,z])") is left unlabeled since wrapBareEquation itself never produces
// one right now (systems don't work with desolve yet - see its own comment) and a
// hand-typed one wouldn't say which list slot is which solution anyway.
function parseDesolveFuncName(sentExpr) {
  const s = sentExpr.trim();
  const body = s.endsWith(';') ? s.slice(0, -1) : s;
  if (!/^desolve\(/i.test(body) || !body.endsWith(')')) return null;
  const openIdx = body.indexOf('(');
  if (findMatchingParen(body, openIdx) !== body.length - 1) return null;
  const args = splitTopLevel(body.slice(openIdx + 1, -1), ',');
  if (args.length === 0) return null;
  const last = args[args.length - 1].trim();
  if (args.length >= 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return last;
  // No explicit function argument (e.g. a hand-typed "desolve(y'=y)") - fall back to whatever
  // single function the equation itself names as a derivative.
  const funcNames = collectPrimedFunctionNames(args[0]);
  return funcNames.length === 1 ? funcNames[0] : null;
}

// Builds the {text, latex, raw} triple for a desolve() result once it's known which function
// desolve() was solving for (see parseDesolveFuncName) - labels the display as "y=<solution>"
// (matching how formatSolveResult labels solve()'s own results), e.g. "y=e^x" rather than the
// bare "e^x" Giac itself returns, while `raw` stays the bare, unlabeled solution so copying it
// back out (see historyEntry.js) reinserts just the expression, not "y=" along with it.
function formatDesolveResult(raw, funcName) {
  if (!funcName) return null;
  raw = reorderConstantRadicalSum(raw);
  const clause = `${funcName}=${raw}`;
  return { text: clause, latex: giacToLatex(clause) || null, raw };
}

// Low-level access to the engine for callers (plotting) that need to run their own
// caseval expression and parse the raw string themselves, skipping the scalar-result
// shaping (quote stripping, latex round-trip) that evaluate() does.
export function evaluateRaw(expr) {
  return rawEvalAsync(expr);
}

// Giac's own autosimplify() flag (0=none, 1=regroup, 2=simplify) only governs what a real
// Xcas session auto-applies to a line's result inside its own command loop - it does
// nothing for a bare caseval() call like this app makes, so evaluate() below has to
// replicate it itself by re-running the result through regroup()/simplify() when the level
// is above 0 (see applyAutosimplify). This module-level level is what that re-run reads;
// the engine-side flag is still set too, for any print statement inside multi-line input.
let autosimplifyLevel = 1;

export function setAutosimplifyLevel(level) {
  autosimplifyLevel = level;
  return rawEvalAsync(`autosimplify(${level})`);
}

// Re-simplifies a final result per the current autosimplify level. Only ever applied to
// the generic fallback branch of evaluate() (see there) - not to solve()/desolve()'s own
// specially-formatted output, which this would otherwise reshape (e.g. solve()'s "[-2,2]"
// list becomes the set "{-2,2}" under regroup/simplify, breaking the "x1=-2, x2=2" tuple
// labeling). Level 2 is a real trade-off, not a bug: simplify() also undoes an explicit
// factor() call's result back into expanded form, exactly as autosimplify(2) does in a real
// Xcas session - level 1 (regroup) still collects like terms (x+x -> 2*x) without that.
async function applyAutosimplify(out) {
  if (autosimplifyLevel === 0) return out;
  const wrapped = autosimplifyLevel === 2 ? `simplify(${out})` : `regroup(${out})`;
  const result = stripTrailingSemicolon(await rawEvalAsync(wrapped));
  return result.startsWith('GIAC_ERROR') ? out : result;
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

// Renders a normalized-scientific mantissa/exponent pair as LaTeX - a mantissa of exactly
// "1"/"-1" drops the "\cdot" (just "10^{6}", not "1 \cdot 10^{6}") since it carries no
// information.
function sciLatex(mantissa, exponent) {
  if (mantissa === '1') return `10^{${exponent}}`;
  if (mantissa === '-1') return `-10^{${exponent}}`;
  return `${mantissa} \\cdot 10^{${exponent}}`;
}

// Giac's own latex() leaves a scientific-notation number (its display form for anything
// past its precision threshold, e.g. "1.2e-06" or "1e+20") completely untouched instead of
// converting it - MathJax then reads the bare "e" as Euler's constant and the sign/digits
// after it as a separate factor, e.g. "1.2e-06" renders as "1.2 e -06". Rewrite every such
// token to "1.2 \cdot 10^{-6}" instead. Matches only a bare digit-e-digit run (no "^{" or
// space before the "e"), which is exactly Giac's own scientific-notation shape and never how
// it renders an actual "<number> times e" product (that comes out as e.g. "2 e^{1}").
const SCI_NOTATION_RE = /(-?\d+(?:\.\d+)?)e([+-]?\d+)/g;
function fixScientificNotation(latex) {
  return latex.replace(SCI_NOTATION_RE, (_, mantissa, exponent) => sciLatex(mantissa, parseInt(exponent, 10)));
}

// Giac's own latex() always renders Euler's number as a bare, italic "e" - typically as the
// base of a power, even for a bare "e" on its own (which Giac evaluates to "exp(1)", latex'd
// as "e^{1}") - indistinguishable from an italic variable named "e" (which Giac doesn't
// otherwise produce - see above, it always resolves a bare "e" to exp(1) first). Standard
// math typography sets the constant upright instead, so rewrite every such token to
// "\mathrm{e}". Scoped to "e" immediately followed by "^" (matches every shape Giac's own
// latex() actually emits - see the fixScientificNotation comment above) and bounded by a word
// boundary so it never touches an "e" that's part of a longer identifier (e.g. "\mathrm{Ei}"'s
// capital "E", or "erf").
const EULER_CONSTANT_RE = /\be(?=\^)/g;
function fixEulerConstant(latex) {
  return latex.replace(EULER_CONSTANT_RE, '\\mathrm{e}');
}

// Giac's own latex() for an integral it couldn't resolve to a closed form (e.g.
// "integrate(exp(sin(x)),x)") echoes the integral notation itself, "\int e^{\sin(x)}\, dx" -
// the trailing differential's "d" is bare/italic, same typographic issue as Euler's constant
// above. Scoped to a "d" right after Giac's own "\, " separator (the only place its latex()
// emits one) and followed by the integration variable (a plain letter, or a Greek letter's own
// backslash command, e.g. "d\alpha") - never a stray "d" used as an ordinary identifier
// elsewhere in the expression.
const DIFFERENTIAL_D_RE = /(\\,\s*)d(?=[A-Za-z\\])/g;
function fixDifferentialD(latex) {
  return latex.replace(DIFFERENTIAL_D_RE, (_, pre) => `${pre}\\mathrm{d}`);
}

// How many digits (integer digits for a large number, or leading zeros past the point before
// the first significant digit for a small one) an approximate result can show in full before
// switching to scientific notation - e.g. 1234567 (7 digits) or 0.0000001 (first significant
// digit 7 places after the point) both exceed it, while 123456 and 0.000001 (6 either way)
// don't.
const APPROX_SCI_DIGIT_LIMIT = 6;

// Parses a plain Giac number string - "4000000", "-0.00000001", or already-scientific like
// "1.2e-06" - into its exact (string/BigInt-only, so never lossy for arbitrarily large/small
// numbers) normalized-scientific decomposition: the signed significant digits and the decimal
// exponent of the leading one. Returns null for anything that isn't a single plain real
// number (an equation, complex number, list, matrix, ...) - those are left to Giac's own
// latex() untouched.
function parseDecimal(str) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(str.trim());
  if (!m) return null;
  const [, signStr, intPart, fracPart = '', expPart] = m;
  const digits = intPart + fracPart;
  const firstSig = digits.search(/[1-9]/);
  if (firstSig === -1) return { sign: '', sig: '0', exponent: 0 }; // the value is zero
  const giacExp = expPart ? parseInt(expPart, 10) : 0;
  const exponent = intPart.length + giacExp - firstSig - 1;
  const sig = digits.slice(firstSig).replace(/0+$/, '') || '0';
  return { sign: signStr, sig, exponent };
}

// The most significant digits an approximate result's mantissa is ever shown with - matches
// Giac's own default display precision (e.g. its "6.91570797214e+19" already has exactly this
// many). Without a cap, an exact value with far more known digits than that - a huge power or
// factorial - would dump its entire digit string into the mantissa (a many-thousand-digit
// factorial's scientific form would have a many-thousand-digit "mantissa", same problem in a
// different shape), which is exactly the wall of digits scientific notation exists to avoid.
const APPROX_SCI_PRECISION = 12;

// Rounds a digit string to `precision` significant digits (round-half-up), returning the
// (possibly shorter, trailing-zero-trimmed) result and the exponent adjustment a carry out of
// the leading digit needs (e.g. rounding "999999999999" + next digit "9" up by one digit).
function roundSignificantDigits(sig, exponent, precision) {
  if (sig.length <= precision) return { sig, exponent };
  let rounded = BigInt(sig.slice(0, precision)) + (sig[precision] >= '5' ? 1n : 0n);
  let roundedStr = rounded.toString();
  if (roundedStr.length > precision) {
    // Carried out of the leading digit (e.g. 999...9 -> 1000...0) - that extra digit is
    // really the start of the next power of ten, so drop it and bump the exponent instead.
    roundedStr = roundedStr.slice(0, precision);
    exponent += 1;
  }
  return { sig: roundedStr.replace(/0+$/, '') || '0', exponent };
}

// Forces a plain decimal/integer approximate result into scientific-notation LaTeX once it
// has more than APPROX_SCI_DIGIT_LIMIT digits - Giac's own latex() only switches at a much
// higher, fixed precision threshold, so a run-of-the-mill approximate result like 1e9 or 1e-8
// would otherwise print every digit out in full. Returns null (meaning: display unchanged)
// when `str` isn't a single plain number, or is one but doesn't cross the threshold. Otherwise
// returns { latex, rounded } - `rounded` says whether fitting it to APPROX_SCI_PRECISION
// significant digits actually dropped real (nonzero) digits, e.g. for an exact value (a big
// power or factorial) whose full digit string is known but far longer than that - callers
// showing such a value with "=" need to know to fall back to "≈" instead once that happens.
function formatApproxSci(str) {
  const parsed = parseDecimal(str);
  if (!parsed) return null;
  let { sign, sig, exponent } = parsed;
  if (exponent < APPROX_SCI_DIGIT_LIMIT && exponent > -(APPROX_SCI_DIGIT_LIMIT + 1)) return null;
  const rounded = sig.length > APPROX_SCI_PRECISION;
  ({ sig, exponent } = roundSignificantDigits(sig, exponent, APPROX_SCI_PRECISION));
  const mantissa = sign + sig[0] + (sig.length > 1 ? `.${sig.slice(1)}` : '');
  return { latex: sciLatex(mantissa, exponent), rounded };
}

// True when `a` and `b` are literally the same number - compares their normalized
// significant digits/exponent (see parseDecimal) rather than raw text, since Giac's own tail
// can be in a different shape (scientific) than the value it's previewing.
function sameNumericValue(a, b) {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  return !!pa && !!pb && pa.sign === pb.sign && pa.sig === pb.sig && pa.exponent === pb.exponent;
}

// Builds an evaluateApprox() result for a value that's known exact (a plain integer, or a
// fraction whose decimal expansion terminates) - "≈" only appears when formatApproxSci had to
// round its mantissa down to APPROX_SCI_PRECISION digits to display it in scientific
// notation (e.g. a huge power or factorial), same as it would for a genuinely rounded value
// like 17/3; otherwise `str` is shown as-is, with no marker, since nothing was lost.
function exactNumberResult(str) {
  const sci = formatApproxSci(str);
  if (sci?.rounded) {
    return { raw: str, isError: false, text: `≈ ${str}`, latex: `\\approx ${sci.latex}`, isGraphics: false };
  }
  return { raw: str, isError: false, text: str, latex: sci ? sci.latex : str, isGraphics: false };
}

// Giac's own latex() wraps a sqrt() in a redundant "\left(...\right)" pair whenever it's
// being subtracted (e.g. "1-sqrt(5)" -> "1-\left(\sqrt{5}\right)"), though the very same
// sqrt() latexes as plain "\sqrt{5}" when it isn't preceded by a minus sign (e.g.
// "sqrt(5)-1" -> "\sqrt{5}-1"). Giac's own term order never actually triggers this itself -
// it always puts a subtracted sqrt() first (negated), never after a leading term - but
// reorderConstantRadicalSum above does exactly that by design, so this strips the redundant
// wrapping back off wherever it shows up. Scans by hand (rather than a regex) so a radicand
// with its own braces (e.g. "\sqrt{\frac{1}{2}}") is still matched up correctly.
function fixNegatedSqrtParens(latex) {
  const NEEDLE = '-\\left(\\sqrt{';
  const CLOSE = '\\right)';
  let out = '';
  let i = 0;
  while (i < latex.length) {
    const idx = latex.indexOf(NEEDLE, i);
    if (idx === -1) {
      out += latex.slice(i);
      break;
    }
    out += latex.slice(i, idx);
    const braceStart = idx + NEEDLE.length - 1; // the sqrt argument's own opening '{'
    let depth = 0;
    let j = braceStart;
    for (; j < latex.length; j++) {
      if (latex[j] === '{') depth++;
      else if (latex[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && latex.startsWith(CLOSE, j + 1)) {
      out += '-\\sqrt' + latex.slice(braceStart, j + 1);
      i = j + 1 + CLOSE.length;
    } else {
      // Not actually the shape expected (unbalanced braces, or no matching "\right)"
      // immediately after) - leave it untouched rather than risk corrupting it.
      out += latex[idx];
      i = idx + 1;
    }
  }
  return out;
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
  return fixNegatedSqrtParens(
    fixDifferentialD(
      fixEulerConstant(
        fixScientificNotation(
          stripQuotes(latexOut)
            .replace(/\\"/g, '"')
            // Giac's own latex() has a bug for squared trig functions: it emits e.g.
            // "\cos\^{2}\left(...\right)" where the stray backslash before "^" makes
            // MathJax read it as the circumflex-accent command instead of a superscript.
            // Drop that backslash so "\^{" renders as the intended "^{".
            .replace(/\\\^\{/g, '^{'),
        ),
      ),
    ),
  );
}

// Evaluate one line of Xcas input. Returns a promise for:
//   { raw, isError, text, latex, isGraphics }
// - raw: the string Giac returned, untouched - except a single-solution solve() result,
//   which is unwrapped out of Giac's outer solution-list (see parseSolveSolutions)
// - text: a plain-text form suitable as a fallback / for re-insertion into the input
// - latex: LaTeX source for MathJax, or null if not available (error / plain string / graphics)
export async function evaluate(expr, knownConstants) {
  const sentExpr = normalizePowerCalls(normalizeNspireMatrices(normalizeAliasCommands(normalizeNcrAlias(wrapBareEquation(expr, knownConstants)))));
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

  // Giac auto-appends "=<preview>" to a non-integer exact result, or to a plain integer once
  // it's too big to preview normally (see EXACT_DECIMAL_TAIL_RE above). That preview is only
  // exact when the left side is a rational number whose decimal expansion terminates (e.g.
  // "1/2=0.5") - and even then, only when it's short enough that Giac didn't need to round it
  // for display, so it's re-derived here rather than trusted outright. A plain integer's own
  // preview is always a rounded stand-in (an integer has no "decimal expansion" of its own to
  // compare against) and an overflowed preview ("infinity"/"undef") isn't a real number at
  // all - both are shown as "≈"/dropped rather than "=".
  const tailMatch = out.match(EXACT_DECIMAL_TAIL_RE);
  if (tailMatch) {
    const [, exactPartRaw, decimalPart] = tailMatch;
    const exactPart = reorderConstantRadicalSum(exactPartRaw);
    if (parseDecimal(decimalPart) == null) {
      // Giac's own preview overflowed to "infinity"/"undef" - it carries no information, so
      // drop it and just show the exact value.
      return { raw: exactPart, isError: false, text: exactPart, latex: await fetchLatex(exactPart), isGraphics: false };
    }
    const rational = parseExactRational(exactPart);
    if (rational && rational.den === 1n && sameNumericValue(exactPart, decimalPart)) {
      // A plain integer short enough that Giac didn't need to round its own preview - it's
      // then just a redundant echo of the integer itself, so drop it entirely.
      return { raw: exactPart, isError: false, text: exactPart, latex: await fetchLatex(exactPart), isGraphics: false };
    }
    const exactDecimal = rational && rational.den !== 1n ? terminatingDecimalString(rational.num, rational.den) : null;
    const leftLatex = await fetchLatex(exactPart);
    if (exactDecimal) {
      // Our own recomputed decimal is verified exact, but displaying it can still mean
      // rounding it for the mantissa (see formatApproxSci) once it has more significant
      // digits than an approximate display ever shows - "=" is only honest when that didn't
      // happen; otherwise it's "≈" the same as the non-terminating case just below.
      const sci = formatApproxSci(exactDecimal);
      const approxDisplay = sci?.rounded;
      return {
        raw: out,
        isError: false,
        text: `${exactPart} = ${exactDecimal}`,
        latex: leftLatex != null ? `${leftLatex} ${approxDisplay ? '\\approx' : '='} ${sci ? sci.latex : exactDecimal}` : null,
        isGraphics: false,
      };
    }
    const decimalSci = formatApproxSci(decimalPart);
    return {
      raw: out,
      isError: false,
      text: `${exactPart} ≈ ${decimalPart}`,
      latex: leftLatex != null ? `${leftLatex} \\approx ${decimalSci ? decimalSci.latex : decimalPart}` : null,
      isGraphics: false,
    };
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

  // desolve()'s own bare solution expression doesn't say which function it's the solution
  // for - relabel it to "y=e^x" (see formatDesolveResult) whenever `sentExpr` was a desolve()
  // call with a recognizable function argument (wrapBareEquation's path above, or the same
  // thing typed by hand). `raw` is left as Giac's own bare expression, so copying the result
  // (see historyEntry.js) reinserts just the solution, not the "y=" label.
  const desolved = formatDesolveResult(out, parseDesolveFuncName(sentExpr));
  if (desolved) {
    return { raw: desolved.raw, isError: false, text: desolved.text, latex: desolved.latex, isGraphics: false };
  }

  const simplifiedOut = reorderConstantRadicalSum(await applyAutosimplify(out));
  let latexOut = await fetchLatex(simplifiedOut);
  // Skip "+C" when Giac couldn't find a closed form and just echoed the integral back
  // unevaluated (e.g. "integrate(exp(sin(x)),x)") - that's not a Stammfunktion, and the
  // integral notation itself already stands for the whole family up to a constant.
  if (isIndefiniteIntegral(sentExpr) && !isIndefiniteIntegral(simplifiedOut)) latexOut = appendArbitraryConstant(latexOut);
  return { raw: simplifiedOut, isError: false, text: simplifiedOut, latex: latexOut, isGraphics: false };
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

// The literal separator giacToLatex's own parser inserts between two "and"-joined
// sub-expressions (see its LOGICAL_WORDS handling) - reused here so a solution clause built
// by hand out of separately-rendered fragments (see formatSolveResultApprox below, which
// can't just hand a mixed "=""≈" string to giacToLatex the way formatSolveResult does, since
// "≈" isn't valid Giac syntax) still joins the same way a clause giacToLatex parsed as one
// piece would.
const AND_LATEX_JOINER = '\\ \\text{and}\\ ';

// Builds one solve() value's display fragment for evaluateApprox() - mirrors the same
// exact-vs-approximate distinction evaluate()/evaluateApprox() already make for a single bare
// value (see EXACT_DECIMAL_TAIL_RE/exactNumberResult above): "=" only when the decimal shown
// is exactly right (an integer, or a fraction whose decimal expansion terminates and matches
// what evalf() gave), "≈" otherwise (a non-terminating fraction, an irrational value like
// sqrt(2), or anything else Giac only evaluated numerically). `exactValue` and `approxValue`
// are the same solution slot read out of solve()'s exact and evalf()'d results respectively
// (see formatSolveResultApprox). A relation (see hasTopLevelRelation) is shown using its own
// evalf()'d form as-is, same as formatSolveResult's exact path does for its un-evalf'd one -
// no "=" or "≈" marker, since the value already says which variable it constrains.
function formatSolveValueFragment(name, exactValue, approxValue) {
  if (hasTopLevelRelation(exactValue)) {
    return { value: approxValue, text: approxValue, latex: giacToLatex(approxValue) };
  }

  const rational = parseExactRational(exactValue);
  const exactDecimal = rational && rational.den !== 1n ? terminatingDecimalString(rational.num, rational.den) : null;
  if (rational && (rational.den === 1n || (exactDecimal && sameNumericValue(exactDecimal, approxValue)))) {
    const value = rational.den === 1n ? exactValue : exactDecimal;
    return { value, text: `${name}=${value}`, latex: giacToLatex(`${name}=${value}`) };
  }

  const nameLatex = giacToLatex(name);
  const valueLatex = giacToLatex(approxValue);
  return {
    value: approxValue,
    text: `${name} ≈ ${approxValue}`,
    latex: nameLatex != null && valueLatex != null ? `${nameLatex} \\approx ${valueLatex}` : null,
  };
}

// evaluateApprox()'s counterpart to formatSolveResult: `exactRaw` (solve()'s un-evalf'd
// result, e.g. "list[32/3]") and `approxRaw` (the same result after evalf(), e.g.
// "list[10.6666666667]") are parsed in lockstep (see parseSolveTuples) so each solution value
// can be labeled "=" or "≈" on its own (see formatSolveValueFragment) rather than always "="
// the way the exact path labels every value. Returns null - meaning: caller falls back to
// formatSolveResult(approxRaw, varNames), the plain "=" labeling - whenever `varNames` is
// null or the two raw strings aren't shaped alike enough to pair up value-for-value.
function formatSolveResultApprox(exactRaw, approxRaw, varNames) {
  if (!varNames) return null;
  const exactTuples = parseSolveTuples(exactRaw, varNames);
  const approxTuples = parseSolveTuples(approxRaw, varNames);
  if (!exactTuples || !approxTuples || exactTuples.length !== approxTuples.length) return null;

  const textClauses = [];
  const latexClauses = [];
  const reinsertTuples = [];
  for (let i = 0; i < exactTuples.length; i++) {
    const suffix = exactTuples.length > 1 ? `_${i + 1}` : '';
    const fragments = varNames.map((name, j) => formatSolveValueFragment(`${name}${suffix}`, exactTuples[i][j], approxTuples[i][j]));
    textClauses.push(fragments.map((f) => f.text).join(' and '));
    latexClauses.push(fragments.every((f) => f.latex != null) ? fragments.map((f) => f.latex).join(AND_LATEX_JOINER) : null);
    reinsertTuples.push(fragments.map((f) => f.value));
  }

  let reinsertRaw;
  if (reinsertTuples.length === 1) {
    reinsertRaw = reinsertTuples[0].length === 1 ? reinsertTuples[0][0] : `[${reinsertTuples[0].join(',')}]`;
  } else if (varNames.length === 1) {
    reinsertRaw = `list[${reinsertTuples.map((values) => values[0]).join(',')}]`;
  }

  return {
    text: textClauses.join('\n'),
    latex: latexClauses.length === 1 ? latexClauses[0] : latexClauses.every(Boolean) ? `\\begin{gathered}${latexClauses.join('\\\\')}\\end{gathered}` : null,
    raw: reinsertRaw !== undefined ? reinsertRaw : approxRaw,
  };
}

// Giac's own caseval() auto-appends "=<preview>" to a non-integer exact numeric result
// (rational or irrational alike) - e.g. "1/3" evaluates to "1/3=0.333333333333" and "sqrt(2)"
// to "sqrt(2)=1.41421356237" - AND, it turns out, to a plain integer once it's too big to
// preview normally: a huge power like 2026^6 gets its own rounded "=6.91570797214e+19", and
// a huge factorial whose float preview overflows gets the useless "=infinity" instead.
// reinsertableValue() above strips this for reinsertion; evaluateApprox() below reuses it as
// a free decimal approximation instead of a second engine round trip; evaluate() decides
// there whether "=" is still literally true or must be shown as "≈" instead (or, for an
// overflowed non-numeric preview like "infinity"/"undef", dropped entirely - see both
// functions' tailMatch handling). The left side is left unconstrained (a plain integer or
// fraction for a rational value, or arbitrary symbolic Giac output like "sqrt(2)" for an
// irrational one) - only the right side is pinned to caseval's own tail shapes (a decimal,
// optionally in scientific notation, or one of its overflow tokens), which a genuine
// equation result (e.g. "x=5" from solve) essentially never matches, keeping false
// positives rare.
const EXACT_DECIMAL_TAIL_RE = /^(.+)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|[+-]?infinity|undef)$/i;

// Evaluate one line of Xcas input as a numeric approximation (bound to Ctrl+Enter, see
// app.js). Returns the same shape as evaluate(), except:
// - the result is always a decimal, never an exact fraction/symbolic form
// - `latex`/`text` are prefixed with "\approx "/"≈ " whenever displaying the result as a
//   decimal actually loses information - i.e. the exact value's decimal expansion doesn't
//   terminate (1/3 -> 0.3333...) or isn't rational to begin with (sqrt(2), pi, ...).
//   1/2 -> 0.5 is exact, so it gets no marker.
export async function evaluateApprox(expr, knownConstants) {
  const normalized = normalizePowerCalls(normalizeNspireMatrices(normalizeAliasCommands(normalizeNcrAlias(wrapBareEquation(expr, knownConstants)))));

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
    const [, exactPart, decimalPart] = tailMatch;
    const rational = parseExactRational(exactPart);
    if (parseDecimal(decimalPart) == null || (rational && rational.den === 1n)) {
      // Either Giac's own preview carries no real information (it overflowed to
      // "infinity"/"undef" for a huge exact value), or it's a plain integer - the
      // plain-integer branch below already gives an equivalent, full-precision
      // scientific-notation preview (via formatApproxSci) once one is actually needed, so
      // Giac's own rounded stand-in would just be redundant. Either way, drop the tail and
      // format `exactPart` itself below instead.
      out = exactPart;
    } else {
      const exactDecimal = rational && terminatingDecimalString(rational.num, rational.den);
      if (exactDecimal) {
        return exactNumberResult(exactDecimal);
      }
      // Doesn't terminate (or isn't a plain rational at all, e.g. sqrt(2)) - Giac's own
      // rounded decimal is the best we can show, so mark it as approximate.
      const decimalSci = formatApproxSci(decimalPart);
      return { raw: decimalPart, isError: false, text: `≈ ${decimalPart}`, latex: `\\approx ${decimalSci ? decimalSci.latex : decimalPart}`, isGraphics: false };
    }
  }

  if (/^-?\d+$/.test(out)) {
    // Plain integer - already exact, nothing to round.
    return exactNumberResult(out);
  }

  // solve()'s own tuple form doesn't say which value is which variable - see the matching
  // comment in evaluate() above (same single-solution `raw` unwrapping applies below).
  const varNames = parseSolveVarList(normalized);
  // desolve()'s own bare solution expression doesn't say which function it's the solution
  // for - see the matching comment in evaluate() above (same "<func>=<solution>" labeling,
  // bare `raw`, applies below).
  const desolveFuncName = parseDesolveFuncName(normalized);

  // Anything else (an equation, list, matrix, complex number, ...) doesn't get Giac's
  // automatic "=decimal" tail, so approximate it explicitly.
  let approxOut = stripTrailingSemicolon(await rawEvalAsync(`evalf(${out})`));
  if (approxOut.startsWith('GIAC_ERROR')) {
    // evalf() failed for some reason - show the exact form rather than an error.
    const solvedExact = formatSolveResult(out, varNames);
    if (solvedExact) {
      return { raw: solvedExact.raw, isError: false, text: solvedExact.text, latex: solvedExact.latex, isGraphics: false };
    }
    const desolvedExact = formatDesolveResult(out, desolveFuncName);
    if (desolvedExact) {
      return { raw: desolvedExact.raw, isError: false, text: desolvedExact.text, latex: desolvedExact.latex, isGraphics: false };
    }
    const latexOut = await fetchLatex(out);
    return { raw: out, isError: false, text: out, latex: latexOut, isGraphics: false };
  }

  const approxUnquoted = stripQuotes(approxOut);
  if (approxUnquoted !== approxOut) {
    return { raw: approxOut, isError: false, text: approxUnquoted, latex: null, isGraphics: false };
  }

  const solvedApprox = formatSolveResultApprox(out, approxOut, varNames) || formatSolveResult(approxOut, varNames);
  if (solvedApprox) {
    return { raw: solvedApprox.raw, isError: false, text: solvedApprox.text, latex: solvedApprox.latex, isGraphics: false };
  }

  const desolvedApprox = formatDesolveResult(approxOut, desolveFuncName);
  if (desolvedApprox) {
    return { raw: desolvedApprox.raw, isError: false, text: desolvedApprox.text, latex: desolvedApprox.latex, isGraphics: false };
  }

  // A bare number is handled without a Giac round-trip - formatApproxSci already has enough
  // to decide and render it. Anything else (complex number, list, matrix, ...) still needs
  // Giac's own latex() as before. approxOut came from evalf(), so it's already inherently a
  // rounded approximation regardless of formatApproxSci's own `rounded` flag - the "≈" prefix
  // below always applies.
  const approxSci = formatApproxSci(approxOut);
  let latexOut = approxSci ? approxSci.latex : await fetchLatex(approxOut);
  // Skip "+C" when Giac couldn't find a closed form and just echoed the integral back
  // unevaluated - see the matching comment in evaluate() above.
  if (isIndefiniteIntegral(normalized) && !isIndefiniteIntegral(out)) latexOut = appendArbitraryConstant(latexOut);
  return {
    raw: approxOut,
    isError: false,
    text: `≈ ${approxOut}`,
    latex: latexOut != null ? `\\approx ${latexOut}` : null,
    isGraphics: false,
  };
}
