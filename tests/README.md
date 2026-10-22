# Smoke test

`smoke.mjs` opens `index.html` in a real Chromium browser (desktop and phone sizes) and does what a person would, with real
mouse clicks: draws a room, finalizes it and checks the tile estimate, drags a corner, adds a line, saves and reloads a design,
switches units, opens the File section and the Tile List, and runs the whole Import from Sketch dialog against a fake service (success, every error message, offline,
cancel, replacing an existing drawing). It fails if the page throws any error or a flow breaks. No real Gemini calls are made.

```
npm i playwright-core
node tests/smoke.mjs index.html        # set CHROMIUM=/path/to/chromium if it is not at /opt/pw-browsers/chromium
```

It takes about a minute. Run it before every release. `sketch.png` is just a placeholder photo for the upload step.

What it does NOT cover: the real Gemini reading (that lives in the website's Worker), and anything Android-specific
(the camera, permissions, the app WebView). Test those on a phone.

# Tile-count baseline

`baseline.mjs` loads a set of layouts (rectangles, an L-shape, an island, an angled corner, running-bond and stepped offsets, herringbone
straight, tall and at 45°, and mixes) and compares the Tile Estimate for each against `baseline.json`. Run it after any change to how tiles
are laid out or counted; a difference means the counts changed.

```
node tests/baseline.mjs index.html            # compare
node tests/baseline.mjs --write index.html    # re-record, only when a change in the counts is intended
```

# Keeping old designs working

A design saved by any released version must open in every later version. `fixtures/` holds a file saved by each release
(`design-from-1.28.json` so far) and the smoke test loads it and checks that everything came back. When a release changes what
a design contains, save a design from that release into `fixtures/` before changing the format again, and add a check for it.
The loader ignores fields it does not know and treats a missing field as its old default, so new settings are added as
optional fields rather than by changing the meaning of existing ones. Opening a new file in an older app is not supported:
it loads, but anything the old app does not know about is dropped.
