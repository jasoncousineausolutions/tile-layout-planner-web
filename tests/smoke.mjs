// Automated smoke test for the Tile Planner (index.html). Drives the page in a real Chromium browser with real mouse
// clicks, exactly like a person would, and fails if anything throws or a core flow breaks.
//
//   node smoke.mjs [path/to/index.html]        (needs: npm i playwright-core, and a Chromium; set CHROMIUM if not at /opt/pw-browsers/chromium)
//
import { chromium } from 'playwright-core';
import path from 'path';
import { pathToFileURL } from 'url';
import fs from 'fs';

const file = path.resolve(process.argv[2] || 'index.html');
const url = pathToFileURL(file).href;
const sketchPng = path.join(path.dirname(new URL(import.meta.url).pathname), 'sketch.png');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

let passed = 0, failed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; failures.push(name); console.log('  FAIL ' + name + '\n         ' + String(e.message).split('\n')[0]); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) page.errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());   // confirm()/alert() popups: accept
  await page.goto(url);
  await page.waitForTimeout(300);
  return page;
}
const state = (page) => page.evaluate(() => ({ v: app.vertices.length, l: app.lines.length, tab: app.currentTab, surfaces: app.detectedSurfaces.length, selected: app.selectedSurfaces.length }));
const screenOf = (page, wx, wy) => page.evaluate(([x, y]) => { const r = app.canvas.getBoundingClientRect(); const p = app.worldToScreen({ x, y }); return { x: r.left + p.x, y: r.top + p.y }; }, [wx, wy]);

// Draws a rectangle with real clicks in Add Line mode, typing each wall's length into the prompt.
// Every wall is two clicks (its start corner, then where it ends) and typing a length moves the end point, so each
// click is aimed at the corner's CURRENT position.
async function drawRectangle(page, w, h) {
  const phone = (await page.viewportSize()).width < 800;
  w = w ?? (phone ? 36 : 60); h = h ?? (phone ? 24 : 40);
  await page.click('.tab[data-tab="surfaceDesign"]');
  await page.click('#btnAddLine');
  const box = await page.locator('#canvas').boundingBox();
  const ptr = (sx, sy) => page.mouse.click(sx, sy);
  const vertexScreen = async (i) => { const v = await page.evaluate((k) => ({ ...app.vertices[k] }), i); return screenOf(page, v.x, v.y); };
  const answerPrompt = async (text) => {
    await page.waitForSelector('#customPromptInput', { state: 'visible', timeout: 2000 });
    if (text !== null) await page.fill('#customPromptInput', String(text));
    await page.click('#customPromptOk'); await page.waitForTimeout(80);
  };
  const x0 = box.x + box.width * 0.2, y0 = box.y + box.height * 0.2;
  const pxW = w * 10.8 * (await page.evaluate(() => app.zoom)), pxH = h * 10.8 * (await page.evaluate(() => app.zoom));
  await ptr(x0, y0); await ptr(x0 + pxW, y0); await answerPrompt(w);        // top, corners 0 -> 1
  let p1 = await vertexScreen(1); await ptr(p1.x, p1.y); await ptr(p1.x, p1.y + pxH); await answerPrompt(h);   // right side, 1 -> 2
  let p2 = await vertexScreen(2); await ptr(p2.x, p2.y); await ptr(p2.x - pxW, p2.y); await answerPrompt(w);   // bottom, 2 -> 3
  let p3 = await vertexScreen(3), p0 = await vertexScreen(0); await ptr(p3.x, p3.y); await ptr(p0.x, p0.y); await answerPrompt(null); // close up, 3 -> 0
}

const mockSketch = (page, status, body, delay = 0) => page.route('**/api/sketch*', async (r) => {
  if (delay) await new Promise((res) => setTimeout(res, delay));
  try { await r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: typeof body === 'string' ? body : JSON.stringify(body) }); } catch {}
});
const room = { shapes: [{ role: 'outer', points: [[0,0],[144,0],[144,30],[150,30],[150,60],[144,60],[144,138],[0,138]].map(([x, y]) => ({ x, y })) }, { role: 'cutout', points: [[40,40],[76,40],[76,106],[40,106]].map(([x, y]) => ({ x, y })) }], warnings: ['Kept a doorway on the right wall.'], working: ['right wall: 30 + gap + 78 = 138'], model: 'gemini-3.6-flash' };

