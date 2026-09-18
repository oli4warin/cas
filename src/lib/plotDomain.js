// Parses a domain restriction attached to a plot function's expression via a top-level "|",
// e.g. "sin(x)|0<x<7" (plot sin(x) only for x in (0,7)) or "1/x|x>0". Mirrors the "|"
// restriction syntax already accepted for bare equations (see wrapBareEquation in giac.js),
// but for a plotted curve the restriction doesn't filter a result list - it masks the curve:
// it's compiled into a when(condition, expr, undef) wrapper, so Giac itself returns "undef"
// outside the domain and the existing NaN-as-gap handling in plotSample.js draws the curve
// with a gap there, instead of clipping the plot's visible x-range.

function findTopLevelPipeIndex(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '|' && depth === 0) return i;
  }
  return -1;
}

// Splits `s` on a keyword (e.g. "and") only where the match is a whole word sitting outside
// any ()/[]/{} nesting - same idea as giac.js's splitTopLevelKeyword.
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

// Rewrites a chained comparison like "0<x<7" or "7>=x>0" (two relational operators sharing
// the middle operand) into an explicit "and" of two clauses - Giac, like most languages,
// would otherwise parse "0<x<7" left-to-right as "(0<x)<7" instead of the interval this
// shorthand is meant to express. Direction-agnostic on purpose: "7>x>0" and "0<x<7" both
// become "(lhs)op1 x and x op2(rhs)", which is correct either way since the two relations are
// just being split apart, not reordered.
const CHAINED_RE = /^\s*([^<>=]+?)\s*(<=|<|>=|>)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(<=|<|>=|>)\s*([^<>=]+?)\s*$/;
function expandChainedComparison(clause) {
  const m = CHAINED_RE.exec(clause);
  if (!m) return clause;
  const [, lo, op1, varName, op2, hi] = m;
  return `(${lo})${op1}${varName} and ${varName}${op2}(${hi})`;
}

// Splits a plot expression like "sin(x)|0<x<7" into its bare expression and a Giac-ready
// boolean condition ("(0)<x and x<(7)"), or returns the expression unchanged with a null
// condition when there's no top-level "|". Multiple conditions can already be "and"-joined by
// hand (e.g. "1/(x-2)|x>0 and x<5"); each clause is independently expanded for chaining.
export function splitDomainRestriction(rawExpr) {
  const pipeIdx = findTopLevelPipeIndex(rawExpr);
  if (pipeIdx === -1) return { expr: rawExpr, condition: null };
  const expr = rawExpr.slice(0, pipeIdx);
  const condRaw = rawExpr.slice(pipeIdx + 1).trim();
  if (!condRaw) return { expr, condition: null };
  const clauses = splitTopLevelKeyword(condRaw, 'and').map((c) => expandChainedComparison(c.trim()));
  return { expr, condition: clauses.join(' and ') };
}

// Wraps a Giac expression so it evaluates to "undef" wherever `condition` is false, leaving
// it untouched when there's no restriction.
export function applyDomainRestriction(expr, condition) {
  return condition ? `when(${condition},(${expr}),undef)` : expr;
}
