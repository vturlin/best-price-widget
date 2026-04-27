/**
 * Wax-seal palette derivation.
 *
 * Given any brand color, produce the three radial-gradient stops for the
 * "wax seal" medallion in the closed-state toggle, plus the engraved-mark
 * color that stays readable on top.
 *
 * The conversion goes through OKLCH so every brand reads as a deep
 * saturated wax — a navy seal looks as "sealed and waxy" as a burgundy
 * one. Done with ~30 lines of inline math (no external color library)
 * to keep the widget bundle small.
 *
 * Reference: https://bottosson.github.io/posts/oklab/
 */

function hexToRgb(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  const v = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// Linear sRGB → Oklab (Björn Ottosson's matrix).
function linearRgbToOklab([r, g, b]) {
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToLinearRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function hexToOklch(hex) {
  const [r, g, b] = hexToRgb(hex);
  const lin = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const [L, a, bLab] = linearRgbToOklab(lin);
  const C = Math.hypot(a, bLab);
  const H = (Math.atan2(bLab, a) * 180) / Math.PI;
  return [L, C, (H + 360) % 360];
}

function oklchToHex([L, C, H]) {
  const rad = (H * Math.PI) / 180;
  const lab = [L, C * Math.cos(rad), C * Math.sin(rad)];
  const lin = oklabToLinearRgb(lab);
  return rgbToHex([linearToSrgb(lin[0]), linearToSrgb(lin[1]), linearToSrgb(lin[2])]);
}

// Module-level memo: brandColor → derived stops. The closed-state toggle
// re-renders on every state change in the parent; recomputing the OKLCH
// trip on each render would be wasteful.
const cache = new Map();

/**
 * Derive { center, mid, edge, markColor, ringColor, isLight } from any
 * CSS-hex brand color. The mid stop is the brand color almost
 * verbatim; center is a brighter highlight, edge a darker shadow, all
 * keeping the original hue. The radial-gradient pattern (plus the
 * engraved mark, the inner ring, and the drop shadow) carries the
 * "wax-seal" feel — we don't anchor lightness anymore, so a red brand
 * stays red and a navy brand stays navy.
 */
export function deriveWaxStops(brandColor) {
  const key = (brandColor || '').toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const [L, C, H] = hexToOklch(brandColor || '#7A2E1F');

  // Mid keeps the brand's L and C verbatim. Center lifts L by ~0.08 for
  // the highlight; edge drops L by ~0.10 for the shadow. Tiny C taper
  // on the edge keeps the rim from looking neon on very saturated
  // brands. No L clamp / C floor — a true grey stays grey, and a
  // vibrant red stays vibrant.
  const mid = oklchToHex([L, C, H]);
  const center = oklchToHex([Math.min(L + 0.08, 0.95), C, H]);
  const edge = oklchToHex([Math.max(L - 0.10, 0.05), Math.max(C - 0.01, 0), H]);

  // Mark + ring contrast off the actual brand lightness now that mid
  // tracks it. Threshold 0.55 keeps cream on most brands and switches
  // to ink only when the brand is genuinely light.
  const isLight = L >= 0.55;
  const markColor = isLight ? '#1A1410' : '#F5E9D6';
  const ringColor = isLight ? 'rgba(0,0,0,0.15)' : 'rgba(245,233,214,0.18)';

  const out = { center, mid, edge, markColor, ringColor, isLight };
  cache.set(key, out);
  return out;
}
