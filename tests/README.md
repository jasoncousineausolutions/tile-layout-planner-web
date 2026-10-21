# Smoke test

`smoke.mjs` opens `index.html` in a real Chromium browser (desktop and phone sizes) and does what a person would, with real
mouse clicks: draws a room, finalizes it and checks the tile estimate, drags a corner, adds a line, saves and reloads a design,
switches units, and runs the whole Import from Sketch dialog against a fake service (success, every error message, offline,
cancel, replacing an existing drawing). It fails if the page throws any error or a flow breaks. No real Gemini calls are made.

```
npm i playwright-core
node tests/smoke.mjs index.html        # set CHROMIUM=/path/to/chromium if it is not at /opt/pw-browsers/chromium
```

It takes about a minute. Run it before every release. `sketch.png` is just a placeholder photo for the upload step.

What it does NOT cover: the real Gemini reading (that lives in the website's Worker), and anything Android-specific
(the camera, permissions, the app WebView). Test those on a phone.

# Tile-count baseline

`baseline.mjs` loads seven layouts (rectangle, L-shape, island, angled corner, rotated grid with a running-bond offset, 45° grid
with offsets, and a mix) and compares the Tile Estimate for each against `baseline.json`. Run it after any change to how tiles
are laid out or counted; a difference means the counts changed.

```
node tests/baseline.mjs index.html            # compare
node tests/baseline.mjs --write index.html    # re-record, only when a change in the counts is intended
```
