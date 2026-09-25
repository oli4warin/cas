// A small, deliberately forgiving giac-syntax -> LaTeX converter used only for the live
// input preview. It runs entirely on the main thread (no round-trip to the Giac worker)
// so it has to tolerate mid-typing input: unmatched parens, dangling operators, empty
// function args, etc. It never throws - worst case it renders less than the final input,
// which is fine since it's replaced on the next keystroke anyway.
//
// This intentionally duplicates (rather than reuses) Giac's own latex(quote(...)) - that
// path needs a fully-parseable expression and a worker round trip, both wrong fits for a
// per-keystroke preview.

import { XCAS_COMMANDS, XCAS_COMMAND_ALIASES, expandInverseTrigAliases } from './xcasCommands.js';
import { roundForDisplay } from './numberDisplay.js';

const UNARY_PREC = 7; // same as '^', so "-x^2" parses as -(x^2), matching math convention.

// '|' (Giac's restriction/"such that" operator, e.g. "solve(x^2=1|x>0)") binds loosest of
// all, below the logical connectives, which in turn bind looser than comparisons - so
// "x=1 and y=2" parses as "(x=1) and (y=2)", and "or" binds looser still than "and" (so
// "a=1 or b=2 and c=3" reads as "a=1 or (b=2 and c=3)"), matching everyday math convention.
const INFIX_PREC = {
  '|': 0,
  or: 1,
  and: 2,
  ':=': 3, '=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '!=': 3, '==': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5,
  '^': 7,
};
const RIGHT_ASSOC = new Set(['^']);

// Giac's word-shaped infix boolean operators - tokenized as ops (see tokenize) rather than
// identifiers so they don't fall into implicit multiplication (e.g. "1 and y" turning into
// "1 * and * y") and instead render as spaced-out \text{...} words (see renderBin).
const LOGICAL_WORDS = new Set(['and', 'or', 'xor']);

const GREEK = {
  pi: '\\pi', theta: '\\theta', alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma',
  delta: '\\delta', lambda: '\\lambda', mu: '\\mu', sigma: '\\sigma', phi: '\\varphi',
  omega: '\\omega', infinity: '\\infty', inf: '\\infty', epsilon: '\\varepsilon',
	kappa: '\\kappa', nu: '\\nu', tau: '\\tau', psi: '\\psi', chi: '\\chi',
  // MathJax's TeX input only implements the plain (breakable) "\hspace{}", not the starred
  // "\hspace*{}" (an ordinary LaTeX primitive it never defines) - using the starred form here
  // throws "Missing dimension or its units for \hspace" instead of rendering anything.
  // Braced into one group (matching fixPauSymbol's own wrapping in lib/giac.js) so a power
  // typed right after it (e.g. "pau^2", from piToTau's pauMode-power conversion) attaches to
  // the whole symbol via renderPowerBase below, not just to its trailing "\tau" token.
  pau: '\\tau\\hspace{-0.31em}\\pi',
};

// The literal "paumode"/"pimode"/"taumode" easter-egg commands (see app.js's submit()) aren't
// real Giac identifiers, so left alone they'd render as a plain italic variable name (each
// letter slanted, run together) like any other unrecognized multi-letter identifier - a
// command name should read as upright text instead, same as a recognized XCAS_COMMANDS name
// (see operatorLabel below).
const MODE_COMMANDS = new Set(['paumode', 'pimode', 'taumode']);

const TRIG = {
  sin: '\\sin', cos: '\\cos', tan: '\\tan',
  asin: '\\arcsin', acos: '\\arccos', atan: '\\arctan',
  sinh: '\\sinh', cosh: '\\cosh', tanh: '\\tanh',
};

