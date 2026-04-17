/**
 * Derive a full widget color palette from just two inputs:
 *   - brandColor      (buttons, accents)
 *   - backgroundColor (panel background)
 *
 * Everything else (borders, deep fills, text, soft text) is computed.
 * The function also detects dark-mode automatically: if the background is
 * dark, text flips to light and "deep fills" become lighter instead of
 * darker, so contrast stays visible.
 *
 * Semantic colors (sage for savings, red for "more expensive") are NOT
 * derived — they're preserved as-is in the CSS for universal signaling.
 */

/** Parse a hex string into {r, g, b} with components in [0, 255]. */
function hexToRgb(hex) {
    const clean = hex.replace('#', '').trim();
    const full = clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }
  
  function rgbToHex({ r, g, b }) {
    const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
  
  /** WCAG relative luminance, returns 0 (black) to 1 (white). */
  function luminance({ r, g, b }) {
    const toLinear = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }
  
  /** Mix two colors. amount = 0 keeps a, amount = 1 returns b. */
  function mix(aRgb, bRgb, amount) {
    return {
      r: aRgb.r + (bRgb.r - aRgb.r) * amount,
      g: aRgb.g + (bRgb.g - aRgb.g) * amount,
      b: aRgb.b + (bRgb.b - aRgb.b) * amount,
    };
  }
  
  const BLACK = { r: 0, g: 0, b: 0 };
  const WHITE = { r: 255, g: 255, b: 255 };
  
  /**
   * Main entry. Takes config colors, returns a ready-to-apply CSS var map.
   * Any missing input falls back to sensible defaults (current ivory theme).
   */
  export function derivePalette({ brandColor, backgroundColor }) {
    const brand = hexToRgb(brandColor || '#1a1a1a');
    const bg = hexToRgb(backgroundColor || '#faf7f2');
    const bgLum = luminance(bg);
    const isDark = bgLum < 0.5;
  
    // On a light background we darken toward black to create "deeper" tones.
    // On a dark background we lighten toward white — otherwise contrast dies.
    const darken = (rgb, amount) => mix(rgb, isDark ? WHITE : BLACK, amount);
  
    // The "deep" fill: used for hover states, selected ranges, subtle emphasis.
    // Light theme: ~5% darker than bg. Dark theme: ~8% lighter.
    const ivoryDeep = darken(bg, isDark ? 0.08 : 0.05);
  
    // Borders/separators: more contrast than deep fill.
    // Light theme: ~14% darker. Dark theme: ~18% lighter.
    const rule = darken(bg, isDark ? 0.18 : 0.14);
  
    // Main text: high contrast with background (black on light, white on dark)
    const ink = isDark ? WHITE : BLACK;
  
    // Secondary text: mid-gray that works on both light and dark bg.
    // Light theme: dark gray with a warm tint. Dark theme: light gray.
    const inkSoft = isDark
      ? mix(ink, bg, 0.4)   // ease toward bg so it's softer
      : mix(ink, bg, 0.55);
  
    // Brand text (button foreground): auto-contrast with brand color
    const brandLum = luminance(brand);
    const brandInk = brandLum > 0.5 ? BLACK : WHITE;
  
    return {
      '--hpw-brand':      rgbToHex(brand),
      '--hpw-brand-ink':  rgbToHex(brandInk),
      '--hpw-ivory':      rgbToHex(bg),
      '--hpw-ivory-deep': rgbToHex(ivoryDeep),
      '--hpw-rule':       rgbToHex(rule),
      '--hpw-ink':        rgbToHex(ink),
      '--hpw-ink-soft':   rgbToHex(inkSoft),
      // Sage (savings) and red (OTA over-price) are NOT derived.
      // They stay as-is in widget.css as universal semantic signals.
    };
  }
  
  /** True if the background suggests a dark theme. Widget class can use this
   *  to tweak things that are hard to express as CSS vars (e.g. shadow intensity). */
  export function isDarkTheme(backgroundColor) {
    const bg = hexToRgb(backgroundColor || '#faf7f2');
    return luminance(bg) < 0.5;
  }