for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 780 }]]) {
  console.log(`\n== ${label} ${viewport.width}x${viewport.height}`);
  let page = await newPage(viewport);

  await step('page loads with no errors', async () => { expect(page.errors.length === 0, page.errors.join(' | ')); expect((await state(page)).tab === 'tileLayout', 'starts on Tile Layout'); });

  await step('draw a rectangle with real clicks (4 lines, typed lengths)', async () => {
    await drawRectangle(page);
    const s = await state(page);
    expect(s.v === 4 && s.l === 4, `expected 4 vertices and 4 lines, got ${s.v}/${s.l}`);
    const lens = await page.evaluate(() => app.lines.map(([a, b]) => Math.round(Math.hypot(app.vertices[a].x - app.vertices[b].x, app.vertices[a].y - app.vertices[b].y) / CONFIG.PIXELS_PER_INCH)));
    const phone = viewport.width < 800, W = phone ? 36 : 60, H = phone ? 24 : 40;
    expect([...lens].sort((x, y) => x - y).join() === [H, H, W, W].sort((x, y) => x - y).join(), 'lengths typed into the prompt were not applied: ' + lens);
  });

  await step('Finalize: the single surface is auto-selected with a tile estimate, and clicking it toggles it', async () => {
    await page.click('.tab[data-tab="finalize"]');
    await page.waitForTimeout(250);
    let s = await state(page);
    expect(s.surfaces === 1, 'expected exactly 1 detected surface, got ' + s.surfaces);
    const estimate = () => page.evaluate(() => (document.getElementById('tileCountSummary').innerText + ' ' + document.getElementById('tileCountSummaryMobile').innerText));
    expect(s.selected === 1 && !/Select surfaces to see/.test((await estimate()).slice(0, 60)) && /\d/.test(await estimate()), 'no tile estimate for the auto-selected surface: ' + (await estimate()).slice(0, 100));
    const c = await page.evaluate(() => { const poly = app.getSurfaceOuterBoundary(app.detectedSurfaces[0]).map((i) => app.vertices[i]); return { x: poly.reduce((a, p) => a + p.x, 0) / poly.length, y: poly.reduce((a, p) => a + p.y, 0) / poly.length }; });
    const sp = await screenOf(page, c.x, c.y);
    await page.mouse.click(sp.x, sp.y); await page.waitForTimeout(150);
    expect((await state(page)).selected === 0, 'clicking the selected surface did not deselect it');
    await page.mouse.click(sp.x, sp.y); await page.waitForTimeout(150);
    s = await state(page);
    expect(s.selected === 1 && /\d/.test(await estimate()), 'clicking again did not select it and show the estimate');
  });

  await step('Edit: drag a vertex to a new place', async () => {
    await page.click('.tab[data-tab="surfaceDesign"]');
    await page.click('#btnIdle');
    const before = await page.evaluate(() => ({ ...app.vertices[0] }));
    const sp = await screenOf(page, before.x, before.y);
    await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x + 70, sp.y + 55, { steps: 8 }); await page.mouse.up();
    const after = await page.evaluate(() => ({ ...app.vertices[0] }));
    expect(Math.hypot(after.x - before.x, after.y - before.y) > 30, 'vertex did not move (the planner snaps small drags back into line, so this drag is large)');
  });

  await step('Add Line: draw a diagonal between two existing corners', async () => {
    await page.click('#btnAddLine');
    const [a, b] = await page.evaluate(() => [{ ...app.vertices[0] }, { ...app.vertices[2] }]);
    const sa = await screenOf(page, a.x, a.y), sb = await screenOf(page, b.x, b.y);
    const linesBefore = (await state(page)).l;
    await page.mouse.click(sa.x, sa.y); await page.mouse.click(sb.x, sb.y);
    const prompted = await page.waitForSelector('#customPromptInput', { state: 'visible', timeout: 1500 }).then(() => true).catch(() => false);
    if (prompted) { await page.fill('#customPromptInput', '120'); await page.click('#customPromptOk'); }
    await page.waitForTimeout(150);
    expect((await state(page)).l === linesBefore + 1, 'diagonal line was not added');
  });

  await step('Save / Load round trip keeps the design (through a file, and through the text)', async () => {
    const before = await page.evaluate(() => JSON.stringify({ v: app.vertices, l: app.lines }));
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.waitForSelector('#saveLoadDialog', { state: 'visible' });
    expect(!(await page.isVisible('#saveLoadTextarea')), 'the design text should start collapsed');
    // a browser without a save dialog downloads under the name in the box
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    expect(/^tile-design-\d{4}-\d{2}-\d{2}$/.test(await page.inputValue('#saveFileName')), 'the file name box should start with a dated name');
    await page.fill('#saveFileName', 'Kitchen floor v2');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#saveToFile')]);
    expect(download.suggestedFilename() === 'Kitchen floor v2.json', 'the file should use the name typed in the box: ' + download.suggestedFilename());
    expect((await page.inputValue('#saveFileName')) === 'Kitchen floor v2', 'the name should be kept after saving');
    // a browser with a save dialog: the name is suggested, the file is written where chosen, and cancelling saves nothing
    const picked = await page.evaluate(async () => {
      const calls = { suggested: null, written: '', closed: false };
      window.showSaveFilePicker = async (o) => { calls.suggested = o.suggestedName; return { name: 'chosen.json', createWritable: async () => ({ write: async (t) => { calls.written = t; }, close: async () => { calls.closed = true; } }) }; };
      document.getElementById('saveFileName').value = 'Bathroom';
      await app.saveDesignFile();
      const first = { ...calls, status: document.getElementById('saveLoadStatus').textContent, box: document.getElementById('saveFileName').value };
      window.showSaveFilePicker = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
      document.getElementById('saveLoadStatus').textContent = '';
      await app.saveDesignFile();
      return { first, afterCancel: document.getElementById('saveLoadStatus').textContent };
    });
    expect(picked.first.suggested === 'Bathroom.json' && picked.first.closed && JSON.parse(picked.first.written).format === 'tile-planner-design' && /chosen\.json/.test(picked.first.status) && picked.first.box === 'chosen', 'the save dialog route is wrong: ' + JSON.stringify(picked.first));
    expect(picked.afterCancel === '', 'cancelling the save dialog should say nothing: ' + picked.afterCancel);
    await page.evaluate(() => { window.showSaveFilePicker = undefined; });
    await page.fill('#saveFileName', 'plain');
    const [download2] = await Promise.all([page.waitForEvent('download'), page.click('#saveToFile')]);
    const savedPath = path.join(path.dirname(new URL(import.meta.url).pathname), '.saved-design.json');
    await download2.saveAs(savedPath);
    const fileText = fs.readFileSync(savedPath, 'utf8');
    expect(JSON.parse(fileText).format === 'tile-planner-design', 'the saved file is not a design');
    // the text is there when asked for
    await page.click('#saveLoadText summary');
    expect(await page.isVisible('#saveLoadTextarea'), 'the design text did not open');
    const saved = await page.inputValue('#saveLoadTextarea');
    expect(JSON.parse(saved).surface.vertices.length === JSON.parse(fileText).surface.vertices.length, 'file and text differ');
    await page.click('#saveLoadClose');
    // open the file after clearing
    await page.evaluate(() => app.clearAll());
    expect((await state(page)).v === 0, 'clear all failed');
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.setInputFiles('#designFile', savedPath); await page.waitForTimeout(1200);
    let after = await page.evaluate(() => JSON.stringify({ v: app.vertices, l: app.lines }));
    expect(after === before, 'design changed after save to file and open file');
    fs.unlinkSync(savedPath);
    // a file that is not a design is refused with a message
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    fs.writeFileSync(savedPath, 'this is not a design');
    await page.setInputFiles('#designFile', savedPath); await page.waitForTimeout(500);
    expect((await page.textContent('#saveLoadStatus')).length > 0 && (await page.evaluate(() => app.vertices.length)) > 0, 'a bad file should show a message and leave the drawing alone');
    fs.unlinkSync(savedPath);
    // the text route still works
    await page.click('#saveLoadClose');
    await page.evaluate(() => app.clearAll());
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.click('#saveLoadText summary');
    await page.fill('#saveLoadTextarea', saved); await page.click('#saveLoadLoad'); await page.waitForTimeout(1000);
    after = await page.evaluate(() => JSON.stringify({ v: app.vertices, l: app.lines }));
    expect(after === before, 'design changed after save and load as text');
  });

  await step('switching to metric and back does not break anything', async () => {
    const setUnits = (v) => page.evaluate((val) => { const el = document.getElementById('unitMode'); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    await setUnits('metric'); await page.waitForTimeout(100);
    await setUnits('decimal2'); await page.waitForTimeout(100);
    expect(page.errors.length === 0, page.errors.join(' | '));
  });

  await step('no errors during all of the above', async () => expect(page.errors.length === 0, page.errors.join(' | ')));

  await step('display options: opens and closes, label size and colours apply, and are remembered', async () => {
    // record every font and fill colour the canvas is asked to use
    await page.evaluate(() => {
      window.__fonts = new Set(); window.__fills = new Set();
      const proto = CanvasRenderingContext2D.prototype;
      for (const [prop, set] of [['font', window.__fonts], ['fillStyle', window.__fills]]) {
        const d = Object.getOwnPropertyDescriptor(proto, prop);
        Object.defineProperty(proto, prop, { set(v) { set.add(String(v)); d.set.call(this, v); }, get() { return d.get.call(this); } });
      }
    });
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { if (app.selectedSurfaces.length === 0) app.toggleSurfaceSelection(0); const c = document.getElementById('showAngles'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    // desktop: the section is at the bottom of the side panel; phone: it is in the Tile Layout tab
    const phone = await page.evaluate(() => innerWidth <= 800);
    const [btn, sec] = phone ? ['#btnToggleDisplayMobile', '#displayCollapsibleMobile'] : ['#btnToggleDisplay', '#displayCollapsible'];
    const other = phone ? '#displayCollapsible' : '#displayCollapsibleMobile';
    if (phone) { await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(250); }
    expect(!(await page.isVisible(sec)), 'Display Options should start closed');
    await page.click(btn);
    expect(await page.isVisible(sec), 'Display Options did not open');
    expect((await page.getAttribute(btn, 'aria-expanded')) === 'true', 'aria-expanded not set when open');
    expect(await page.isVisible(sec + ' select'), 'Units not inside Display Options');
    await page.evaluate((q) => { const el = document.querySelector(q + ' .label-size-select'); el.value = '1.8'; el.dispatchEvent(new Event('change', { bubbles: true })); }, sec);
    expect((await page.evaluate((q) => document.querySelector(q + ' .label-size-select').value, other)) === '1.8', 'the other select did not follow');
    await page.evaluate((q) => { const el = document.querySelector(q + ' input[data-key="cutLabel"]'); el.value = '#00aa00'; el.dispatchEvent(new Event('input', { bubbles: true })); }, sec);
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(100);
    await page.waitForTimeout(250);
    const fonts = await page.evaluate(() => [...window.__fonts]);
    expect(fonts.includes('bold 18px sans-serif'), 'cut-measurement labels are not 1.8x bigger: ' + fonts.join(' | '));
    expect((await page.evaluate(() => [...window.__fills])).includes('#00aa00'), 'cut-measurement colour was not used');
    await page.click('.tab[data-tab="surfaceDesign"]'); await page.waitForTimeout(250);
    expect((await page.evaluate(() => [...window.__fonts])).includes('21.6px sans-serif'), 'wall-length labels are not 1.8x bigger');
    await page.reload(); await page.waitForTimeout(400);
    expect((await page.evaluate(() => document.querySelector('.label-size-select').value)) === '1.8', 'size not remembered after a reload');
    expect((await page.evaluate(() => app.displayColors.cutLabel)) === '#00aa00', 'colour not remembered after a reload');
    if (phone) { await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(250); }
    await page.click(btn);
    await page.click(sec + ' .reset-colors');
    expect((await page.evaluate(() => app.displayColors.cutLabel)) === '#cc0000', 'Reset colours did not restore the default');
    await page.evaluate(() => { const el = document.querySelector('.label-size-select'); el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('patterns: the Pattern list changes the layout, labels the offset box, and is kept by save and load', async () => {
    const phone = await page.evaluate(() => innerWidth <= 800);
    await page.evaluate(() => { const k = 10.8, p = (x, y) => ({ x: x * k, y: y * k }); app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 12, tileHeightInches: 3, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [p(0, 0), p(60, 0), p(60, 40), p(0, 40)], lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } })); });
    await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(200);
    const setPattern = (v) => page.evaluate((val) => { const el = document.getElementById('tilePattern'); el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    const state = () => page.evaluate(() => ({ label: document.getElementById('labelBond').textContent, bondShown: getComputedStyle(document.getElementById('bondGroup')).visibility, tiles: app.getLayout().tilesCovering(0, 0, 648, 432).length, pattern: app.pattern }));
    let st = await state();
    expect(st.pattern === 'grid' && st.label === 'Running Bond:' && st.bondShown === 'visible', 'unexpected starting state ' + JSON.stringify(st));
    const gridTiles = st.tiles;
    await setPattern('stepped');
    st = await state();
    expect(st.label === 'Step:' && st.bondShown === 'visible', 'the offset box should read Step for a stepped pattern: ' + JSON.stringify(st));
    await setPattern('herringbone');
    st = await state();
    expect(st.bondShown === 'hidden' && st.pattern === 'herringbone', 'the offset box should be hidden for herringbone: ' + JSON.stringify(st));
    expect(st.tiles !== gridTiles, 'herringbone placed the same number of tiles as the grid');
    // estimate: every tile of a 60 x 40 in room of 12 x 3 in tiles is accounted for (area / tile area = 66.7)
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { app.selectedSurfaces = [0]; app.updateTileCount(); });
    const total = await page.evaluate(() => +document.querySelector('#tileCountSummary .count-total .count-value').textContent);
    expect(total >= 67 && total <= 80, 'herringbone tile estimate looks wrong: ' + total);
    // save and load keeps the pattern; an old design without one loads as a grid
    const saved = await page.evaluate(() => app.exportDesign());
    expect(JSON.parse(saved).tileLayout.pattern === 'herringbone', 'the pattern was not saved');
    await page.evaluate((j) => { app.importDesign(j); }, saved.replace('"pattern": "herringbone"', '"pattern": "grid"'));
    expect((await page.evaluate(() => app.pattern)) === 'grid' && (await page.evaluate(() => document.getElementById('tilePattern').value)) === 'grid', 'loading did not set the pattern');
    await page.evaluate((j) => { const d = JSON.parse(j); delete d.tileLayout.pattern; app.importDesign(JSON.stringify(d)); }, saved);
    expect((await page.evaluate(() => app.pattern)) === 'grid', 'a design with no pattern should load as a grid');
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('basketweave: tiles per block follow the tile shape, the grout is worked out, a short tile is explained, and it saves and loads', async () => {
    await page.evaluate(() => { const k = 10.8, p = (x, y) => ({ x: x * k, y: y * k }); app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 4, tileHeightInches: 8, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [p(0, 0), p(64, 0), p(64, 48), p(0, 48)], lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } })); });
    await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(200);
    const set = (id, v) => page.evaluate(([i, val]) => { const el = document.getElementById(i); el.value = val; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }, [id, v]);
    const read = () => page.evaluate(() => ({ grout: document.getElementById('groutWidth').value, locked: document.getElementById('groutWidth').disabled, hint: document.getElementById('weaveHint').textContent, readout: document.getElementById('weaveReadout').value, label: document.getElementById('labelBond').textContent, stored: app.groutWidthInches, used: app.effectiveGrout(), n: app.weaveCount() }));
    await set('tilePattern', 'basketweave');
    let r = await read();
    expect(r.locked && r.n === 2 && Math.abs(r.used) < 1e-9 && /^0\.0+$/.test(r.grout) && r.readout === '2' && r.label === 'Tiles per block:' && r.hint === '', '4 x 8 tiles make blocks of 2 with no grout: ' + JSON.stringify(r));
    expect(Math.abs(r.stored - 0.125) < 1e-9, 'the grout you typed should be kept for when you leave basketweave: ' + r.stored);
    await set('tileHeight', '9');
    r = await read();
    expect(r.n === 2 && Math.abs(r.used - 1) < 1e-9 && /^1\.0+$/.test(r.grout) && r.readout === '2', '4 x 9 tiles make blocks of 2 with 1 in of grout: ' + JSON.stringify(r));
    await set('tileHeight', '12.4');
    r = await read();
    expect(r.n === 3 && r.readout === '3' && Math.abs(r.used - 0.2) < 1e-9, '4 x 12.4 tiles make blocks of 3 with 0.2 in of grout: ' + JSON.stringify(r));
    await set('tileHeight', '12');
    r = await read();
    expect(r.n === 3 && Math.abs(r.used) < 1e-9, '4 x 12 tiles make blocks of 3 with no grout: ' + JSON.stringify(r));
    await set('tileHeight', '5');
    r = await read();
    expect(!r.locked && r.n === 1 && /twice as long/.test(r.hint), 'a 4 x 5 tile is too short to weave: ' + JSON.stringify(r));
    await set('tileHeight', '12');
    const saved = await page.evaluate(() => app.exportDesign());
    expect(JSON.parse(saved).tileLayout.pattern === 'basketweave', 'basketweave was not saved');
    await set('tilePattern', 'grid');
    r = await read();
    expect(!r.locked && Math.abs(parseFloat(r.grout) - 0.125) < 1e-6, 'leaving basketweave should bring back the typed grout: ' + JSON.stringify(r));
    await page.evaluate((j) => app.importDesign(j), saved);
    r = await read();
    expect(r.locked && r.n === 3, 'loading did not restore the basketweave');
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('saved designs: a file saved by the 1.28 app loads, and an unknown pattern or extra fields are ignored safely', async () => {
    const oldFile = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'design-from-1.28.json'), 'utf8');
    const r = await page.evaluate((j) => { const res = app.importDesign(j); return { ok: res.success, pattern: app.pattern, bond: app.bondOffset, rot: app.rotationDegrees, v: app.vertices.length, unit: app.unitMode, w: app.tileWidthInches, h: app.tileHeightInches }; }, oldFile);
    expect(r.ok && r.pattern === 'grid' && r.bond === 0.33 && r.rot === 15 && r.v === 8 && r.unit === 'sixteenth' && r.w === 24 && r.h === 12, 'the 1.28 file did not load as saved: ' + JSON.stringify(r));
    const odd = JSON.parse(oldFile); odd.tileLayout.pattern = 'zigzag-from-the-future'; odd.tileLayout.somethingNew = { a: 1 }; odd.appState.alsoNew = true; odd.extraTopLevel = [1, 2];
    const r2 = await page.evaluate((j) => { const res = app.importDesign(j); return { ok: res.success, pattern: app.pattern, v: app.vertices.length }; }, JSON.stringify(odd));
    expect(r2.ok && r2.pattern === 'grid' && r2.v === 8, 'a file from the future should load as a grid: ' + JSON.stringify(r2));
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('metric (cm): labels, boxes and the estimate use centimetres, typing a bare number means cm, and it saves and loads', async () => {
    await page.evaluate(() => { const k = 10.8, p = (x, y) => ({ x: x * k, y: y * k }); app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 24, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'sanded', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [p(0, 0), p(50, 0), p(50, 38), p(0, 38)], lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } })); });
    await page.evaluate(() => { const el = document.getElementById('unitMode'); el.value = 'metricCm'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForTimeout(200);
    let r = await page.evaluate(() => ({ unit: app.unitMode, mobile: document.getElementById('unitModeMobile').value, label: document.getElementById('labelTileWidth').textContent, width: document.getElementById('tileWidth').value, fm: formatMeasurement(12, 'metricCm') }));
    expect(r.unit === 'metricCm' && r.mobile === 'metricCm' && /\(cm\)/.test(r.label) && r.width === '60.96' && r.fm === '30.5 cm', 'centimetre display is wrong: ' + JSON.stringify(r));
    // a bare number typed into a box is centimetres
    await page.evaluate(() => { const el = document.getElementById('tileWidth'); el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(Math.abs((await page.evaluate(() => app.tileWidthInches)) - 30 / 2.54) < 1e-9, 'a bare 30 in the width box should be 30 cm');
    // an explicit unit still wins
    await page.evaluate(() => { const el = document.getElementById('tileWidth'); el.value = '10"'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(Math.abs((await page.evaluate(() => app.tileWidthInches)) - 10) < 1e-9, '10" should stay 10 inches');
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { app.selectedSurfaces = [0]; app.updateTileCount(); });
    const est = await page.evaluate(() => document.getElementById('tileCountSummary').innerText);
    expect(/m\u00B2/.test(est) && /kg/.test(est), 'the estimate should be in m2 and kg: ' + est);
    const saved = await page.evaluate(() => app.exportDesign());
    expect(JSON.parse(saved).appState.unitMode === 'metricCm', 'the unit was not saved');
    await page.evaluate(() => { const el = document.getElementById('unitMode'); el.value = 'decimal2'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.evaluate((j) => app.importDesign(j), saved);
    r = await page.evaluate(() => ({ unit: app.unitMode, sel: document.getElementById('unitMode').value }));
    expect(r.unit === 'metricCm' && r.sel === 'metricCm', 'loading did not restore centimetres: ' + JSON.stringify(r));
    await page.evaluate(() => { const el = document.getElementById('unitMode'); el.value = 'decimal2'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('slivers, the layout picture, and loading from Tile Layout', async () => {
    const design = (offX, top, bottom) => JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 24, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: offX, offsetYInches: 0 }, surface: { vertices: [[0, 0], [100, 0], [100, 70], [0, 70], [40, top], [65, top], [65, bottom], [40, bottom]].map(([x, y]) => ({ x: x * 10.8, y: y * 10.8 })), lines: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]] } });
    await page.evaluate(() => {
      window.__strokes = new Set();
      if (window.__spiedStroke) return;
      window.__spiedStroke = true;
      const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'strokeStyle');
      Object.defineProperty(CanvasRenderingContext2D.prototype, 'strokeStyle', { set(v) { window.__strokes.add(String(v)); d.set.call(this, v); }, get() { return d.get.call(this); } });
    });
    await page.evaluate((j) => app.importDesign(j), design(0.4, 25, 50));
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { app.selectedSurfaces = [0]; app.updateTileCount(); app.redraw(); });
    const orange = () => page.evaluate(() => window.__strokes.has('#FF8C00'));
    await page.evaluate(() => { window.__strokes.clear(); app.redraw(); });
    expect(!(await orange()), 'nothing should be marked until Highlight slivers is on');
    await page.evaluate(() => { const c = document.getElementById('highlightSlivers'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); window.__strokes.clear(); app.redraw(); });
    expect(await orange(), 'the cut that leaves a sliver should be marked');
    // a layout whose cuts all leave 2.5 cm or more has nothing to mark
    await page.evaluate((j) => app.importDesign(j), design(0, 30, 55));
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { app.selectedSurfaces = [0]; app.updateTileCount(); window.__strokes.clear(); app.redraw(); });
    expect(!(await orange()), 'no cut leaves a sliver here, so nothing should be marked');
    await page.evaluate(() => { const c = document.getElementById('highlightSlivers'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); });
    // the picture: fitted, opaque, sharp, and the app is left as it was
    const before = await page.evaluate(() => ({ zoom: app.zoom, panX: app.panX, w: app.canvas.width, selected: app.selectedSurfaces.length }));
    const img = await page.evaluate(() => new Promise((resolve) => { const url = app.renderLayoutImage(); const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); resolve({ w: im.width, h: im.height, corner: [...x.getImageData(1, 1, 1, 1).data] }); }; im.src = url; }));
    expect(img.w >= 2000 && img.w <= 3000 && img.corner[3] === 255, 'the layout picture should be large and opaque: ' + JSON.stringify(img));
    const after = await page.evaluate(() => ({ zoom: app.zoom, panX: app.panX, w: app.canvas.width, selected: app.selectedSurfaces.length, exporting: app.exporting }));
    expect(after.zoom === before.zoom && after.panX === before.panX && after.w === before.w && after.selected === before.selected && !after.exporting, 'making the picture changed the app: ' + JSON.stringify({ before, after }));
    // loading a design from Tile Layout moves to Surface Design
    await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(200);
    const saved = await page.evaluate(() => app.exportDesign());
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.click('#saveLoadText summary');
    await page.fill('#saveLoadTextarea', saved); await page.click('#saveLoadLoad'); await page.waitForTimeout(600);
    expect((await page.evaluate(() => app.currentTab)) === 'surfaceDesign', 'loading from the Tile Layout tab should move to Surface Design');
    await page.evaluate(() => { document.getElementById('saveLoadOverlay').style.display = 'none'; });
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('phone menus sit in one order, and loading fits the drawing to the screen', async () => {
    const phone = await page.evaluate(() => innerWidth <= 800);
    // the menus are in the same order on both layouts: Re-center View, Import & Export, Display Options
    const ids = phone ? ['btnRecenterMobile', 'btnToggleFileMobile', 'btnToggleDisplayMobile'] : ['btnRecenter', 'btnToggleFile', 'btnToggleDisplay'];
    const tops = await page.evaluate((list) => list.map((id) => document.getElementById(id).getBoundingClientRect().top), ids);
    expect(tops[0] < tops[1] && tops[1] < tops[2], 'the menus are out of order: ' + JSON.stringify(tops));
    // a design far from the origin and bigger than the screen, loaded through the dialog, ends up fully in view
    const far = { format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 2.5, panX: -4000, panY: -3000 }, tileLayout: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [[900, 700], [1500, 700], [1500, 1200], [900, 1200]].map(([x, y]) => ({ x: x * 10.8, y: y * 10.8 })), lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } };
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.click('#saveLoadText summary');
    await page.fill('#saveLoadTextarea', JSON.stringify(far)); await page.click('#saveLoadLoad'); await page.waitForTimeout(600);
    const view = await page.evaluate(() => { const pts = app.vertices.map((v) => ({ x: v.x * app.zoom + app.panX, y: v.y * app.zoom + app.panY })); return { w: app.canvas.width, h: app.canvas.height, minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) }; });
    expect(view.minX >= 0 && view.minY >= 0 && view.maxX <= view.w && view.maxY <= view.h, 'the loaded drawing is not fully in view: ' + JSON.stringify(view));
    expect(Math.abs((view.minX + view.maxX) / 2 - view.w / 2) < 2 && Math.abs((view.minY + view.maxY) / 2 - view.h / 2) < 2, 'the loaded drawing is not centred: ' + JSON.stringify(view));
    await page.evaluate(() => { document.getElementById('saveLoadOverlay').style.display = 'none'; });
    // Re-center View does the same for a drawing that has drifted away
    await page.evaluate(() => { app.panX += 3000; app.zoom = 0.2; app.redraw(); });
    await page.evaluate(() => document.getElementById(innerWidth <= 800 ? 'btnRecenterMobile' : 'btnRecenter').click());
    const again = await page.evaluate(() => { const pts = app.vertices.map((v) => ({ x: v.x * app.zoom + app.panX, y: v.y * app.zoom + app.panY })); return { ok: Math.min(...pts.map((p) => p.x)) >= 0 && Math.max(...pts.map((p) => p.x)) <= app.canvas.width }; });
    expect(again.ok, 'Re-center View should bring the drawing back into view');
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('finalize: dragging the canvas pans it, a plain click still selects, the middle button pans anywhere', async () => {
    const phone = await page.evaluate(() => innerWidth <= 800);
    if (phone) return;   // touch has its own pan and pinch
    await page.evaluate(() => { const k = 10.8, p = (x, y) => ({ x: x * k, y: y * k }); app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [p(0, 0), p(50, 0), p(50, 38), p(0, 38)], lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } })); });
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { app.selectedSurfaces = []; app.updateTileCount(); app.panX = 100; app.panY = 100; app.zoom = 1; app.redraw(); });
    const box = await page.evaluate(() => { const r = app.canvas.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const inside = { x: box.x + 100 + 10.8 * 25, y: box.y + 100 + 10.8 * 19 };   // the middle of the room
    // a drag that starts on the surface pans and does not select it
    await page.mouse.move(inside.x, inside.y); await page.mouse.down(); await page.mouse.move(inside.x + 60, inside.y + 30, { steps: 6 }); await page.mouse.up();
    let st = await page.evaluate(() => ({ panX: app.panX, panY: app.panY, sel: app.selectedSurfaces.length }));
    expect(Math.abs(st.panX - 160) < 1 && Math.abs(st.panY - 130) < 1, 'drag did not pan the canvas: ' + JSON.stringify(st));
    expect(st.sel === 0, 'a drag should not select the surface');
    // a click on the surface selects it, and another click deselects it
    const now = { x: inside.x + 60, y: inside.y + 30 };
    await page.mouse.click(now.x, now.y);
    expect((await page.evaluate(() => app.selectedSurfaces.length)) === 1, 'a click should select the surface');
    await page.mouse.click(now.x, now.y);
    expect((await page.evaluate(() => app.selectedSurfaces.length)) === 0, 'a second click should deselect it');
    // the middle button pans in any mode
    await page.click('.tab[data-tab="surfaceDesign"]'); await page.waitForTimeout(200);
    const before = await page.evaluate(() => ({ x: app.panX, v: app.vertices.length }));
    await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down({ button: 'middle' }); await page.mouse.move(box.x + 340, box.y + 300, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    const after = await page.evaluate(() => ({ x: app.panX, v: app.vertices.length }));
    expect(Math.abs(after.x - before.x - 40) < 1 && after.v === before.v, 'middle button drag did not pan (or drew something): ' + JSON.stringify({ before, after }));
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await step('import & export menu and tile list: opens, lists the cuts, offers the right buttons, saves pages', async () => {
    const phone = await page.evaluate(() => innerWidth <= 800);
    const [toggle, section, listBtn] = phone ? ['#btnToggleFileMobile', '#fileCollapsibleMobile', '#btnTileListMobile'] : ['#btnToggleFile', '#fileCollapsible', '#btnTileList'];
    // a known room with cuts (the earlier steps reload the page, which clears the drawing)
    await page.evaluate(() => { const k = 10.8, p = (x, y) => ({ x: x * k, y: y * k }); app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', currentTab: 'tileLayout', zoom: 1, panX: 0, panY: 0 }, tileLayout: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, groutType: 'unknown', bondOffset: 0, rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 }, surface: { vertices: [p(0, 0), p(50, 0), p(50, 38), p(0, 38)], lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } })); });
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250);
    await page.evaluate(() => { if (app.selectedSurfaces.length === 0) app.toggleSurfaceSelection(0); });
    expect(!(await page.isVisible(section)), 'Import & Export should start closed');
    const display = phone ? '#displayCollapsibleMobile' : '#displayCollapsible', displayToggle = phone ? '#btnToggleDisplayMobile' : '#btnToggleDisplay';
    // the phone's Display Options live in the Tile Layout tab; the Import & Export menu is always at the bottom
    if (phone) { await page.click('.tab[data-tab="tileLayout"]'); await page.waitForTimeout(250); }
    if (await page.isVisible(display)) await page.click(displayToggle);   // start from closed
    await page.click(displayToggle);
    expect(await page.isVisible(display), 'Display Options did not open');
    await page.click(toggle);
    expect(!(await page.isVisible(display)), 'opening Import & Export should close Display Options');
    expect(await page.isVisible(section), 'Import & Export section did not open');
    expect(await page.isVisible(phone ? '#btnSketchMobile' : '#btnSketch'), 'Import from Sketch is not in Import & Export');
    await page.click(displayToggle);
    expect(!(await page.isVisible(section)), 'opening Display Options should close Import & Export');
    await page.click(toggle);
    if (phone) { await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(250); }
    expect(await page.isVisible(listBtn), 'Tile and Cut List button is not in the Import & Export menu');
    await page.click(listBtn); await page.waitForSelector('#tileListPages img', { state: 'visible' });
    const info = await page.evaluate(() => ({ pages: document.querySelectorAll('#tileListPages img').length, w: document.querySelector('#tileListPages img').naturalWidth, h: document.querySelector('#tileListPages img').naturalHeight, save: getComputedStyle(document.getElementById('tileListSave')).display, print: getComputedStyle(document.getElementById('tileListPrint')).display }));
    expect(info.pages >= 1 && info.w === 1700 && info.h === 2200, 'unexpected tile list pages: ' + JSON.stringify(info));
    expect(info.save !== 'none' && info.print !== 'none', 'Print and Save buttons should show in a browser');
    // saving in a browser downloads one PNG per page
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tileListSave')]);
    expect(/^tile-and-cut-list.*\.png$/.test(download.suggestedFilename()), 'unexpected file name ' + download.suggestedFilename());
    await page.click('#tileListClose');
    expect(!(await page.isVisible('#tileListOverlay')), 'Tile and Cut List did not close');
    // nothing selected: a message instead of a list
    await page.evaluate(() => { app.selectedSurfaces = []; });
    await page.click(listBtn);
    expect((await page.textContent('#tileListNote')).includes('Select the surfaces'), 'no message when nothing is selected');
    expect((await page.evaluate(() => document.querySelectorAll('#tileListPages img').length)) === 0, 'pages shown with nothing selected');
    await page.click('#tileListClose');
    expect(page.errors.length === 0, page.errors.join(' | '));
  });
  await page.context().close();

  // ---------- sketch import ----------
  const open = async (p) => { await p.evaluate(() => document.getElementById(innerWidth > 800 ? 'btnSketch' : 'btnSketchMobile').click()); await p.waitForSelector('#sketchDialog', { state: 'visible' }); };
  const pick = async (p) => { await p.setInputFiles('#sketchFile', sketchPng); await p.waitForTimeout(400); };

  page = await newPage(viewport);
  await step('sketch import: success loads the room, lands on Surface Design, and finalizes', async () => {
    await mockSketch(page, 200, room);
    await open(page); await pick(page);
    await page.fill('#sketchNotes', 'Island is 5 ft from the left wall');
    await page.click('#sketchConvert'); await page.waitForSelector('#sketchLoad', { state: 'visible' });
    const status = await page.textContent('#sketchStatus');
    expect(/Found 2 outlines/.test(status) && /gemini-3.6-flash/.test(status), 'status line: ' + status);
    expect(await page.isVisible('#sketchWarnings') && /doorway/.test(await page.textContent('#sketchWarnings')), 'warnings not shown');
    expect(await page.isVisible('#sketchWorking'), 'working section hidden');
    await page.click('#sketchLoad'); await page.waitForTimeout(400);
    const s = await state(page);
    expect(s.tab === 'surfaceDesign', 'did not switch to Surface Design: ' + s.tab);
    expect(s.v === 12 && s.l === 12, `expected 12 vertices/lines (outline + cutout), got ${s.v}/${s.l}`);
    await page.click('.tab[data-tab="finalize"]'); await page.waitForTimeout(200);
    expect((await state(page)).surfaces >= 1, 'imported room has no detectable surface');
  });
  await step('sketch import: the island is a hole in the big surface (and selectable on its own)', async () => {
    const info = await page.evaluate(() => ({ n: app.detectedSurfaces.length, withHole: app.detectedSurfaces.filter((x) => x.holes && x.holes.length === 1).length }));
    expect(info.n === 2 && info.withHole === 1, `expected 2 surfaces, one with a hole; got ${JSON.stringify(info)}`);
  });
  await page.context().close();

  const failCases = [
    ['quota', 429, { error: 'x', code: 'quota' }, /not available right now/],
    ['unavailable', 503, { error: 'x', code: 'unavailable', detail: 'gemini 403' }, /not available right now/],
    ['rate limited', 429, { error: 'x', code: 'rate_limited' }, /several sketches/],
    ['not a sketch', 422, { error: 'x', code: 'not_a_sketch' }, /does not look like a sketch/],
    ['no outline', 422, { error: 'x', code: 'no_outline' }, /clear outline/],
    ['server error page', 500, '<html>boom</html>', /Something went wrong/],
    ['endpoint missing (404)', 404, '<html>Not found</html>', /not available right now/],
    ['garbage reply', 200, { hello: 'world' }, /clear outline/],
  ];
  for (const [name, status, body, re] of failCases) {
    await step(`sketch import failure shows a friendly message: ${name}`, async () => {
      const p = await newPage(viewport);
      await mockSketch(p, status, body); await open(p); await pick(p); await p.click('#sketchConvert'); await p.waitForTimeout(500);
      const msg = await p.textContent('#sketchStatus');
      expect(re.test(msg), 'message was: ' + msg);
      expect(!(await p.isVisible('#sketchLoad')), 'Load button visible after a failure');
      expect(!(await p.isDisabled('#sketchConvert')), 'Convert stays disabled after a failure');
      expect(p.errors.length === 0, p.errors.join(' | '));
      await p.context().close();
    });
  }
  await step('sketch import: offline shows a connection message', async () => {
    const p = await newPage(viewport); await p.route('**/api/sketch*', (r) => r.abort('failed')); await open(p); await pick(p); await p.click('#sketchConvert'); await p.waitForTimeout(500);
    expect(/internet connection/.test(await p.textContent('#sketchStatus')), 'message was: ' + await p.textContent('#sketchStatus')); await p.context().close();
  });
  await step('sketch import: progress shows while waiting and Cancel stops it', async () => {
    const p = await newPage(viewport); await mockSketch(p, 200, room, 5000); await open(p); await pick(p); await p.click('#sketchConvert'); await p.waitForTimeout(1200);
    expect(await p.isVisible('#sketchProgress') && /Sending|Reading/.test(await p.textContent('#sketchProgressText')), 'no progress shown');
    await p.click('#sketchCancel'); await p.waitForTimeout(300);
    expect(/Canceled/.test(await p.textContent('#sketchStatus')) && !(await p.isVisible('#sketchProgress')), 'cancel did not work');
    expect(!(await p.isDisabled('#sketchConvert')), 'Convert stays disabled after cancel'); await p.context().close();
  });
  await step('sketch import: no photo chosen asks for one', async () => {
    const p = await newPage(viewport); await open(p); await p.click('#sketchConvert'); expect(/photo/.test(await p.textContent('#sketchStatus')), 'no prompt for a photo'); await p.context().close();
  });
  await step('sketch import: replacing an existing drawing asks first, and "no" keeps it', async () => {
    const p = await newPage(viewport); p.removeAllListeners('dialog'); let asked = false; p.on('dialog', (d) => { asked = true; d.dismiss(); });
    await drawRectangle(p); await mockSketch(p, 200, room); await open(p); await pick(p); await p.click('#sketchConvert'); await p.waitForSelector('#sketchLoad', { state: 'visible' }); await p.click('#sketchLoad'); await p.waitForTimeout(300);
    expect(asked && (await state(p)).v === 4, 'drawing was replaced without asking, or the question was not asked'); await p.context().close();
  });
}

await step('app save dialog: the design and the layout image go to the native Save dialog; cancelling says nothing; an older app falls back to sharing', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  await drawRectangle(p);
  const r = await p.evaluate(async () => {
    const calls = [];
    let answer = (o) => ({ saved: true, name: 'My kitchen (1).json' });
    window.Capacitor = { Plugins: { FileSaver: { saveFile: async (o) => { calls.push(o); return answer(o); } } } };
    document.getElementById('saveFileName').value = 'Kitchen';
    await app.saveDesignFile();
    const saved = { call: calls[0], status: document.getElementById('saveLoadStatus').textContent, box: document.getElementById('saveFileName').value };
    answer = () => ({ saved: false });
    document.getElementById('saveLoadStatus').textContent = '';
    await app.saveDesignFile();
    const cancelled = { status: document.getElementById('saveLoadStatus').textContent, calls: calls.length };
    await app.saveAsImage();
    const image = calls[calls.length - 1];
    window.Capacitor = { Plugins: {} };   // an app build without the Save dialog: nothing is called
    const before = calls.length;
    let shared = false;
    app.shareImages = async () => { shared = true; };
    await app.saveAsImage();
    return { saved, cancelled, image: { filename: image.filename, mimeType: image.mimeType, head: image.data.slice(0, 8) }, fallbackCalls: calls.length - before, shared };
  });
  const decoded = JSON.parse(Buffer.from(r.saved.call.data, 'base64').toString('utf8'));
  expect(r.saved.call.filename === 'Kitchen.json' && r.saved.call.mimeType === 'application/json' && decoded.format === 'tile-planner-design', 'design save call is wrong: ' + JSON.stringify(r.saved.call).slice(0, 200));
  expect(/My kitchen \(1\)\.json/.test(r.saved.status) && r.saved.box === 'My kitchen (1)', 'the name chosen in the dialog should be shown and kept: ' + JSON.stringify(r.saved));
  expect(r.cancelled.status === '' && r.cancelled.calls === 2, 'cancelling should say nothing: ' + JSON.stringify(r.cancelled));
  expect(r.image.filename === 'tile-layout.png' && r.image.mimeType === 'image/png' && r.image.head === 'iVBORw0K', 'image save call is wrong: ' + JSON.stringify(r.image));
  expect(r.fallbackCalls === 0 && r.shared, 'an older app should share the image instead');
  await p.context().close();
});

await step('app crash report: shows why the app last closed once, and says nothing when there is nothing', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  p.removeAllListeners('dialog');
  const shown = [];
  p.on('dialog', (d) => { shown.push(d.message()); d.accept(); });
  await p.evaluate(async () => {
    window.Capacitor = { Plugins: { FileSaver: { lastCrash: async () => ({ text: 'java.lang.OutOfMemoryError: example' }) } } };
    await app.reportLastCrash();
    window.Capacitor = { Plugins: { FileSaver: { lastCrash: async () => ({}) } } };
    await app.reportLastCrash();
    window.Capacitor = { Plugins: { FileSaver: {} } };   // an older app build
    await app.reportLastCrash();
  });
  expect(shown.length === 1 && /closed unexpectedly/.test(shown[0]) && /OutOfMemoryError/.test(shown[0]), 'crash report dialogs were: ' + JSON.stringify(shown));
  await p.context().close();
});

await step('layout image: full size in a browser, kept small in the app (low memory)', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  await drawRectangle(p);
  const dims = await p.evaluate(() => {
    const size = (u) => { const b = atob(u.split(',')[1].slice(0, 40)); const n = (i) => (b.charCodeAt(i) << 24 | b.charCodeAt(i + 1) << 16 | b.charCodeAt(i + 2) << 8 | b.charCodeAt(i + 3)) >>> 0; return { w: n(16), h: n(20) }; };
    const browser = size(app.renderLayoutImage());
    window.Capacitor = { Plugins: {} };
    const inApp = size(app.renderLayoutImage());
    return { browser, inApp };
  });
  expect(dims.browser.w * dims.browser.h > 5e6, 'a browser should get the full size picture: ' + JSON.stringify(dims.browser));
  expect(dims.inApp.w * dims.inApp.h <= 3.6e6 && dims.inApp.w > 1500, 'the app picture should be about 3.5 million pixels: ' + JSON.stringify(dims.inApp));
  await p.context().close();
});

