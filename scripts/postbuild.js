// Post-build: copy static assets into dist and report file sizes.
// Vite lib-mode doesn't run the public/ copy pipeline, so we do it manually.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

function copy(from, to) {
  fs.copyFileSync(from, to);
  console.log(`  ✓ ${path.relative(root, to)}`);
}

console.log('\n📦 Post-build:');

// Copy demo.html (with a fix: point scripts at ./ relative paths)
const demoSrc = fs.readFileSync(path.join(root, 'public/demo.html'), 'utf8');
fs.writeFileSync(path.join(dist, 'demo.html'), demoSrc);
console.log(`  ✓ dist/demo.html`);

// Copy sample sheet
if (fs.existsSync(path.join(root, 'public/sample-sheet.csv'))) {
  copy(path.join(root, 'public/sample-sheet.csv'), path.join(dist, 'sample-sheet.csv'));
}

// Size report
console.log('\n📊 Bundle sizes:');
for (const f of fs.readdirSync(dist)) {
  const stat = fs.statSync(path.join(dist, f));
  if (stat.isFile()) {
    const kb = (stat.size / 1024).toFixed(1);
    console.log(`  ${f.padEnd(24)} ${kb.padStart(7)} kB`);
  }
}
console.log('');

// Copy configs directory
const configsFromDir = path.join(root, 'public/configs');
const configsToDir = path.join(dist, 'configs');
if (fs.existsSync(configsFromDir)) {
  fs.mkdirSync(configsToDir, { recursive: true });
  for (const file of fs.readdirSync(configsFromDir)) {
    if (file.endsWith('.json')) {
      copy(path.join(configsFromDir, file), path.join(configsToDir, file));
    }
  }
}
