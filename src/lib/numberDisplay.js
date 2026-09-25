// Shared, engine-independent decimal-number display formatting: parsing a plain number string
// into its significant-digit/exponent form, and rounding it to the "Digits" setting (see the
// settings menu in app.js) for display - as plain decimal, or scientific notation once the
// magnitude needs more digits than that to write out in full. Used by both giac.js's own result
// formatting (see roundForDisplay/roundEmbeddedDecimals there) and giacToLatex.js's live
// input-preview renderer, so it lives in its own module rather than being owned by either -
// giacToLatex.js is imported *by* giac.js and so can't import back from it. Purely a
// display-time setting/formatter: nothing here ever touches a result's underlying raw/copied
// value (see giac.js's own comments on `raw` for why that always stays full precision).

let displayDigits = 6;

export function getDisplayDigits() {
  return displayDigits;
}

export function setDisplayDigits(n) {
  displayDigits = Math.max(1, Math.min(15, Math.trunc(n) || 6));
}

// Parses a plain decimal number string - "4000000", "-0.00000001", or already-scientific like
// "1.2e-06" - into its exact (string/BigInt-only, so never lossy for arbitrarily large/small
// numbers) normalized-scientific decomposition: the signed significant digits and the decimal
// exponent of the leading one. Returns null for anything that isn't a single plain real number
// (an equation, complex number, list, matrix, ...) - those are left to their caller's own
// fallback rendering untouched.
export function parseDecimal(str) {
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

// Renders a rounded (sign,sig,exponent) triple (see parseDecimal/roundSignificantDigits) back
// into a plain decimal/integer string, e.g. ('', '333333', -1) -> "0.333333", ('-', '125', 2)
// -> "-125", ('', '125', 4) -> "125000". Trailing zeros needed to reach the decimal point for a
// large exponent are the only zeros ever added - `sig` itself is already trailing-zero-trimmed
// by roundSignificantDigits, so this never fabricates trailing fractional zeros.
export function sigToPlainDecimal(sign, sig, exponent) {
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${sig}`;
  if (exponent + 1 >= sig.length) return `${sign}${sig}${'0'.repeat(exponent + 1 - sig.length)}`;
  return `${sign}${sig.slice(0, exponent + 1)}.${sig.slice(exponent + 1)}`;
}

// Renders a normalized-scientific mantissa/exponent pair as LaTeX - a mantissa of exactly
// "1"/"-1" drops the "\cdot" (just "10^{6}", not "1 \cdot 10^{6}") since it carries no
// information.
export function sciLatex(mantissa, exponent) {
  if (mantissa === '1') return `10^{${exponent}}`;
  if (mantissa === '-1') return `-10^{${exponent}}`;
  return `${mantissa} \\cdot 10^{${exponent}}`;
}

// Rounds `str` (a plain decimal/integer, or already-scientific form) to the current Digits
// setting's significant figures for *display only* - see displayDigits above for why this never
// touches the value a result is copied/reinserted/saved as. Returns null (meaning: not a single
// plain real number - an equation, list, matrix, complex number, ... - left to the caller's own
// fallback rendering) when `str` isn't one, parseDecimal's own signal for that. Otherwise
// returns { text, latex, rounded }: `text`/`latex` are the same rounded value, formatted as a
// plain decimal or, once the rounded magnitude needs more integer digits/leading zeros than
// the Digits setting shows, in scientific notation (latex via sciLatex, text as a plain
// "1.23457e+19" fallback); `rounded` says whether displaying it at this precision actually
// dropped real (nonzero) digits, so callers can show "≈" instead of "=" once it did.
export function roundForDisplay(str) {
  const parsed = parseDecimal(str);
  if (!parsed) return null;
  let { sign, sig, exponent } = parsed;
  const rounded = sig.length > displayDigits;
  ({ sig, exponent } = roundSignificantDigits(sig, exponent, displayDigits));
  if (exponent >= displayDigits || exponent <= -(displayDigits + 1)) {
    const mantissa = sign + sig[0] + (sig.length > 1 ? `.${sig.slice(1)}` : '');
    return { text: `${mantissa}e${exponent >= 0 ? '+' : ''}${exponent}`, latex: sciLatex(mantissa, exponent), rounded };
  }
  const text = sigToPlainDecimal(sign, sig, exponent);
  return { text, latex: text, rounded };
}