await step('cut piece pictures: equal parallel edges close together get one label (both sides of a notch), far apart ones keep both', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  const texts = await p.evaluate(() => {
    const seen = [];
    const c = new Proxy({}, { get: (t, k) => k === 'measureText' ? (s) => ({ width: s.length * 13 }) : k === 'fillText' ? (s) => seen.push(s) : () => {}, set: () => true });
    const ring = [[0, 0], [8, 0], [8, 6], [16, 6], [16, 0], [24, 0], [24, 12], [0, 12]].map(([x, y]) => ({ x, y, u: true }));
    app.drawCutPiece(c, { ring, holes: [] }, 0, 0, 600, 300, (n) => n.toFixed(2) + '"');
    return seen;
  });
  const count = (t) => texts.filter((x) => x === t).length;
  expect(count('6.00"') === 1, 'the two 6.00" sides of the notch should be labelled once: ' + JSON.stringify(texts));
  expect(count('12.00"') === 2 && count('24.00"') === 1, 'the 12.00" sides are far apart and keep both labels: ' + JSON.stringify(texts));
  await p.context().close();
});

await step('islands smaller than a tile: their cut tiles get labels, are in the Tile and Cut List, and are not counted as whole tiles', async () => {
  const K = 10.8;
  const design = (island) => JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', snapMode: 'auto', currentTab: 'surfaceDesign', zoom: 1, panX: 40, panY: 40 },
    tileLayout: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0.125, tileDepthInches: 0.5, bondOffset: 0, pattern: 'grid', rotationDegrees: 0, offsetXInches: 0, offsetYInches: 0 },
    surface: { vertices: [[0, 0], [90, 0], [90, 80], [0, 80], ...island].map(([x, y]) => ({ x: x * K, y: y * K })), lines: [[0, 1], [1, 2], [2, 3], [3, 0], ...(island.length ? [[4, 5], [5, 6], [6, 7], [7, 4]] : [])] } });
  const p = await newPage({ width: 1280, height: 800 });
  const measure = async (island) => {
    await p.evaluate((j) => app.importDesign(j), design(island));
    await p.click('.tab[data-tab="finalize"]'); await p.waitForTimeout(250);
    return p.evaluate(() => {
      app.selectedSurfaces = [0]; app.updateTileCount(); app.panX = 40; app.panY = 40; app.zoom = 1.1;
      const labels = []; const draw = app.drawMeasurementLabel.bind(app);
      app.drawMeasurementLabel = (c, t, m, a) => { labels.push(t); return draw(c, t, m, a); };
      app.redraw(); app.drawMeasurementLabel = draw;
      const row = (label) => [...document.querySelectorAll('#tileCountSummary .count-row')].find((r) => r.textContent.startsWith(label));
      const count = (label) => parseInt(row(label).querySelector('.count-value').textContent, 10);
      const list = app.computeCutList();
      return { labels, full: count('Full tiles'), total: count('Estimated tiles'), groups: list.groups.length, withHole: list.groups.filter((g) => g.holes && g.holes.length).length };
    });
  };
  const none = await measure([]);
  const inside = await measure([[38, 38], [44, 38], [44, 43], [38, 43]]);            // 6 x 5 in, inside one 12 in tile
  const straddle = await measure([[46, 38], [51, 38], [51, 42], [46, 42]]);          // 5 x 4 in, across a joint
  expect(['6.00"', '5.00"'].every((t) => inside.labels.includes(t)), 'an island inside one tile should be labelled 6.00" and 5.00": ' + JSON.stringify(inside.labels));
  expect(straddle.labels.includes('4.00"') && straddle.labels.includes('2.38"'), 'an island across a joint should be labelled on both tiles: ' + JSON.stringify(straddle.labels));
  expect(inside.withHole === 1 && straddle.groups > none.groups, 'the Tile and Cut List should include the cut tile(s): ' + JSON.stringify({ none, inside, straddle }));
  expect(inside.full === none.full - 1 && straddle.full === none.full - 2 && inside.total === none.total && straddle.total === none.total, 'the tiles with an island are not whole tiles, and the total is unchanged: ' + JSON.stringify({ none, inside, straddle }));
  await p.context().close();
});

