// Tile-count regression check. Loads a set of layouts, selects every surface in Finalize, and records the Tile Estimate
// text. `node baseline.mjs --write` stores it in baseline.json; without the flag it compares against that file.
//   node baseline.mjs [--write] [path/to/index.html]
import { chromium } from 'playwright-core';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';

const args = process.argv.slice(2);
const write = args.includes('--write');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || 'index.html');
const snapshot = path.join(path.dirname(new URL(import.meta.url).pathname), 'baseline.json');

const K = 10.8; // pixels per inch
const poly = (pts) => pts.map(([x, y]) => ({ x: x * K, y: y * K }));
const loop = (start, n) => Array.from({ length: n }, (_, i) => [start + i, start + ((i + 1) % n)]);
const room = (outer, holes = []) => {
  const vertices = poly(outer.concat(...holes));
  const lines = loop(0, outer.length);
  let at = outer.length;
  for (const h of holes) { lines.push(...loop(at, h.length)); at += h.length; }
  return { vertices, lines };
};
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

const base = { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'sanded', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 };
const layouts = {
  rectangle: { tile: {}, surface: room(rect(0, 0, 120, 96)) },
  lshape: { tile: { tileWidthInches: 18, tileHeightInches: 18 }, surface: room([[0, 0], [100, 0], [100, 40], [60, 40], [60, 90], [0, 90]]) },
  island: { tile: {}, surface: room(rect(0, 0, 144, 120), [rect(40, 30, 36, 66)]) },
  chamfer: { tile: { tileWidthInches: 24, tileHeightInches: 12 }, surface: room([[28, 0], [64, 0], [64, 60], [16, 60], [16, 46], [0, 46], [0, 18]]) },
  rotatedBond: { tile: { tileWidthInches: 24, tileHeightInches: 12, bondOffset: 0.5, rotationDegrees: 30 }, surface: room(rect(0, 0, 130, 100)) },
  thirdBond: { tile: { tileWidthInches: 12, tileHeightInches: 6, bondOffset: 0.33, offsetXInches: 2, offsetYInches: 20 }, surface: room(rect(0, 0, 100, 70)) },
  hopscotchSquares: { tile: { pattern: 'hopscotch', tileWidthInches: 12, tileHeightInches: 12, tile2WidthInches: 6, tile2HeightInches: 6 }, surface: room(rect(0, 0, 100, 80), [rect(30, 20, 20, 20)]) },
  hopscotchDefault: { tile: { pattern: 'hopscotch', tileWidthInches: 24, tileHeightInches: 12 }, surface: room([[28, 0], [90, 0], [90, 80], [16, 80], [16, 46], [0, 46], [0, 18]]) },
  hopscotchRotated: { tile: { pattern: 'hopscotch', tileWidthInches: 18, tileHeightInches: 12, tile2WidthInches: 7, tile2HeightInches: 10, rotationDegrees: 30, offsetXInches: 3 }, surface: room(rect(0, 0, 110, 90), [rect(40, 30, 30, 20)]) },
  hexagon: { tile: { pattern: 'hexagon', tileWidthInches: 8, groutWidthInches: 0.25 }, surface: room(rect(0, 0, 100, 70), [rect(30, 20, 20, 16)]) },
  hexagonRotated: { tile: { pattern: 'hexagon', tileWidthInches: 6, groutWidthInches: 0.125, rotationDegrees: 30, offsetXInches: 2 }, surface: room([[28, 0], [90, 0], [90, 80], [16, 80], [16, 46], [0, 46], [0, 18]]) },
  pinwheel: { tile: { pattern: 'pinwheel', tileWidthInches: 8, tileHeightInches: 4, tile2WidthInches: 3.796875 }, surface: room(rect(0, 0, 100, 70), [rect(30, 20, 20, 16)]) },
  pinwheelBond: { tile: { pattern: 'pinwheel', tileWidthInches: 8, tileHeightInches: 4, tile2WidthInches: 3.796875, bondOffset: 0.5 }, surface: room(rect(0, 0, 100, 70), [rect(30, 20, 20, 16)]) },
  pinwheelTall: { tile: { pattern: 'pinwheel', tileWidthInches: 4, tileHeightInches: 6, tile2WidthInches: 1.875, rotationDegrees: 30, offsetXInches: 2 }, surface: room([[28, 0], [90, 0], [90, 80], [16, 80], [16, 46], [0, 46], [0, 18]]) },
  steppedThird: { tile: { pattern: 'stepped', tileWidthInches: 12, tileHeightInches: 6, bondOffset: 0.3333, groutWidthInches: 0.125 }, surface: room(rect(0, 0, 100, 70)) },
  herringbone: { tile: { pattern: 'herringbone', tileWidthInches: 12, tileHeightInches: 3, groutWidthInches: 0.125 }, surface: room([[0, 0], [90, 0], [90, 40], [50, 40], [50, 70], [0, 70]]) },
  herringbone45: { tile: { pattern: 'herringbone', tileWidthInches: 9, tileHeightInches: 3, groutWidthInches: 0.125, rotationDegrees: 45, offsetXInches: 2 }, surface: room(rect(0, 0, 100, 70), [rect(30, 20, 20, 20)]) },
  herringboneTall: { tile: { pattern: 'herringbone', tileWidthInches: 4, tileHeightInches: 16, groutWidthInches: 0.25 }, surface: room(rect(0, 0, 80, 60)) },
  basketweave: { tile: { pattern: 'basketweave', tileWidthInches: 4, tileHeightInches: 8, groutWidthInches: 0.5 }, surface: room(rect(0, 0, 64, 48)) },
  basketweaveThree: { tile: { pattern: 'basketweave', tileWidthInches: 2, tileHeightInches: 7, groutWidthInches: 0 }, surface: room(rect(0, 0, 70, 50), [rect(20, 10, 14, 14)]) },
  basketweaveWide: { tile: { pattern: 'basketweave', tileWidthInches: 3, tileHeightInches: 7 }, surface: room([[0, 0], [60, 0], [60, 30], [24, 30], [24, 48], [0, 48]]) },
  basketweaveShort: { tile: { pattern: 'basketweave', tileWidthInches: 3, tileHeightInches: 5 }, surface: room(rect(0, 0, 60, 40)) },
  exactFit: { tile: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0 }, surface: room(rect(0, 0, 48, 48)) },
  flushToWall: { tile: { tileWidthInches: 24, tileHeightInches: 12, groutWidthInches: 0.125 }, surface: room(rect(0, 0, 96, 60)) },
  offsets45: { tile: { rotationDegrees: 45, offsetXInches: 3.3, offsetYInches: 7.1, groutWidthInches: 0.25 }, surface: room([[0, 0], [96, 0], [96, 24], [72, 24], [72, 8], [60, 8], [60, 24], [0, 24]]) },
  everything: { tile: { tileWidthInches: 18, tileHeightInches: 18, offsetXInches: 5, rotationDegrees: 15 }, surface: room([[28, 0], [90, 0], [90, 80], [16, 80], [16, 46], [0, 46], [0, 18]], [rect(30, 30, 24, 12)]) },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const results = {};
