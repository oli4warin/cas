// Interface translations. The app's source language is English; `t()` looks the English text
// itself up in the active locale's dictionary (see i18n.de.js) and falls back to it unchanged
// when there's no entry - so call sites stay readable, and a string nobody has translated yet
// simply shows up in English instead of as a missing key.
//
// The only other locale is Swiss Standard German, used whenever the browser's preferred
// language is any German variant (de, de-CH, de-DE, de-AT, ...). "?lang=en"/"?lang=de" in the
// URL overrides the browser setting, mainly for trying the other one out.
//
// Only this app's own text goes through here. What the CAS engine itself prints (Giac's own
// error messages) and what the user types (command names like solve/diff) stay as they are.

import { DE } from './i18n.de.js';

function detectLocale() {
  try {
    const forced = new URLSearchParams(window.location.search).get('lang');
    if (forced === 'de' || forced === 'en') return forced;
    const preferred = navigator.languages?.[0] ?? navigator.language ?? 'en';
    return /^de\b/i.test(preferred) ? 'de' : 'en';
  } catch {
    return 'en'; // no window/navigator (e.g. a module imported outside the browser)
  }
}

export const LOCALE = detectLocale();

// Document language, for index.html's <html lang> - Swiss rather than plain "de" since the
// German text is written the Swiss way (no "ß").
export const HTML_LANG = LOCALE === 'de' ? 'de-CH' : 'en';

// Translates `text`, then fills in any {placeholders} from `params`:
//   t('saved to {name}', { name: 'a' })
export function t(text, params) {
  const translated = (LOCALE === 'de' && DE[text]) || text;
  if (!params) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match));
}