await step('hopscotch: the second tile fields appear with 8 x 8, the two sizes fit with no gaps or overlaps, and it saves and loads', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  expect(!(await p.isVisible('#tile2Row')), 'the second tile fields should be hidden for a grid');
  await p.selectOption('#tilePattern', 'hopscotch');
  expect(await p.isVisible('#tile2Row'), 'the second tile fields should show for hopscotch');
  const defaults = await p.evaluate(() => [parseFloat(document.getElementById('tile2Width').value), parseFloat(document.getElementById('tile2Height').value)]);
  expect(defaults[0] === 8 && defaults[1] === 8, 'the second tile should start at 8 x 8: ' + defaults);
  await p.selectOption('#tilePattern', 'basketweave');
  expect(!(await p.isVisible('#tile2Row')), 'the second tile fields should hide again for other patterns');
  await p.selectOption('#tilePattern', 'hopscotch');
  // any two sizes: tile slots (tile + grout) never overlap, and cover every point of a window
  const result = await p.evaluate(() => {
    const out = [];
    for (const [W, H, w, h, g] of [[12, 12, 6, 6, 0.125], [24, 12, 8, 8, 0.125], [12, 24, 8, 4, 0], [10, 10, 3, 7, 0.25], [8, 8, 8, 8, 0.125]]) {
      app.tileWidthInches = W; app.tileHeightInches = H; app.tile2WidthInches = w; app.tile2HeightInches = h; app.groutWidthInches = g;
      const k = CONFIG.PIXELS_PER_INCH, layout = app.getLayout(), gp = g * k;
      const tiles = layout.tilesIn(-400, -400, 1400, 1400).map((t) => ({ x: t.x, y: t.y, x2: t.x + t.w + gp, y2: t.y + t.h + gp, big: t.w === W * k && t.h === H * k }));
      let overlaps = 0, holes = 0;
      for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
        const a = tiles[i], b = tiles[j];
        if (a.x < b.x2 - 1e-6 && b.x < a.x2 - 1e-6 && a.y < b.y2 - 1e-6 && b.y < a.y2 - 1e-6) overlaps++;
      }
      for (let x = 100; x < 900; x += 13.7) for (let y = 100; y < 900; y += 13.3) if (!tiles.some((t) => x >= t.x && x < t.x2 && y >= t.y && y < t.y2)) holes++;
      out.push({ size: [W, H, w, h, g], overlaps, holes, bigs: tiles.filter((t) => t.big).length, smalls: tiles.filter((t) => !t.big).length });
    }
    return out;
  });
  for (const r of result) expect(r.overlaps === 0 && r.holes === 0 && r.bigs > 3 && (r.smalls > 3 || (r.size[0] === r.size[2] && r.size[1] === r.size[3])), 'hopscotch has gaps or overlaps: ' + JSON.stringify(r));
  // save and load keep it
  await p.evaluate(() => { app.tileWidthInches = 14; app.tileHeightInches = 14; app.tile2WidthInches = 5; app.tile2HeightInches = 9; app.groutWidthInches = 0.125; app.vertices = []; app.lines = []; });
  const saved = await p.evaluate(() => app.exportDesign());
  const tl = JSON.parse(saved).tileLayout;
  expect(tl.pattern === 'hopscotch' && tl.tile2WidthInches === 5 && tl.tile2HeightInches === 9, 'the second tile should be saved: ' + JSON.stringify(tl));
  await p.evaluate(() => { app.tile2WidthInches = 8; app.tile2HeightInches = 8; app.pattern = 'grid'; });
  await p.evaluate((j) => app.importDesign(j), saved);
  const back = await p.evaluate(() => ({ pattern: app.pattern, w: app.tile2WidthInches, h: app.tile2HeightInches, shown: getComputedStyle(document.getElementById('tile2Row')).display }));
  expect(back.pattern === 'hopscotch' && back.w === 5 && back.h === 9 && back.shown !== 'none', 'the design did not load back as it was saved: ' + JSON.stringify(back));
  // an old design with no second tile still opens, with 8 x 8 ready
  await p.evaluate(() => { app.tile2WidthInches = 3; });
  await p.evaluate((j) => app.importDesign(j), JSON.stringify({ ...JSON.parse(saved), tileLayout: { ...tl, pattern: 'grid', tile2WidthInches: undefined, tile2HeightInches: undefined } }));
  expect(await p.evaluate(() => app.pattern === 'grid'), 'a grid design should load as a grid');
  await p.context().close();
});

