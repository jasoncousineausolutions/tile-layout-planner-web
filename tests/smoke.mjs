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

  await step('Save / Load round trip keeps the design', async () => {
    const before = await page.evaluate(() => JSON.stringify({ v: app.vertices, l: app.lines }));
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.waitForSelector('#saveLoadDialog', { state: 'visible' });
    const saved = await page.inputValue('#saveLoadTextarea');
    await page.click('#saveLoadClose');
    await page.evaluate(() => app.clearAll());
    expect((await state(page)).v === 0, 'clear all failed');
    await page.evaluate(() => document.getElementById('btnSaveLoad').click());
    await page.fill('#saveLoadTextarea', saved); await page.click('#saveLoadLoad'); await page.waitForTimeout(1000);
    const after = await page.evaluate(() => JSON.stringify({ v: app.vertices, l: app.lines }));
    expect(after === before, 'design changed after save and load');
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
    await page.click(sec + ' .display-colors button');
    expect((await page.evaluate(() => app.displayColors.cutLabel)) === '#cc0000', 'Reset colours did not restore the default');
    await page.evaluate(() => { const el = document.querySelector('.label-size-select'); el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); });
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
    expect(await page.isVisible(listBtn), 'Tile List button is not in the File section');
    await page.click(listBtn); await page.waitForSelector('#tileListPages img', { state: 'visible' });
    const info = await page.evaluate(() => ({ pages: document.querySelectorAll('#tileListPages img').length, w: document.querySelector('#tileListPages img').naturalWidth, h: document.querySelector('#tileListPages img').naturalHeight, save: getComputedStyle(document.getElementById('tileListSave')).display, print: getComputedStyle(document.getElementById('tileListPrint')).display }));
    expect(info.pages >= 1 && info.w === 1700 && info.h === 2200, 'unexpected tile list pages: ' + JSON.stringify(info));
    expect(info.save !== 'none' && info.print !== 'none', 'Print and Save buttons should show in a browser');
    // saving in a browser downloads one PNG per page
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tileListSave')]);
    expect(/^tile-list.*\.png$/.test(download.suggestedFilename()), 'unexpected file name ' + download.suggestedFilename());
    await page.click('#tileListClose');
    expect(!(await page.isVisible('#tileListOverlay')), 'Tile List did not close');
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

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
