// The full Giac/Xcas command set offered by input tab completion (see tryCompleteWord in
// app.js) - much broader than the handful curated in components/functionsMenu.js. Keys are
// matched case-insensitively against whatever the user is typing; values are short
// descriptions shown as each completion candidate's tooltip.
export const XCAS_COMMANDS = {
  // Arithmetic & number theory
  abs: 'absolute value',
  gcd: 'greatest common divisor',
  lcm: 'least common multiple',
  irem: 'remainder of integer division',
  iquo: 'quotient of integer division',
  isprime: 'primality test',
  ifactor: 'prime factorization',
  divisors: 'list of divisors',
  euler: "Euler's totient function",
  nextprime: 'smallest prime greater than n',
  prevprime: 'largest prime less than n',
  floor: 'round down',
  ceil: 'round up',
  round: 'round to n decimals',
  trunc: 'truncate to an integer',
  sign: 'sign of a number',
  mod: 'modulo',
  powmod: 'modular exponentiation',
  sqrt: 'square root',
  exp: 'exponential function',
  ln: 'natural logarithm',
  log: 'logarithm',
  log10: 'base-10 logarithm',

  // Algebra
  solve: 'solve an equation',
  csolve: 'solve an equation over the complexes',
  fsolve: 'numerically solve an equation',
  linsolve: 'solve a linear system',
  factor: 'factor an expression',
  expand: 'expand an expression',
  simplify: 'simplify an expression',
  normal: 'put an expression in normal form',
  partfrac: 'partial fraction decomposition',
  subst: 'substitute a value',
  collect: 'collect terms by a variable',
  coeff: 'coefficient of a term',
  degree: 'degree of a polynomial',
  proot: 'roots of a polynomial',
  quo: 'polynomial quotient',
  rem: 'polynomial remainder',
  resultant: 'resultant of two polynomials',

  // Trigonometry
  sin: 'sine',
  cos: 'cosine',
  tan: 'tangent',
  asin: 'arcsine',
  acos: 'arccosine',
  atan: 'arctangent',
  sinh: 'hyperbolic sine',
  cosh: 'hyperbolic cosine',
  tanh: 'hyperbolic tangent',
  asinh: 'inverse hyperbolic sine',
  acosh: 'inverse hyperbolic cosine',
  atanh: 'inverse hyperbolic tangent',
  cot: 'cotangent',

  // Calculus
  diff: 'derivative',
  integrate: 'antiderivative / definite integral',
  limit: 'limit',
  series: 'series expansion',
  taylor: 'Taylor series',
  sum: 'sum of a sequence',
  product: 'product of a sequence',
  fMax: 'function maximum',
  fMin: 'function minimum',
  desolve: 'solve a differential equation',

  // Linear algebra
  det: 'determinant',
  inv: 'matrix inverse',
  transpose: 'matrix transpose',
  rank: 'matrix rank',
  identity: 'identity matrix',
  matrix: 'construct a matrix',
  eigenvals: 'eigenvalues',
  eigenvects: 'eigenvectors',
  ker: 'kernel (null space)',
  cross: 'cross product',
  dot: 'dot product',
  norm: 'vector/matrix norm',

  // Statistics & probability
  mean: 'arithmetic mean',
  median: 'median',
  stddev: 'standard deviation',
  variance: 'variance',
  factorial: 'n!',
  nCr: 'combinations (n choose k), alias of comb/binomial',
  perm: 'permutations',
  randvector: 'random vector',
  randnorm: 'random normal sample',

  // Statistics & probability - distributions (each <dist>_cdf is the cumulative
  // distribution function, each <dist>_icdf its inverse; the bare name is the
  // density/pmf, except binomial(n,k) which is the binomial coefficient (n choose k) -
  // pass a third argument, binomial(n,k,p), to get the binomial distribution's pmf)
  binomial: 'binomial coefficient (n choose k); or binomial distribution pmf with a 3rd arg',
  binomial_cdf: 'binomial distribution cumulative distribution function',
  binomial_icdf: 'binomial distribution inverse CDF',
  negbinomial: 'negative binomial distribution pmf',
  negbinomial_cdf: 'negative binomial cumulative distribution function',
  negbinomial_icdf: 'negative binomial inverse CDF',
  poisson: 'Poisson distribution pmf',
  poisson_cdf: 'Poisson cumulative distribution function',
  poisson_icdf: 'Poisson inverse CDF',
  geometric: 'geometric distribution pmf',
  geometric_cdf: 'geometric cumulative distribution function',
  geometric_icdf: 'geometric inverse CDF',
  normald: 'normal distribution density (pdf)',
  normald_cdf: 'normal cumulative distribution function',
  normald_icdf: 'normal inverse CDF (quantile)',
  student: "Student's t-distribution density",
  student_cdf: "Student's t cumulative distribution function",
  student_icdf: "Student's t inverse CDF",
  chisquare: 'chi-square distribution density',
  chisquare_cdf: 'chi-square cumulative distribution function',
  chisquare_icdf: 'chi-square inverse CDF',
  fisher: 'Fisher-Snédécor (F) distribution density',
  fisher_cdf: 'Fisher-Snédécor cumulative distribution function',
  fisher_icdf: 'Fisher-Snédécor inverse CDF',
  exponentiald: 'exponential distribution density',
  exponentiald_cdf: 'exponential cumulative distribution function',
  exponentiald_icdf: 'exponential inverse CDF',
  gammad: 'gamma distribution density',
  gammad_cdf: 'gamma cumulative distribution function',
  gammad_icdf: 'gamma inverse CDF',
  betad: 'beta distribution density',
  betad_cdf: 'beta cumulative distribution function',
  betad_icdf: 'beta inverse CDF',
  cauchyd: 'Cauchy distribution density',
  cauchyd_cdf: 'Cauchy cumulative distribution function',
  cauchyd_icdf: 'Cauchy inverse CDF',
  weibull: 'Weibull distribution density',
  weibull_cdf: 'Weibull cumulative distribution function',
  weibull_icdf: 'Weibull inverse CDF',
  uniformd: 'continuous uniform distribution density',
  uniformd_cdf: 'uniform cumulative distribution function',
  uniformd_icdf: 'uniform inverse CDF',

  // Complex numbers
  re: 'real part',
  im: 'imaginary part',
  conj: 'complex conjugate',
  arg: 'complex argument',

  // Lists & sequences
  seq: 'build a sequence',
  sort: 'sort a list',
  size: 'size of a list/vector',
  append: 'append an element',
  reverse: 'reverse a list',
  makelist: 'build a list from a formula',

  // Programming
  purge: 'delete a variable/function definition',
  assume: 'assume a property of a variable',
  piecewise: 'piecewise-defined expression',
  when: 'conditional expression',
};

// Alternate, calculator-familiar spellings that evaluate identically to a command above (see
// normalizeAliasCommands in giac.js, which rewrites any of these to their canonical name
// before an expression reaches the engine) but are deliberately kept out of XCAS_COMMANDS so
// they don't clutter tab completion with near-duplicate entries - only the canonical spelling
// is offered there. Also consulted by giacToLatex.js so a bare alias typed before its "("
// still renders as an operator name (see operatorLabel) rather than as a subscripted variable,
// and by findDistributionMenu (distributionParams.js) so a bare alias still opens that
// command's parameter menu the same way its canonical name does.
export const XCAS_COMMAND_ALIASES = {
  normcdf: 'normald_cdf',
  normalcdf: 'normald_cdf',
  normal_cdf: 'normald_cdf',
  binomcdf: 'binomial_cdf',
};