for (const [name, l] of Object.entries(layouts)) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.on('pageerror', (e) => { results[name] = 'pageerror: ' + e.message; });
  await page.goto(pathToFileURL(file).href);
  await page.waitForTimeout(200);
  const design = { format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'finalize', zoom: 1, panX: 0, panY: 0 }, tileLayout: { ...base, ...l.tile }, surface: l.surface };
  const r = await page.evaluate((j) => app.importDesign(j), JSON.stringify(design));
  if (!r.success) { results[name] = 'import failed: ' + r.error; continue; }
  await page.click('.tab[data-tab="finalize"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => { app.selectedSurfaces = app.detectedSurfaces.map((_, i) => i); app.updateTileCount(); });
  results[name] = {
    surfaces: await page.evaluate(() => app.detectedSurfaces.length),
    summary: (await page.evaluate(() => document.getElementById('tileCountSummary').innerText)).replace(/\s+/g, ' ').trim(),
  };
  await page.context().close();
}
await browser.close();

if (write) { fs.writeFileSync(snapshot, JSON.stringify(results, null, 1) + '\n'); console.log('wrote', snapshot); console.log(JSON.stringify(results, null, 1)); process.exit(0); }
const expected = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
let bad = 0;
for (const name of Object.keys(layouts)) {
  const same = JSON.stringify(results[name]) === JSON.stringify(expected[name]);
  console.log((same ? '  ok   ' : '  FAIL ') + name);
  if (!same) { bad++; console.log('    expected:', JSON.stringify(expected[name])); console.log('    got:     ', JSON.stringify(results[name])); }
}
process.exit(bad ? 1 : 0);