await step('hexagon: width is across the flats, the height box is worked out and locked, the hexagons fit, every piece is accounted for, and it saves and loads', async () => {
  const K = 10.8;
  const design = (rot) => JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', snapMode: 'auto', currentTab: 'surfaceDesign', zoom: 1, panX: 40, panY: 40 },
    tileLayout: { tileWidthInches: 8, tileHeightInches: 12, groutWidthInches: 0.25, tileDepthInches: 0.5, bondOffset: 0, pattern: 'hexagon', rotationDegrees: rot, offsetXInches: 1.5, offsetYInches: 0 },
    surface: { vertices: [[0, 0], [60, 0], [60, 40], [0, 40], [24, 14], [34, 14], [34, 22], [24, 22]].map(([x, y]) => ({ x: x * K, y: y * K })), lines: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]] } });
  const p = await newPage({ width: 1280, height: 800 });
  await p.evaluate((j) => app.importDesign(j), design(0));
  const ui = await p.evaluate(() => ({ disabled: document.getElementById('tileHeight').disabled, height: parseFloat(document.getElementById('tileHeight').value), hint: document.getElementById('weaveHint').style.display, tile2: document.getElementById('tile2Row').style.display }));
  expect(ui.disabled && Math.abs(ui.height - 8 * 2 / Math.sqrt(3)) < 0.01 && ui.hint !== 'none' && ui.tile2 === 'none', 'the hexagon height box should be locked at the worked-out height: ' + JSON.stringify(ui));
  await p.fill('#tileWidth', '10'); await p.waitForTimeout(100);
  expect(Math.abs(parseFloat(await p.inputValue('#tileHeight')) - 10 * 2 / Math.sqrt(3)) < 0.01, 'the height box should follow the width');
  await p.fill('#tileWidth', '8');
  await p.selectOption('#tilePattern', 'grid');
  const back = await p.evaluate(() => ({ disabled: document.getElementById('tileHeight').disabled, height: parseFloat(document.getElementById('tileHeight').value) }));
  expect(!back.disabled && back.height === 12, 'leaving hexagon should give back the typed height (12): ' + JSON.stringify(back));
  await p.selectOption('#tilePattern', 'hexagon');
  // the hexagons: equal, one joint apart, no gaps (every sample point is in some hexagon's grout box)
  const geometry = await p.evaluate(() => {
    const k = CONFIG.PIXELS_PER_INCH, layout = app.getLayout(), F = 8 * k, g = 0.25 * k;
    const tiles = layout.tilesIn(-300, -300, 1200, 1200);
    const areas = tiles.map((t) => Math.abs(ringArea(t.poly.map((c) => ({ x: c.x, y: c.y })))));
    let tooClose = 0, holes = 0;
    const centres = tiles.map((t) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 }));
    for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) if (Math.hypot(centres[i].x - centres[j].x, centres[i].y - centres[j].y) < F + g - 1e-6) tooClose++;
    for (let x = 100; x < 900; x += 11.3) for (let y = 100; y < 900; y += 10.9) if (!tiles.some((t) => pointInPolygon({ x, y }, t.slot))) holes++;
    return { count: tiles.length, areaSpread: Math.max(...areas) - Math.min(...areas), area: areas[0] / (k * k), tooClose, holes };
  });
  expect(geometry.tooClose === 0 && geometry.holes === 0 && geometry.areaSpread < 1e-6 && Math.abs(geometry.area - Math.sqrt(3) / 2 * 64) < 0.01, 'the hexagons do not fit: ' + JSON.stringify(geometry));
  // every piece is accounted for: whole tiles plus cut pieces cover the surface less the grout, at 0 and 30 degrees
  for (const rot of [0, 30]) {
    await p.evaluate((j) => app.importDesign(j), design(rot));
    await p.click('.tab[data-tab="finalize"]'); await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      app.selectedSurfaces = [0]; app.updateTileCount();
      const area = app.computeSurfaceArea(app.detectedSurfaces[0]);
      const list = app.computeCutList();
      const pieceArea = list.groups.reduce((sum, grp) => sum + grp.qty * (Math.abs(ringArea(grp.ring)) - grp.holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0)), 0);
      const full = parseInt([...document.querySelectorAll('#tileCountSummary .count-row')].find((row) => row.textContent.startsWith('Full tiles')).querySelector('.count-value').textContent, 10);
      const labels = []; const draw = app.drawMeasurementLabel.bind(app);
      app.drawMeasurementLabel = (c, t, m, a) => { labels.push(t); return draw(c, t, m, a); };
      app.redraw(); app.drawMeasurementLabel = draw;
      return { area, covered: full * (Math.sqrt(3) / 2) * 64 + pieceArea, labels: labels.length, pieces: list.pieces };
    });
    const ratio = r.covered / r.area;
    expect(ratio > 0.9 && ratio <= 1.0001, `hexagon tiles and pieces should cover the surface less its grout at ${rot} degrees: ` + JSON.stringify(r));
    expect(r.labels > 10 && r.pieces > 10, `cut hexagons should be labelled and listed at ${rot} degrees: ` + JSON.stringify(r));
  }
  // save and load
  const saved = JSON.parse(await p.evaluate(() => app.exportDesign()));
  expect(saved.tileLayout.pattern === 'hexagon' && saved.tileLayout.tileWidthInches === 8, 'hexagon should be saved: ' + JSON.stringify(saved.tileLayout));
  await p.context().close();
});

