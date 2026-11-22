import type { Page } from "@playwright/test";

/**
 * A tiny CRM served through `page.route`, so the generated traces carry real network
 * requests, stylesheets and DOM snapshots without a web server. `SEED_STEP` (0 = the base
 * commit on main, 1..5 = the commits of the seeded pull request) changes the app the way
 * those commits would have.
 */
export const step = Number(process.env.SEED_STEP ?? "0");

export const origin = "http://crm.test";

const customers = [
  { id: 1, name: "Ada Lovelace", email: "ada@analytical.io", plan: "Enterprise", spend: 48210 },
  { id: 2, name: "Ada Lovelace", email: "ada.l@analytical.io", plan: "Team", spend: 1290 },
  { id: 3, name: "Grace Hopper", email: "grace@cobol.dev", plan: "Enterprise", spend: 30550 },
  { id: 4, name: "Katherine Johnson", email: "kj@orbit.space", plan: "Team", spend: 8800 },
  { id: 5, name: "Margaret Hamilton", email: "mh@apollo.dev", plan: "Starter", spend: 420 },
  { id: 6, name: "Radia Perlman", email: "radia@spanning.net", plan: "Team", spend: 6120 },
];

const accent = step === 3 ? "#c2410c" : "#2b5bd7";

const css = `
:root { font: 14px/20px system-ui, sans-serif; color: #1f2328; background: #f6f7f9; }
body { margin: 0; }
header { display: flex; align-items: center; gap: 16px; height: 48px; padding: 0 24px; background: #fff; border-bottom: 1px solid #e3e5e8; }
header strong { font-size: 15px; }
nav a { color: #57606a; text-decoration: none; margin-right: 12px; }
main { padding: 24px; max-width: 880px; }
h1 { font-size: 20px; margin: 0 0 16px; }
input[type=search] { height: 32px; width: 280px; padding: 0 10px; border: 1px solid #d0d7de; border-radius: 6px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; background: #fff; border: 1px solid #e3e5e8; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eef0f2; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { display: inline-block; padding: 0 8px; border-radius: 10px; background: #eef2ff; color: #3730a3; font-size: 12px; }
button { height: 32px; padding: 0 14px; border-radius: 6px; border: 1px solid ${accent}; background: ${accent}; color: #fff; font: inherit; cursor: pointer; }
button.secondary { background: #fff; color: ${accent}; }
.panel { margin-top: 16px; padding: 16px; background: #fff; border: 1px solid #e3e5e8; border-radius: 8px; }
.warning { color: #9a3412; background: #fff7ed; padding: 8px 12px; border-radius: 6px; }
.row { display: flex; gap: 8px; align-items: center; }
label { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Acme CRM</title>
<link rel="stylesheet" href="/app.css"></head>
<body><header><strong>Acme CRM</strong><nav><a href="/customers">Customers</a><a href="/settings">Settings</a></nav></header>
<main>${body}</main><script src="/app.js"></script></body></html>`;

const customersPage = () =>
  layout(
    "Customers",
    `<h1>Customers</h1>
<div class="row"><input type="search" placeholder="Search customers" aria-label="Search customers">
<button class="secondary" id="find-duplicates">Find duplicates</button></div>
<table><thead><tr><th>Name</th><th>Email</th><th>Plan</th><th class="num">Spend</th></tr></thead><tbody>
${customers
  .map(
    (c) =>
      `<tr data-id="${c.id}"><td>${c.name}</td><td>${c.email}</td><td><span class="badge">${c.plan}</span></td><td class="num">$${c.spend.toLocaleString("en-US")}</td></tr>`,
  )
  .join("\n")}
</tbody></table>
<section class="panel" id="duplicates" hidden><h2>Possible duplicates</h2>
<p>Ada Lovelace appears twice: ada@analytical.io and ada.l@analytical.io.</p>
${step >= 2 ? `<p class="warning">Both records have open invoices. They will be combined.</p>` : ""}
<button id="merge">${step === 1 ? "Merge" : "Merge customers"}</button></section>
<p id="status" role="status"></p>`,
  );

const settingsPage = () =>
  layout(
    "Settings",
    `<h1>Settings</h1><div class="panel">
<label><input type="checkbox" id="weekly"> Weekly digest</label>
<label><input type="checkbox" id="alerts" checked> Spend alerts</label>
<button id="save">Save settings</button><p id="saved" role="status"></p></div>`,
  );

const js = `
const search = document.querySelector('input[type=search]');
if (search) search.addEventListener('input', () => {
  const q = search.value.toLowerCase();
  for (const row of document.querySelectorAll('tbody tr'))
    row.hidden = !row.textContent.toLowerCase().includes(q);
  console.log('filtered customers by', JSON.stringify(q));
});
const find = document.getElementById('find-duplicates');
if (find) find.addEventListener('click', async () => {
  const response = await fetch('/api/duplicates');
  const body = await response.json();
  document.getElementById('duplicates').hidden = body.groups.length === 0;
});
const merge = document.getElementById('merge');
if (merge) merge.addEventListener('click', async () => {
  const response = await fetch('/api/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep: 1, drop: 2 }) });
  if (!response.ok) console.error('merge failed', response.status);
  document.getElementById('status').textContent = response.ok ? 'Merged 2 customers' : 'Merge failed';
});
const save = document.getElementById('save');
if (save) save.addEventListener('click', () => {
  console.warn('settings are stored locally in this demo');
  document.getElementById('saved').textContent = 'Saved';
});
`;

/** Serves the CRM for `http://crm.test/*` on this page. */
export const serve = async (page: Page) => {
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const html = (body: string) => route.fulfill({ status: 200, contentType: "text/html", body });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    if (url.pathname === "/app.js")
      return route.fulfill({ contentType: "application/javascript", body: js });
    if (url.pathname === "/api/duplicates")
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ groups: [[1, 2]] }),
      });
    if (url.pathname === "/api/merge")
      return route.fulfill({
        status: step === 1 ? 409 : 200,
        contentType: "application/json",
        body: JSON.stringify(step === 1 ? { error: "conflict" } : { merged: 2, kept: 1 }),
      });
    if (url.pathname === "/settings") return html(settingsPage());
    return html(customersPage());
  });
};
