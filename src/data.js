/**
 * Data layer. Responsible for:
 *   - Fetching the Google Sheet CSV
 *   - Parsing into a keyed map for O(1) lookup by (date, room_id)
 *   - Summing nightly prices across a stay
 *   - Discovering which OTA columns exist in the sheet
 *
 * We parse CSV inline (no papaparse) because:
 *   - Papaparse's UMD bundle ships a web-worker shim and escape logic we
 *     don't need, adding ~100kB gzipped for nothing.
 *   - Our CSV shape is constrained: numbers, ISO dates, short room names.
 *     The only realistic edge case is a quoted room name with a comma in it
 *     (e.g. `"Deluxe, South-Facing"`), which the parser below handles.
 */

/**
 * RFC4180-subset parser. Handles:
 *   - Quoted fields with embedded commas: "Deluxe, South"
 *   - Escaped quotes inside quoted fields: "She said ""hi"""
 *   - \n, \r\n line endings
 * Does NOT handle embedded newlines inside quoted fields — Google Sheets
 * doesn't produce them in a CSV export for the columns we care about.
 */
function parseCsv(text) {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  const len = text.length;
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = []; field = ''; i++; continue;
    }
    field += ch; i++;
  }
  // Last field / row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }

  if (rows.length === 0) return { fields: [], data: [] };
  const fields = rows[0].map((h) => h.trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    for (let c = 0; c < fields.length; c++) {
      obj[fields[c]] = rows[r][c] ?? '';
    }
    data.push(obj);
  }
  return { fields, data };
}

/**
 * Reserved columns (not treated as OTAs):
 */
const RESERVED_COLUMNS = new Set(['date', 'room_id', 'room_name', 'direct']);

/**
 * Load and parse the CSV. Resolves with a structured dataset:
 *   {
 *     channels: ['booking', 'expedia', ...],   // OTA column names
 *     rooms:    Map<room_id, room_name>,
 *     prices:   Map<"YYYY-MM-DD|room_id", { direct, booking, expedia, ... }>,
 *   }
 */
export async function loadPriceData(csvUrl) {
  const res = await fetch(csvUrl, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching CSV`);
  const text = await res.text();
  const parsed = parseCsv(text);
  return normalize(parsed);
}

function normalize({ fields, data }) {
  const channels = fields.filter(
    (f) => f && !RESERVED_COLUMNS.has(f.trim().toLowerCase())
  );

  const rooms = new Map();
  const prices = new Map();

  for (const row of data) {
    const date = String(row.date || '').trim();
    const roomId = String(row.room_id || '').trim();
    if (!date || !roomId) continue;

    if (row.room_name && !rooms.has(roomId)) {
      rooms.set(roomId, String(row.room_name).trim());
    }

    const entry = { direct: toNumber(row.direct) };
    for (const ch of channels) entry[ch] = toNumber(row[ch]);

    prices.set(`${date}|${roomId}`, entry);
  }

  return { channels, rooms, prices };
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  // Handle locale strings like "1.234,56" or "1,234.56"
  const cleaned = String(v).replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  // If both . and , appear, assume the last-occurring one is decimal
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized = cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
      ? cleaned.replace(/\./g, '').replace(',', '.')
      : cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    normalized = cleaned.replace(',', '.');
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/**
 * Given a check-in and check-out date (Date objects, exclusive check-out),
 * sum per-channel prices across every night in the range. Returns:
 *   {
 *     totals:        { direct: 240, booking: 289.5, ... },
 *     nights:        3,
 *     missingNights: { booking: 1, ... },   // channels that lack data for some nights
 *     hasDirect:     true,
 *   }
 *
 * A channel with ANY missing night gets null in totals — we refuse to compare
 * incomplete data, which would otherwise understate OTA prices and create a
 * misleading "savings" message.
 */
export function aggregateStay(data, roomId, checkIn, checkOut) {
  const nights = differenceInNights(checkIn, checkOut);
  if (nights <= 0) {
    return { totals: {}, nights: 0, missingNights: {}, hasDirect: false };
  }

  const allChannels = ['direct', ...data.channels];
  const totals = Object.fromEntries(allChannels.map((c) => [c, 0]));
  const missingNights = Object.fromEntries(allChannels.map((c) => [c, 0]));

  for (let i = 0; i < nights; i++) {
    const d = addDays(checkIn, i);
    const key = `${formatISO(d)}|${roomId}`;
    const row = data.prices.get(key);

    for (const ch of allChannels) {
      const price = row ? row[ch] : null;
      if (price === null || price === undefined) {
        missingNights[ch] += 1;
      } else {
        totals[ch] += price;
      }
    }
  }

  // Null out channels with any missing nights
  const finalTotals = {};
  for (const ch of allChannels) {
    finalTotals[ch] = missingNights[ch] > 0 ? null : totals[ch];
  }

  return {
    totals: finalTotals,
    nights,
    missingNights,
    hasDirect: finalTotals.direct !== null,
  };
}

/* ----- tiny date utilities (avoid date-fns on the hot path) ------------- */

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function differenceInNights(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  // Use UTC midnight to ignore DST shifts
  const au = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bu = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bu - au) / MS);
}

export function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