await step('pinwheel: the grout is worked out from the rectangle and the square, the tiles fit, every piece is accounted for, and a square that does not fit says so', async () => {
  const K = 10.8;
  const design = (rot, w, h, sq, bond = 0) => JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'sixtyfourth', snapMode: 'auto', currentTab: 'surfaceDesign', zoom: 1, panX: 40, panY: 40 },
    tileLayout: { tileWidthInches: w, tileHeightInches: h, tile2WidthInches: sq, groutWidthInches: 0.125, tileDepthInches: 0.5, bondOffset: bond, pattern: 'pinwheel', rotationDegrees: rot, offsetXInches: 1, offsetYInches: 0 },
    surface: { vertices: [[0, 0], [48, 0], [48, 34], [0, 34], [14, 10], [22, 10], [22, 16], [14, 16]].map(([x, y]) => ({ x: x * K, y: y * K })), lines: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4]] } });
  const p = await newPage({ width: 1280, height: 800 });
  // choosing the pattern starts with the square that fits the rectangle and the grout in use
  await p.selectOption('#tilePattern', 'pinwheel');
  const start = await p.evaluate(() => ({ square: app.tile2WidthInches, grout: app.effectiveGrout(), row: document.getElementById('tile2Row').style.display, heightBox: document.getElementById('tile2Height').closest('.input-group').style.display }));
  expect(start.row !== 'none' && start.heightBox === 'none' && Math.abs(start.square + start.grout - 12) < 1e-6, 'a pinwheel should start with a square that fits (24 x 12 gives 12): ' + JSON.stringify(start));
  // a fitting pair: 8 x 4 with a 3 51/64 square leaves a 13/64 grout, shown locked and in fractions
  await p.evaluate((j) => app.importDesign(j), design(0, 8, 4, 3.796875));
  const ui = await p.evaluate(() => ({ locked: document.getElementById('groutWidth').disabled, grout: parseFloat(document.getElementById('groutWidth').value), hint: document.getElementById('weaveHint').textContent, label: document.getElementById('labelTile2Width').textContent }));
  expect(ui.locked && Math.abs(ui.grout - 0.203) < 0.001 && /13\/64/.test(ui.hint) && /Square side/.test(ui.label), 'the grout should be worked out and locked: ' + JSON.stringify(ui));
  // the tiles fit: slots (tile + grout) never overlap and leave no gap
  const geometry = await p.evaluate(() => {
    const out = [];
    for (const bond of [0, 0.5, 0.3333]) {
    app.bondOffset = bond;
    const k = CONFIG.PIXELS_PER_INCH, layout = app.getLayout(), g = layout.groutW;
    const tiles = layout.tilesIn(-300, -300, 1200, 1200).map((t) => ({ x: t.x, y: t.y, x2: t.x + t.w + g, y2: t.y + t.h + g, sq: t.w === t.h }));
    let overlaps = 0, holes = 0;
    for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i], b = tiles[j];
      if (a.x < b.x2 - 1e-6 && b.x < a.x2 - 1e-6 && a.y < b.y2 - 1e-6 && b.y < a.y2 - 1e-6) overlaps++;
    }
    for (let x = 100; x < 900; x += 13.7) for (let y = 100; y < 900; y += 13.3) if (!tiles.some((t) => x >= t.x && x < t.x2 && y >= t.y && y < t.y2)) holes++;
    out.push({ bond, overlaps, holes, squares: tiles.filter((t) => t.sq).length, rects: tiles.filter((t) => !t.sq).length });
    }
    app.bondOffset = 0;
    return out;
  });
  for (const r of geometry) expect(r.overlaps === 0 && r.holes === 0 && r.squares > 5 && r.rects / r.squares > 3.5 && r.rects / r.squares < 5, 'the pinwheel does not fit (row offset ' + r.bond + '): ' + JSON.stringify(r));
  // every piece is accounted for, for a wide rectangle, a tall one and a turned layout
  for (const [rot, w, h, sq, bond] of [[0, 8, 4, 3.796875, 0], [30, 4, 6, 1.875, 0], [0, 6, 12, 5.8125, 0], [0, 8, 4, 3.796875, 0.5]]) {
    await p.evaluate((j) => app.importDesign(j), design(rot, w, h, sq, bond));
    await p.click('.tab[data-tab="finalize"]'); await p.waitForTimeout(250);
    const r = await p.evaluate(() => {
      app.selectedSurfaces = [0]; app.updateTileCount();
      const area = app.computeSurfaceArea(app.detectedSurfaces[0]);
      const list = app.computeCutList();
      const pieceArea = list.groups.reduce((sum, grp) => sum + grp.qty * (Math.abs(ringArea(grp.ring)) - grp.holes.reduce((s, h2) => s + Math.abs(ringArea(h2)), 0)), 0);
      const full = parseInt([...document.querySelectorAll('#tileCountSummary .count-row')].find((row) => row.textContent.startsWith('Full tiles')).querySelector('.count-value').textContent, 10);
      const layout = app.getLayout(), ppi = CONFIG.PIXELS_PER_INCH;
      // the whole tiles are a mix of rectangles and squares: count each kind
      let fullArea = 0;
      for (const surfaceIdx of app.selectedSurfaces) {
        const surface = app.detectedSurfaces[surfaceIdx], rings = app.surfaceRings(layout, surface);
        const xs = app.getSurfaceOuterBoundary(surface).map((i) => app.vertices[i].x), ys = app.getSurfaceOuterBoundary(surface).map((i) => app.vertices[i].y);
        for (const tile of layout.tilesCovering(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), layout.reach * 2)) {
          if (!app.analyzeTileIntersectionWithSurface(tile.corners, surface, layout.tileW, layout.tileH)) { if (rings.outer.length && app.pointInSurface({ x: (tile.corners[0].x + tile.corners[2].x) / 2, y: (tile.corners[0].y + tile.corners[2].y) / 2 }, surface)) fullArea += (tile.w / ppi) * (tile.h / ppi); continue; }
          const c = app.clipTile(tile, rings);
          if (c.full) fullArea += (tile.w / ppi) * (tile.h / ppi);
        }
      }
      return { area, covered: fullArea + pieceArea, grout: app.effectiveGrout(), full };
    });
    const ratio = r.covered / r.area;
    expect(ratio > 0.9 && ratio <= 1.0001, `pinwheel tiles and pieces should cover the surface less its grout (${rot} deg, ${w} x ${h}): ` + JSON.stringify(r));
  }
  // a square that is too big, and a rectangle that is not one
  await p.evaluate((j) => app.importDesign(j), design(0, 8, 4, 4.5));
  const tooBig = await p.evaluate(() => ({ locked: document.getElementById('groutWidth').disabled, hint: document.getElementById('weaveHint').textContent, color: document.getElementById('weaveHint').style.color, layoutPattern: app.getLayout().pattern }));
  expect(!tooBig.locked && /smaller than/.test(tooBig.hint) && tooBig.color !== '' && tooBig.layoutPattern === 'grid', 'a square that is too big should say so and lay a plain grid: ' + JSON.stringify(tooBig));
  await p.evaluate((j) => app.importDesign(j), design(0, 6, 6, 2));
  const notARectangle = await p.evaluate(() => document.getElementById('weaveHint').textContent);
  expect(/needs a rectangle/.test(notARectangle), 'a square tile should be told a pinwheel needs a rectangle: ' + notARectangle);
  // save and load
  await p.evaluate((j) => app.importDesign(j), design(0, 8, 4, 3.796875));
  const saved = JSON.parse(await p.evaluate(() => app.exportDesign()));
  expect(saved.tileLayout.pattern === 'pinwheel' && saved.tileLayout.tile2WidthInches === 3.796875, 'pinwheel should be saved: ' + JSON.stringify(saved.tileLayout));
  await p.context().close();
});

