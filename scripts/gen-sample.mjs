// Generates a realistic sample CSV: next 60 days × 4 rooms × multiple OTAs.
// Direct is always cheapest (that's the widget's whole pitch).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'public', 'sample-sheet.csv');

const rooms = [
  { id: 'deluxe-king',   name: 'Deluxe King Room',   base: 320 },
  { id: 'superior-twin', name: 'Superior Twin Room', base: 280 },
  { id: 'junior-suite',  name: 'Junior Suite',       base: 480 },
  { id: 'terrace-suite', name: 'Terrace Suite',      base: 720 },
];

const channels = ['booking', 'expedia', 'trivago', 'hotels_com', 'agoda'];
const otaMarkup = { booking: 1.18, expedia: 1.22, trivago: 1.15, hotels_com: 1.20, agoda: 1.17 };

const header = ['date','room_id','room_name','direct', ...channels].join(',');
const rows = [header];

const today = new Date();
today.setHours(0,0,0,0);

for (let d = 0; d < 90; d++) {
  const date = new Date(today);
  date.setDate(date.getDate() + d);
  const iso = date.toISOString().slice(0,10);
  const dow = date.getDay(); // 0 Sun - 6 Sat
  // weekend premium
  const dowMult = (dow === 5 || dow === 6) ? 1.15 : 1.0;
  // mild seasonal variation
  const seasonal = 1 + 0.08 * Math.sin((d / 90) * Math.PI * 2);

  for (const r of rooms) {
    // occasionally a room is sold out on one channel (realism)
    const direct = Math.round(r.base * dowMult * seasonal);
    const vals = [iso, r.id, r.name, direct];
    for (const ch of channels) {
      // very occasional OTA unavailability
      const unavail = Math.random() < 0.02 ? '' : Math.round(direct * otaMarkup[ch] * (0.98 + Math.random() * 0.06));
      vals.push(unavail);
    }
    rows.push(vals.join(','));
  }
}

fs.writeFileSync(out, rows.join('\n'));
console.log(`Wrote ${rows.length - 1} rows to ${out}`);
