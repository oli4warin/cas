// A small, deliberately forgiving giac-syntax -> LaTeX converter used only for the live
// input preview. It runs entirely on the main thread (no round-trip to the Giac worker)
// so it has to tolerate mid-typing input: unmatched parens, dangling operators, empty
// function args, etc. It never throws - worst case it renders less than the final input,
// which is fine since it's replaced on the next keystroke anyway.
//
// This intentionally duplicates (rather than reuses) Giac's own latex(quote(...)) - that
// path needs a fully-parseable expression and a worker round trip, both wrong fits for a
// per-keystroke preview.

const UNARY_PREC = 5; // same as '^', so "-x^2" parses as -(x^2), matching math convention.

// '|' (Giac's restriction/"such that" operator, e.g. "solve(x^2=1|x>0)") binds loosest of
// all, below comparisons - so its right side can itself be a whole "x>0" comparison.
const INFIX_PREC = {
  '|': 0,
  ':=': 1, '=': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '!=': 1, '==': 1,
  '+': 2, '-': 2,
  '*': 3, '/': 3,
  '^': 5,
};
const RIGHT_ASSOC = new Set(['^']);

const GREEK = {
  pi: '\\pi', theta: '\\theta', alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma',
  delta: '\\delta', lambda: '\\lambda', mu: '\\mu', sigma: '\\sigma', phi: '\\phi',
  omega: '\\omega', infinity: '\\infty', inf: '\\infty',
};

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
      const m = /^(\d+\.\d*|\.\d+|\d+)/.exec(s.slice(i));
      if (m) {
        tokens.push({ type: 'num', value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      tokens.push({ type: 'ident', value: m[0] });
      i += m[0].length;
      continue;
    }
    if ("'+-*/^=<>(),!.[]{}|".includes(c)) {
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

  function parseArgList(closeChar) {
    const items = [];
    if (peek() && !(peek().type === 'op' && peek().value === closeChar)) {
      items.push(parseExpression(0));
      while (peek() && peek().type === 'op' && peek().value === ',') {
        next();
        items.push(parseExpression(0));
      }
    }
    let closed = false;
    if (peek() && peek().type === 'op' && peek().value === closeChar) {
      next();
      closed = true;
    }
    return { items, closed };
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
      const inner = parseExpression(0);
      let closed = false;
      if (peek() && peek().type === 'op' && peek().value === ')') {
        next();
        closed = true;
      }
      return { type: 'paren', inner, closed };
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

  return { parseExpression };
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\textbackslash{}').replace(/([{}$&#_%~^])/g, '\\$1');
}

function render(node) {
  if (node == null) return '';
  switch (node.type) {
    case 'num':
      return node.value;
    case 'var': {
      const lname = node.name.toLowerCase();
      const primes = node.primes || '';
      if (GREEK[lname]) return GREEK[lname] + primes;
      return node.name + primes;
    }
    case 'text':
      return `\\text{${escapeText(node.value)}}`;
    case 'neg':
      return `-${render(node.arg)}`;
    case 'postfix':
      return `${render(node.arg)}!`;
    case 'paren':
      return `\\left(${render(node.inner)}\\right)`;
    case 'bracket':
      return `\\left[${node.items.map(render).join(',\\ ')}\\right]`;
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
  if (node.op === '^') return `${renderPowerBase(node.left)}^{${render(node.right)}}`;
  if (node.op === '*') return `${render(node.left)} \\cdot ${render(node.right)}`;
  if (node.op === '*implicit') return `${render(node.left)}${render(node.right)}`;
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
  if (lname === 'exp') return `e^{${a(0)}}`;
  if (lname === 'ln') return `\\ln${primes}\\left(${a(0)}\\right)`;
  if (lname === 'log') return has(1) ? `\\log_{${a(1)}}${primes}\\left(${a(0)}\\right)` : `\\log${primes}\\left(${a(0)}\\right)`;
  if (TRIG[lname]) return `${TRIG[lname]}${primes}\\left(${a(0)}\\right)`;

  if (lname === 'integrate' || lname === 'int') {
    if (has(3)) return `\\int_{${a(2)}}^{${a(3)}} ${a(0)}\\;d${a(1) || 'x'}`;
    if (has(1)) return `\\int ${a(0)}\\;d${a(1) || 'x'}`;
    return `\\int ${a(0)}\\;dx`;
  }

  if (lname === 'diff' || lname === 'derive') {
    const v = a(1) || 'x';
    if (has(2)) return `\\frac{d^{${a(2)}}}{d${v}^{${a(2)}}}\\left(${a(0)}\\right)`;
    return `\\frac{d}{d${v}}\\left(${a(0)}\\right)`;
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

  const label = name.length > 1 ? `\\operatorname{${escapeText(name)}}` : name;
  return `${label}${primes}\\left(${args.map((x) => (x != null ? render(x) : '')).join(',\\ ')}\\right)`;
}

// Converts a (possibly incomplete) giac expression string into LaTeX for live preview.
// Returns '' for blank input and null if something unexpected went wrong.
export function giacToLatex(src) {
  if (!src || !src.trim()) return '';
  try {
    const tokens = tokenize(src);
    const parser = makeParser(tokens);
    const ast = parser.parseExpression(0);
    return render(ast);
  } catch {
    return null;
  }
}