await step('typing in the tile height and grout boxes is never overwritten, in every pattern', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  for (const pattern of ['grid', 'stepped', 'herringbone', 'basketweave', 'hopscotch', 'pinwheel', 'hexagon', 'grid']) {
    await p.selectOption('#tilePattern', pattern);
    if (pattern === 'hexagon') { expect(await p.isDisabled('#tileHeight'), 'the hexagon height box should be locked'); continue; }
    expect(!(await p.isDisabled('#tileHeight')), `the height box should be editable for ${pattern}`);
    await p.click('#tileHeight', { clickCount: 3 }); await p.keyboard.type('15');
    expect((await p.inputValue('#tileHeight')) === '15', `typing 15 in the height box for ${pattern} gave ${await p.inputValue('#tileHeight')}`);
    expect(await p.evaluate(() => app.tileHeightInches) === 15, `the height should be 15 for ${pattern}`);
    await p.click('#tileHeight', { clickCount: 3 }); await p.keyboard.press('Backspace');
    expect((await p.inputValue('#tileHeight')) === '', `the height box should be able to be emptied for ${pattern}`);
    await p.keyboard.type('12');
    if (!(await p.isDisabled('#groutWidth'))) {
      await p.click('#groutWidth', { clickCount: 3 }); await p.keyboard.type('0.2');
      expect((await p.inputValue('#groutWidth')) === '0.2', `typing 0.2 in the grout box for ${pattern} gave ${await p.inputValue('#groutWidth')}`);
    }
  }
  await p.context().close();
});

