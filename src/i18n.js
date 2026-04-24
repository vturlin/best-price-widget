/**
 * i18n runtime — all-in-bundle variant.
 *
 * All 20 locale dictionaries are bundled into widget.js directly. No
 * runtime fetch, no CORS, no latency. Cost: ~20 kB gzipped added to the
 * bundle. Worth it for the simplicity and reliability.
 */

import ar from './locales-embedded/ar.json';
import cs from './locales-embedded/cs.json';
import da from './locales-embedded/da.json';
import de from './locales-embedded/de.json';
import el from './locales-embedded/el.json';
import en from './locales-embedded/en.json';
import es from './locales-embedded/es.json';
import fi from './locales-embedded/fi.json';
import fr from './locales-embedded/fr.json';
import it from './locales-embedded/it.json';
import ja from './locales-embedded/ja.json';
import ko from './locales-embedded/ko.json';
import nl from './locales-embedded/nl.json';
import no from './locales-embedded/no.json';
import pl from './locales-embedded/pl.json';
import pt from './locales-embedded/pt.json';
import ru from './locales-embedded/ru.json';
import sv from './locales-embedded/sv.json';
import tr from './locales-embedded/tr.json';
import zh from './locales-embedded/zh.json';

const DICTS = {
  ar, cs, da, de, el, en, es, fi, fr, it,
  ja, ko, nl, no, pl, pt, ru, sv, tr, zh,
};

const LAST_RESORT_EN = en;
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur']);

// Legacy snake_case key fallbacks. 18 of 20 locales still use the old
// key naming (reserve_direct, open_price_comparison, etc.) — this lets
// us read them without rewriting every JSON. Keys with no entry here
// and no camelCase translation fall through to English.
const CAMEL_TO_SNAKE = {
  openWidget:             'open_price_comparison',
  bestPriceGuaranteed:    'best_price_guaranteed',
  loading:                'loading_rates',
  priceOnOfficialWebsite: 'direct_on_our_site',
  night:                  'night_one',
  nights:                 'night_other',
  hideChannels:           'show_fewer_channels',
  showAllChannels:        'show_all_channels',
  bookNow:                'reserve_direct',
  yourStay:               'your_stay',
};

export function primaryTag(locale) {
  return (locale || 'en').toLowerCase().split(/[-_]/)[0];
}

export function resolveLocale(config) {
  const enabled = Array.isArray(config.enabledLocales) && config.enabledLocales.length
    ? config.enabledLocales.map((s) => s.toLowerCase())
    : null;
  const fallback = (config.defaultLocale || 'en').toLowerCase();

  const inEnabled = (loc) => !enabled || enabled.includes(primaryTag(loc));

  if (config.locale && typeof config.locale === 'string' && config.locale.trim()) {
    const loc = config.locale.trim();
    if (inEnabled(loc)) return { full: loc, primary: primaryTag(loc) };
  }
  const htmlLang = document.documentElement.getAttribute('lang');
  if (htmlLang && htmlLang.trim() && inEnabled(htmlLang)) {
    return { full: htmlLang.trim(), primary: primaryTag(htmlLang) };
  }
  if (navigator.language && inEnabled(navigator.language)) {
    return { full: navigator.language, primary: primaryTag(navigator.language) };
  }
  return { full: fallback, primary: primaryTag(fallback) };
}

// Synchronous now — no fetch. Returns the dictionary directly.
// Kept async-shaped for compatibility with existing caller code.
export async function loadLocale(primary) {
  return DICTS[primary] || LAST_RESORT_EN;
}

export function makeT(dict) {
  return function t(key, vars) {
    const snake = CAMEL_TO_SNAKE[key];
    let str =
      (dict && dict[key]) ||
      (dict && snake && dict[snake]) ||
      LAST_RESORT_EN[key] ||
      (snake && LAST_RESORT_EN[snake]) ||
      key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        str = str.replace(`{${k}}`, vars[k]);
      }
    }
    return str;
  };
}

export function isRtl(primary) {
  return RTL_LOCALES.has(primary);
}