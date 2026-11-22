const css = `
:root {
  color-scheme: light dark;
  font: 15px/1.5 system-ui, sans-serif;
  --line: color-mix(in srgb, CanvasText 22%, Canvas);
  --panel: color-mix(in srgb, CanvasText 5%, Canvas);
  --error: light-dark(#b21d36, #ff788a);
}
:root[data-theme=light] { color-scheme: light; }
:root[data-theme=dark] { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; padding: clamp(16px, 4vw, 48px); max-width: 1600px; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
h1 { margin: 0; font-size: 1.8rem; letter-spacing: -.03em; }
#connection { margin: 4px 0; }
#totals { font-variant-numeric: tabular-nums; margin: 20px 0; }
button { color: inherit; font: inherit; cursor: pointer; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 8px 12px; }
button:focus-visible { outline: 3px solid Highlight; outline-offset: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 270px), 1fr)); gap: 18px; }
.card { display: grid; gap: 5px; align-content: start; text-align: left; padding: 12px; overflow-wrap: anywhere; }
.card.failed { border-color: var(--error); box-shadow: 0 0 0 2px var(--error); }
.failed { color: var(--error); }
.frame { display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; min-height: 110px; color: CanvasText; }
.card .frame { aspect-ratio: 16 / 10; overflow: hidden; margin-bottom: 4px; }
img { display: block; max-width: 100%; max-height: 65vh; object-fit: contain; }
.card img { width: 100%; height: 100%; }
.sequences { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 8px; }
.sequences li, pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; }
`;

export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HighAlch Studio</title>
<style>${css}</style>
<script type="module" src="/studio.mjs"></script>
</head>
<body>
<header><div><h1>HighAlch Studio</h1><p id="connection" role="status">Connecting…</p></div>
<button id="theme" type="button">Theme: System</button></header>
<p id="totals"></p>
<main></main>
</body>
</html>`;

export { css };