await step('distance tool: shown where there is a mouse, hidden on a touch screen, and its colour is a Display Options setting', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  await p.click('.tab[data-tab="surfaceDesign"]');
  expect(await p.isVisible('#distanceTool'), 'the distance tool should show with a mouse');
  await p.evaluate(() => {
    window.__strokes = new Set();
    const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'strokeStyle');
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'strokeStyle', { set(v) { window.__strokes.add(String(v).toLowerCase()); d.set.call(this, v); }, get() { return d.get.call(this); } });
  });
  await drawRectangle(p);
  const draws = async () => p.evaluate(() => {
    window.__strokes.clear();
    app.distanceToolEnabled = true;
    const a = app.vertices[0], b = app.vertices[2];
    app.mousePos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    app.redraw();
    return [...window.__strokes];
  });
  const first = await draws();
  expect(first.includes('#b8860b'), 'the distance tool should draw in its default colour, a dark gold: ' + JSON.stringify(first));
  await p.evaluate(() => { app.displayColors.distance = '#112233'; });
  const second = await draws();
  expect(second.includes('#112233') && !second.includes('#b8860b'), 'the distance tool should use the colour chosen in Display Options: ' + JSON.stringify(second));
  const names = await p.evaluate(() => [...document.querySelectorAll('#displayCollapsible input[type="color"]')].map((i) => i.dataset.key));
  expect(names.includes('distance'), 'Display Options should have a Distance tool colour: ' + JSON.stringify(names));
  await p.context().close();
  // a touch screen cannot hover: no distance tool, and a design saved with it on loads with it off
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const t = await ctx.newPage();
  await t.goto(url); await t.waitForTimeout(300);
  await t.click('.tab[data-tab="surfaceDesign"]');
  expect(!(await t.isVisible('#distanceTool')), 'the distance tool should be hidden on a touch screen');
  const loaded = await t.evaluate(() => {
    const k = 10.8;
    app.importDesign(JSON.stringify({ format: 'tile-planner-design', version: '1.1', appState: { unitMode: 'decimal2', snapMode: 'auto', distanceToolEnabled: true, currentTab: 'surfaceDesign', zoom: 1, panX: 0, panY: 0 },
      tileLayout: { tileWidthInches: 12, tileHeightInches: 12, groutWidthInches: 0, pattern: 'grid' }, surface: { vertices: [[0, 0], [60, 0], [60, 40], [0, 40]].map(([x, y]) => ({ x: x * k, y: y * k })), lines: [[0, 1], [1, 2], [2, 3], [3, 0]] } }));
    return app.distanceToolEnabled;
  });
  expect(loaded === false, 'a design saved with the distance tool on should open with it off on a touch screen');
  await ctx.close();
});

await step('sketch reader key: switched off, so nothing about it shows and no key is ever sent', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  await p.evaluate(() => { localStorage.setItem('tilePlanner_sketchKey', 'AIzaSyTestKey_1234567890abcdefghijklmnopq'); });
  const seen = [];
  await p.route('**/api/sketch*', async (r) => { seen.push(r.request().headers()['x-gemini-key'] || null); await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(room) }); });
  await p.evaluate(() => document.getElementById('btnToggleFile').click());
  expect(!(await p.isVisible('#btnSketchKey')), 'the Sketch reader key menu item should be hidden while the feature is off');
  await p.evaluate(() => document.getElementById('btnSketch').click()); await p.waitForSelector('#sketchDialog', { state: 'visible' });
  expect(!(await p.isVisible('#sketchOwnKey')), 'the own-key note should not show');
  await p.setInputFiles('#sketchFile', sketchPng); await p.waitForTimeout(400);
  await p.click('#sketchConvert'); await p.waitForSelector('#sketchLoad', { state: 'visible' });
  expect(seen.length === 1 && seen[0] === null, 'no key should be sent while the feature is off, even if one was saved: ' + JSON.stringify(seen));
  await p.context().close();
});

await step('sketch reader key (when switched on): saved only on the device, checked, sent with each sketch, removable, and never put in a design', async () => {
  const p = await newPage({ width: 1280, height: 800 });
  await p.evaluate(() => { CONFIG.SKETCH_OWN_KEY = true; app.updateSketchKeyMenu(); try { localStorage.removeItem('tilePlanner_sketchKey'); } catch (e) { /* ignore */ } });
  const seen = [];
  await p.route('**/api/sketch*', async (r) => { seen.push(r.request().headers()['x-gemini-key'] || null); await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(room) }); });
  await p.evaluate(() => document.getElementById('btnToggleFile').click());
  expect(await p.isVisible('#btnSketchKey'), 'the Import & Export menu should have Sketch reader key');
  await p.click('#btnSketchKey');
  await p.waitForSelector('#sketchKeyDialog', { state: 'visible' });
  expect(/No key saved/.test(await p.textContent('#sketchKeyStatus')) && await p.isDisabled('#sketchKeyRemove'), 'it should start with no key');
  await p.fill('#sketchKeyInput', 'short key'); await p.click('#sketchKeySave');
  expect(/does not look like a key/.test(await p.textContent('#sketchKeyStatus')) && !(await p.evaluate(() => localStorage.getItem('tilePlanner_sketchKey'))), 'a bad key should be refused');
  const good = 'AIzaSyTestKey_1234567890abcdefghijklmnopq';
  await p.fill('#sketchKeyInput', '  ' + good + '  '); await p.click('#sketchKeySave');
  expect(await p.evaluate(() => localStorage.getItem('tilePlanner_sketchKey')) === good && /Saved on this device/.test(await p.textContent('#sketchKeyStatus')), 'a good key should be saved, trimmed');
  expect((await p.inputValue('#sketchKeyInput')) === '', 'the key box should be emptied after saving');
  await p.click('#sketchKeyClose');
  // it is sent with the sketch, and the sketch dialog says so
  await p.evaluate(() => document.getElementById('btnSketch').click()); await p.waitForSelector('#sketchDialog', { state: 'visible' });
  expect(await p.isVisible('#sketchOwnKey'), 'the sketch dialog should say your own key is in use');
  await p.setInputFiles('#sketchFile', sketchPng); await p.waitForTimeout(400);
  await p.click('#sketchConvert'); await p.waitForSelector('#sketchLoad', { state: 'visible' });
  expect(seen.length === 1 && seen[0] === good, 'the key should be sent with the sketch: ' + JSON.stringify(seen));
  // the design file never has it
  expect(!(await p.evaluate(() => app.exportDesign())).includes('AIza'), 'the key must not be in a saved design');
  // Google rejecting it, and its limit, are said plainly
  await p.unroute('**/api/sketch*');
  await p.route('**/api/sketch*', (r) => r.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: 'bad_key' }) }));
  await p.click('#sketchConvert'); await p.waitForTimeout(500);
  expect(/did not accept your key/.test(await p.textContent('#sketchStatus')), 'a rejected key should say so: ' + await p.textContent('#sketchStatus'));
  await p.unroute('**/api/sketch*');
  await p.route('**/api/sketch*', (r) => r.fulfill({ status: 429, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: 'quota' }) }));
  await p.click('#sketchConvert'); await p.waitForTimeout(500);
  expect(/Your key has reached its usage limit/.test(await p.textContent('#sketchStatus')), 'a key at its limit should say so: ' + await p.textContent('#sketchStatus'));
  await p.click('#sketchClose');
  // remove it: the next sketch goes without a key
  await p.evaluate(() => document.getElementById('btnSketchKey').click());
  await p.click('#sketchKeyRemove');
  expect(await p.evaluate(() => localStorage.getItem('tilePlanner_sketchKey')) === null && /Key removed/.test(await p.textContent('#sketchKeyStatus')), 'the key should be removed');
  await p.unroute('**/api/sketch*');
  seen.length = 0;
  await p.route('**/api/sketch*', async (r) => { seen.push(r.request().headers()['x-gemini-key'] || null); await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(room) }); });
  await p.click('#sketchKeyClose');
  await p.evaluate(() => document.getElementById('btnSketch').click()); await p.waitForSelector('#sketchDialog', { state: 'visible' });
  expect(!(await p.isVisible('#sketchOwnKey')), 'the own-key note should go');
  await p.click('#sketchConvert'); await p.waitForSelector('#sketchLoad', { state: 'visible' });
  expect(seen.length === 1 && seen[0] === null, 'without a key, none should be sent: ' + JSON.stringify(seen));
  await p.context().close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
