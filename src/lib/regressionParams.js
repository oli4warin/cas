// Menu config for the "regression" command (see components/regressionMenu.js) - each entry
// is one selectable curve type, naming the `<type>_regression(Xlist,Ylist)` call it builds,
// which evaluateRegressionCall in giac.js recognizes and fits (see regression.js/
// sinRegression.js for the actual math).
export const REGRESSION_TYPES = [
  { name: 'linear_regression', label: 'Linear: y = a·x + b' },
  { name: 'quadratic_regression', label: 'Quadratic: y = a·x² + b·x + c' },
  { name: 'cubic_regression', label: 'Cubic: y = a·x³ + b·x² + c·x + d' },
  { name: 'power_regression', label: 'Power: y = a·x^b' },
  { name: 'exponential_regression', label: 'Exponential: y = a·e^(b·x)' },
  { name: 'logarithmic_regression', label: 'Logarithmic: y = a·ln(x) + b' },
  { name: 'logistic_regression', label: 'Logistic: y = c/(1+a·e^(-b·x))' },
  { name: 'sinusoidal_regression', label: 'Sinusoidal: y = a·sin(b·x+c) + d' },
];

// True when `name` is the bare "regression" command (no arguments yet) - mirrors
// findDistributionMenu's bare-name check (distributionParams.js), opening RegressionMenu
// instead of submitting a call that would just error without its lists/type filled in.
export function isRegressionMenuCommand(name) {
  return typeof name === 'string' && name.trim().toLowerCase() === 'regression';
}