function tokenize(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '==' || two === ':=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      // The optional "e[+-]?digits" suffix is Giac's own scientific-notation spelling (e.g.
      // "1.23e+15") - it only matches with at least one exponent digit present, so a bare
      // trailing "e" (still-typing "2e", or "2ex" meaning "2*ex") is left as its own identifier
      // token exactly as before (see the 'e'-as-Euler's-constant case in render below).
      const m = /^(\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i));
      if (m) {
        tokens.push({ type: 'num', value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      const word = m[0];
      const lword = word.toLowerCase();
      if (LOGICAL_WORDS.has(lword)) {
        tokens.push({ type: 'op', value: lword });
      } else {
        tokens.push({ type: 'ident', value: word });
      }
      i += word.length;
      continue;
    }
    if ("'+-*/^=<>(),;!.[]{}|".includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    tokens.push({ type: 'unknown', value: c });
    i++;
  }
  return tokens;
}

function canStartPrimary(tok) {
  if (!tok) return false;
  if (tok.type === 'num' || tok.type === 'ident') return true;
  return tok.value === '(' || tok.value === '[' || tok.value === '{';
}

function makeParser(tokens) {
  let pos = 0;
  const peek = () => tokens[pos] ?? null;
  const next = () => tokens[pos++];

  function parseExpression(minPrec) {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (!tok) break;

      if (tok.type === 'op' && tok.value in INFIX_PREC) {
        const prec = INFIX_PREC[tok.value];
        if (prec < minPrec) break;
        next();
        const nextMinPrec = RIGHT_ASSOC.has(tok.value) ? prec : prec + 1;
        const right = parseExpression(nextMinPrec);
        left = { type: 'bin', op: tok.value, left, right };
        continue;
      }

      // Implicit multiplication: "2x", "3(x+1)", "(x+1)(x-1)".
      if (canStartPrimary(tok) && left != null) {
        const prec = INFIX_PREC['*'];
        if (prec < minPrec) break;
        const right = parseExpression(prec + 1);
        left = { type: 'bin', op: '*implicit', left, right };
        continue;
      }

      break;
    }
    return left;
  }

  function parseUnary() {
    const tok = peek();
    if (tok && tok.type === 'op' && tok.value === '-') {
      next();
      return { type: 'neg', arg: parseExpression(UNARY_PREC) };
    }
    if (tok && tok.type === 'op' && tok.value === '+') {
      next();
      return parseExpression(UNARY_PREC);
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let node = parsePrimary();
    while (node && peek() && peek().type === 'op' && peek().value === '!') {
      next();
      node = { type: 'postfix', op: '!', arg: node };
    }
    return node;
  }

  // Parses a comma-separated list up to `closeChar`. A ";" at this level (nspire's
  // shorthand for a matrix literal, e.g. "[1,2;3,4]") starts a new row instead of a plain
  // item - when at least one was seen, each row is wrapped as its own bracket node so the
  // preview nests exactly like Giac's own "[[1,2],[3,4]]" form (see normalizeNspireMatrices
  // in lib/giac.js, which expands the same shorthand before the real expression is
  // evaluated). A stray trailing ";" right before `closeChar` is dropped rather than
  // producing a bogus empty last row.
  function parseArgList(closeChar) {
    const rows = [[]];
    if (peek() && !(peek().type === 'op' && peek().value === closeChar)) {
      rows[rows.length - 1].push(parseExpression(0));
      for (;;) {
        const tok = peek();
        if (tok && tok.type === 'op' && tok.value === ',') {
          next();
          rows[rows.length - 1].push(parseExpression(0));
          continue;
        }
        if (tok && tok.type === 'op' && tok.value === ';') {
          next();
          rows.push([]);
          if (peek() && !(peek().type === 'op' && (peek().value === closeChar || peek().value === ';'))) {
            rows[rows.length - 1].push(parseExpression(0));
          }
          continue;
        }
        break;
      }
    }
    let closed = false;
    if (peek() && peek().type === 'op' && peek().value === closeChar) {
      next();
      closed = true;
    }
    if (rows.length > 1) {
      const items = rows.filter((row) => row.length > 0).map((row) => ({ type: 'bracket', items: row, closed: true }));
      return { items, closed };
    }
    return { items: rows[0], closed };
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) return null;

    if (tok.type === 'num') {
      next();
      return { type: 'num', value: tok.value };
    }

    if (tok.type === 'ident') {
      next();
      // A trailing "'" (or several) is derivative notation, e.g. "f'(x)" or "f''(x)".
      let primes = '';
      while (peek() && peek().type === 'op' && peek().value === "'") {
        next();
        primes += "'";
      }
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next();
        const { items, closed } = parseArgList(')');
        return { type: 'call', name: tok.value, primes, args: items, closed };
      }
      return { type: 'var', name: tok.value, primes };
    }

    if (tok.type === 'op' && tok.value === '(') {
      next();
      // A single expression is plain grouping ("paren" - stripRedundantParen below only
      // unwraps this shape), but Giac also uses "(...)" for a literal comma-separated tuple/
      // sequence (e.g. "(x,f(x))|x=..." - a point paired with its substituted value), which
      // needs the same comma-list handling parseArgList already gives "[...]"/"{...}".
      const { items, closed } = parseArgList(')');
      if (items.length !== 1) return { type: 'tuple', items, closed };
      return { type: 'paren', inner: items[0], closed };
    }

    if (tok.type === 'op' && tok.value === '[') {
      next();
      const { items, closed } = parseArgList(']');
      return { type: 'bracket', items, closed };
    }

    if (tok.type === 'op' && tok.value === '{') {
      next();
      const { items, closed } = parseArgList('}');
      return { type: 'brace', items, closed };
    }

    // Stray closer / comma / unknown char at a primary position: skip it and keep going
    // rather than aborting the whole preview over one bad character.
    next();
    if (tok.type === 'op' && (tok.value === ')' || tok.value === ']' || tok.value === '}' || tok.value === ',')) {
      return parsePrimary();
    }
    return { type: 'text', value: tok.value };
  }

  return {
    parseExpression,
    peekComma: () => { const tok = peek(); return !!tok && tok.type === 'op' && tok.value === ','; },
    nextToken: next,
  };
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([{}$&#_%~^])/g, '\\$1');
}

// A bracket-of-brackets with every row the same width is exactly Giac's own definition of
// a matrix (see normalizeNspireMatrices in lib/giac.js, which produces this same nested
// shape from both "[[1,2],[3,4]]" and the nspire "[1,2;3,4]" shorthand) - rendered as a
// grid (see renderMatrix) to match what Giac's own latex() shows for the evaluated result,
// rather than as a confusing list-of-lists.
function isMatrixNode(node) {
  if (node.type !== 'bracket' || node.items.length === 0) return false;
  if (!node.items.every((row) => row && row.type === 'bracket' && row.items.length > 0)) return false;
  const width = node.items[0].items.length;
  return node.items.every((row) => row.items.length === width);
}

function renderMatrix(node) {
  const cols = node.items[0].items.length;
  const body = node.items.map((row) => row.items.map(render).join(' & ')).join(' \\\\\n');
  return `\\left(\\begin{array}{${'c'.repeat(cols)}}\n${body}\n\\end{array}\\right)`;
}

// MathJax's "_" only pulls in a single following token as the subscript, so an unbraced
// multi-character subscript like "x_10" renders as x with subscript "1" followed by a
// literal "0" instead of "x₁₀" (e.g. solve()'s per-solution suffix, see parseSolveSolutions
// in lib/giac.js). Brace the part after the first "_" so it's read as one subscript group
// regardless of length; any further underscores inside it are escaped so they stay literal
// rather than starting a nested subscript.
function renderVarName(name) {
  const idx = name.indexOf('_');
  if (idx === -1) return name;
  const base = name.slice(0, idx);
  const sub = name.slice(idx + 1).replace(/_/g, '\\_');
  return `${base}_{${sub}}`;
}

// "_" has catcode "subscript" throughout MathJax's TeX input (that's fixed at tokenization,
// not toggled by mode-switching macros like \text{} - wrapping in \text{} alone does NOT
// stop "binomial_cdf" from starting a subscript at the "_"), so the only way to get a
// literal underscore is to escape it. Safe to escape blindly: the tokenizer only ever
// produces identifiers made of [A-Za-z0-9_].
function operatorLabel(name) {
  return name.length > 1 ? `\\operatorname{${name.replace(/_/g, '\\_')}}` : name;
}

function render(node) {
  if (node == null) return '';
  switch (node.type) {
    case 'num': {
      // Rendered verbatim as typed (preserving e.g. a trailing "1.50"'s zero, still being
      // typed towards something longer) unless it already has more significant digits than
      // the Digits setting shows for a computed result (see roundForDisplay in
      // numberDisplay.js) - a pasted or substituted value (e.g. "(x,f(x))|x=<75-digit root>")
      // shouldn't dump every digit into the preview when the actual result wouldn't either.
      // A literal already in Giac's own scientific notation (e.g. "1.23e+15") always goes
      // through roundForDisplay regardless, since a bare "e" in raw LaTeX would otherwise be
      // read as Euler's constant rather than an exponent (same reason giac.js's own
      // fixScientificNotation exists for computed results) - roundForDisplay's own latex
      // always renders it correctly via "\cdot 10^{}", rounded or not.
      const disp = roundForDisplay(node.value);
      return disp && (disp.rounded || /e/i.test(node.value)) ? disp.latex : node.value;
    }
    case 'var': {
      const lname = node.name.toLowerCase();
      const primes = node.primes || '';
      if (GREEK[lname]) return GREEK[lname] + primes;
      if (MODE_COMMANDS.has(lname)) return operatorLabel(node.name) + primes;
      // Euler's constant is set upright ("\mathrm{e}"), same convention as Giac's own
      // latex() (see fixEulerConstant in lib/giac.js) - distinguishes it from an italic
      // variable, even though Giac itself never actually lets "e" be one (a bare "e" always
      // evaluates to exp(1)).
      if (lname === 'e') return '\\mathrm{e}' + primes;
      // The imaginary unit is set upright too, same convention as Giac's own latex() (see
      // fixImaginaryUnit in lib/giac.js). Checked case-sensitively (unlike "e" above) because
      // Giac itself is case-sensitive here: "i" is always the imaginary unit, but "I" is an
      // ordinary, independent free variable (confirmed against the actual engine) - so only
      // a literal lowercase "i" should render as the constant.
      if (node.name === 'i') return '\\mathrm{i}' + primes;
      // A known command name (or one of its aliases, e.g. "normal_cdf" for "normald_cdf" -
      // see XCAS_COMMAND_ALIASES) typed without its "(" yet is still a function reference,
      // not a subscripted variable - render it the same way a finished call would (see
      // renderCall's fallback below) so the \operatorname{} styling and underscore-escaping
      // apply as soon as the name is recognized, not only once "(" appears.
      if (XCAS_COMMANDS[lname] || XCAS_COMMAND_ALIASES[lname]) return operatorLabel(node.name) + primes;
      // A greek letter with a solve()-style solution subscript (e.g. "lambda_1", see
      // parseSolveSolutions in lib/giac.js) still needs its base rendered as the greek
      // command - the plain lname check above only matches the unsubscripted name.
      const idx = node.name.indexOf('_');
      if (idx !== -1) {
        const base = node.name.slice(0, idx).toLowerCase();
        if (GREEK[base]) {
          const sub = node.name.slice(idx + 1).replace(/_/g, '\\_');
          return `${GREEK[base]}_{${sub}}` + primes;
        }
      }
      return renderVarName(node.name) + primes;
    }
    case 'text':
      return `\\text{${escapeText(node.value)}}`;
    case 'neg':
      return `-${render(node.arg)}`;
    case 'postfix':
      return `${render(node.arg)}!`;
    case 'paren':
      return `\\left(${render(node.inner)}\\right)`;
    case 'tuple':
      return `\\left(${node.items.map(render).join(',\\ ')}\\right)`;
    case 'bracket':
      return isMatrixNode(node) ? renderMatrix(node) : `\\left[${node.items.map(render).join(',\\ ')}\\right]`;
    case 'brace':
      return `\\left\\{${node.items.map(render).join(',\\ ')}\\right\\}`;
    case 'call':
      return renderCall(node);
    case 'bin':
      return renderBin(node);
    default:
      return '';
  }
}

function renderPowerBase(node) {
  if (node && (node.type === 'bin' || node.type === 'neg')) {
    return `\\left(${render(node)}\\right)`;
  }
  return render(node);
}

// A user-typed paren around a whole numerator/denominator (e.g. "(2*x+3)/5") is needed
// for Giac to parse the precedence correctly, but once it's inside \frac{}{} the fraction
// bar already groups it visually - showing \left(...\right) there too is just clutter.
function stripRedundantParen(node) {
  while (node && node.type === 'paren') node = node.inner;
  return node;
}

const BIN_LATEX = { '+': '+', '-': '-', ':=': ':=', '=': '=', '<': '<', '>': '>', '<=': '\\le', '>=': '\\ge', '!=': '\\ne', '==': '=' };

function renderBin(node) {
  if (node.op === '|') {
    return `\\left.${render(node.left)}\\right|_{${render(node.right)}}`;
  }
  if (node.op === '/') {
    return `\\frac{${render(stripRedundantParen(node.left))}}{${render(stripRedundantParen(node.right))}}`;
  }
  // A user-typed paren around the whole exponent (e.g. "x^(10+a)") is needed for Giac to
  // parse the precedence correctly, but the "^{...}" braces already group it visually -
  // same reasoning as stripRedundantParen's use in the '/' case above.
  if (node.op === '^') return `${renderPowerBase(node.left)}^{${render(stripRedundantParen(node.right))}}`;
  if (node.op === '*') return `${render(node.left)} \\cdot ${render(node.right)}`;
  if (node.op === '*implicit') return `${render(node.left)}${render(node.right)}`;
  // Word operators ("and"/"or"/"xor") need an explicit \text{} (plain math-mode letters
  // would space and slant like a product of variables, e.g. "a n d") and explicit \ spacing
  // (bare spaces in math-mode source are collapsed, so without it the word would run into
  // its operands with no visible gap).
  if (LOGICAL_WORDS.has(node.op)) return `${render(node.left)}\\ \\text{${node.op}}\\ ${render(node.right)}`;
  const sym = BIN_LATEX[node.op] ?? node.op;
  return `${render(node.left)} ${sym} ${render(node.right)}`;
}

function renderCall(node) {
  const name = node.name;
  const lname = name.toLowerCase();
  const args = node.args;
  const primes = node.primes || '';
  const a = (i) => (args[i] != null ? render(args[i]) : '');
  const has = (i) => args.length > i;

  if (lname === 'sqrt') return `\\sqrt{${a(0)}}`;
  if (lname === 'abs') return `\\left|${a(0)}\\right|`;
  // Complex conjugate - the standard overline notation, matching what Giac's own latex()
  // already renders for conj() whenever it survives evaluation unresolved (e.g. conj(f(z)) for
  // an undefined f - confirmed against the real engine). This syntax-only renderer needs its
  // own case for it too since it never asks the engine to simplify anything - a bare "conj(z)"
  // typed into a live preview (the main input, or a 'complexSystem' plot row's own field - see
  // components/plotPanel.js) never reaches the engine at all before being shown.
  if (lname === 'conj') return `\\overline{${a(0)}}`;
  if (lname === 'exp') return `\\mathrm{e}^{${a(0)}}`;
  if (lname === 'ln') return `\\ln${primes}\\left(${a(0)}\\right)`;
  if (lname === 'log' || lname === 'logb') return has(1) ? `\\log_{${a(1)}}${primes}\\left(${a(0)}\\right)` : `\\log${primes}\\left(${a(0)}\\right)`;
  if (TRIG[lname]) return `${TRIG[lname]}${primes}\\left(${a(0)}\\right)`;

  if (lname === 'integrate' || lname === 'int') {
    if (has(3)) return `\\int_{${a(2)}}^{${a(3)}} ${a(0)}\\;\\mathrm{d}${a(1) || 'x'}`;
    if (has(1)) return `\\int ${a(0)}\\;\\mathrm{d}${a(1) || 'x'}`;
    return `\\int ${a(0)}\\;\\mathrm{d}x`;
  }

  if (lname === 'diff' || lname === 'derive') {
    const v = a(1) || 'x';
    if (has(2)) return `\\frac{\\mathrm{d}^{${a(2)}}}{\\mathrm{d}${v}^{${a(2)}}}\\left(${a(0)}\\right)`;
    return `\\frac{\\mathrm{d}}{\\mathrm{d}${v}}\\left(${a(0)}\\right)`;
  }

  if (lname === 'limit') {
    if (has(2)) return `\\lim_{${a(1)}\\to ${a(2)}} ${a(0)}`;
    return `\\lim ${a(0)}`;
  }

  if (lname === 'sum') {
    if (has(3)) return `\\sum_{${a(1)}=${a(2)}}^{${a(3)}} ${a(0)}`;
    return `\\sum ${a(0)}`;
  }

  if (lname === 'product') {
    if (has(3)) return `\\prod_{${a(1)}=${a(2)}}^{${a(3)}} ${a(0)}`;
    return `\\prod ${a(0)}`;
  }

  // 2-argument binomial(n,k)/comb(n,k)/ncr(n,k) is the binomial coefficient "n choose k" -
  // the 3-argument form, binomial(n,k,p), is the binomial distribution's pmf instead and
  // falls through to the generic \operatorname rendering below.
  if ((lname === 'binomial' || lname === 'comb' || lname === 'ncr') && has(1) && !has(2)) {
    return `\\binom{${a(0)}}{${a(1)}}`;
  }

  return `${operatorLabel(name)}${primes}\\left(${args.map((x) => (x != null ? render(x) : '')).join(',\\ ')}\\right)`;
}

// Converts a (possibly incomplete) giac expression string into LaTeX for live preview.
// Returns '' for blank input and null if something unexpected went wrong.
export function giacToLatex(src) {
  if (!src || !src.trim()) return '';
  try {
    // "sin-1(x)"/"sin^-1(x)"/"sin^(-1)(x)" -> "asin(x)" etc, same rewrite giac.js applies
    // before evaluation (see normalizeInverseTrigAliases there) - done here too, ahead of
    // tokenizing, so the preview renders the \arcsin glyph (see TRIG below) for these calculator-
    // familiar spellings instead of the tokenizer splitting them into "sin", "-", "1", ...
    const tokens = tokenize(expandInverseTrigAliases(src));
    const parser = makeParser(tokens);
    // Top level allows comma-separated sequences too, e.g. "a,b:=[1,2]" or "1,2,3" -
    // parseExpression() alone stops at the first comma since ',' isn't an infix operator.
    const parts = [parser.parseExpression(0)];
    while (parser.peekComma()) {
      parser.nextToken();
      parts.push(parser.parseExpression(0));
    }
    return parts.map(render).join(',\\ ');
  } catch {
    return null;
  }
}

// Renders several already-split lines (e.g. a system of equations typed one per line - see
// historyEntry.js's own input rendering and the plot panel's 'system' row) as one LaTeX
// string: a single line just gets giacToLatex's own single-expression rendering, but two or
// more are stacked in a `gathered` block rather than joined into running text, so each keeps
// its own line the way it was typed. Falls back to '' (not a partial render) if any single
// line fails to convert, same as giacToLatex itself does for its blank/error case.
export function linesToGatheredLatex(lines) {
  if (lines.length === 1) return giacToLatex(lines[0]) || '';
  const rendered = lines.map((line) => giacToLatex(line));
  return rendered.every(Boolean) ? `\\begin{gathered}${rendered.join('\\\\')}\\end{gathered}` : '';
}
