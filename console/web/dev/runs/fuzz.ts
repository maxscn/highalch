import { Console, Fuzz, type Capture } from "@highalch/console-fuzz";

/** The customer card the seeded CRM renders, as a JSON Schema the fuzzer explores. */
export const customerSchema: Fuzz.JsonSchema<Customer> = {
  title: "Customer",
  type: "object",
  required: ["id", "name", "email", "plan", "spend", "tags"],
  properties: {
    id: { type: "integer", minimum: 1 },
    name: { type: "string", maxLength: 80 },
    email: { type: "string", format: "email" },
    plan: { enum: ["Starter", "Team", "Enterprise"] },
    spend: { type: "number" },
    tags: { type: "array", items: { type: "string", maxLength: 24 }, maxItems: 12 },
    company: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, country: { type: "string", maxLength: 2 } },
    },
  },
};

export interface Customer {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly plan: "Starter" | "Team" | "Enterprise";
  readonly spend: number;
  readonly tags: ReadonlyArray<string>;
  readonly company?: { readonly name: string; readonly country?: string };
}

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

/** `fixed` is the head commit: it wraps long names and formats negative spend. */
const card = (customer: Customer, fixed: boolean) => {
  if (!fixed && customer.spend < 0) throw new RangeError("Invalid currency amount: negative spend");
  const amount = customer.spend.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
body{margin:0;font:14px/20px system-ui,sans-serif;background:#f6f7f9;color:#1f2328}
.card{margin:16px;width:280px;padding:16px;background:#fff;border:1px solid #e3e5e8;border-radius:8px}
h2{margin:0 0 4px;font-size:16px;${fixed ? "overflow-wrap:anywhere" : "white-space:nowrap"}}
.email{color:#57606a}.tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.tag{padding:0 6px;border-radius:9px;background:#eef2ff;color:#3730a3;font-size:12px}
.spend{margin-top:8px;font-variant-numeric:tabular-nums}
</style></head><body><article class="card"><h2>${escape(customer.name)}</h2>
<div class="email">${escape(customer.email)}</div>
<div class="plan">${customer.plan}${customer.company ? ` · ${escape(customer.company.name)}` : ""}</div>
<div class="spend">${amount}</div>
<div class="tags">${customer.tags.map((tag) => `<span class="tag">${escape(tag)}</span>`).join("")}</div>
</article></body></html>`;
};

const outcomeOf = (customer: Customer, fixed: boolean) => {
  if (!fixed && customer.name.length > 34)
    return { outcome: "overflow" as const, message: "The name overflows the card (280px)." };
  if (customer.name.trim() === "")
    return { outcome: "a11y" as const, message: "The card heading has no accessible name." };
  return { outcome: "ok" as const };
};

const html = (body: string): Capture => ({ kind: "html", body, mime: "text/html", meta: {} });

/** A shopping-cart reducer for the action-trace demo, with a bug in the base commit. */
type Cart = { readonly items: ReadonlyArray<{ sku: string; qty: number }>; readonly total: number };
type CartAction =
  | { readonly type: "add"; readonly sku: string; readonly qty: number }
  | { readonly type: "remove"; readonly sku: string }
  | { readonly type: "coupon"; readonly percent: number };

const price: Record<string, number> = { seat: 20, storage: 5, support: 99 };

const cartStep =
  (fixed: boolean) =>
  (cart: Cart, action: CartAction): Cart => {
    if (action.type === "add") {
      const existing = cart.items.find((item) => item.sku === action.sku);
      const items = existing
        ? cart.items.map((item) =>
            item.sku === action.sku ? { ...item, qty: item.qty + action.qty } : item,
          )
        : [...cart.items, { sku: action.sku, qty: action.qty }];
      return { items, total: cart.total + (price[action.sku] ?? 0) * action.qty };
    }
    if (action.type === "remove") {
      const removed = cart.items.find((item) => item.sku === action.sku);
      const items = cart.items.filter((item) => item.sku !== action.sku);
      // The base commit forgets the quantity when removing a line.
      const refund = removed ? (price[removed.sku] ?? 0) * (fixed ? removed.qty : 1) : 0;
      return { items, total: cart.total - refund };
    }
    return { ...cart, total: Math.round(cart.total * (1 - action.percent / 100)) };
  };

const cartActions: Fuzz.JsonSchema<CartAction> = {
  title: "CartAction",
  oneOf: [
    {
      type: "object",
      required: ["type", "sku", "qty"],
      properties: {
        type: { const: "add" },
        sku: { enum: ["seat", "storage", "support"] },
        qty: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "sku"],
      properties: { type: { const: "remove" }, sku: { enum: ["seat", "storage", "support"] } },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "percent"],
      properties: { type: { const: "coupon" }, percent: { enum: [0, 10] } },
      additionalProperties: false,
    },
  ],
} as Fuzz.JsonSchema<CartAction>;

const cartHtml = (cart: Cart) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:16px;font:14px/20px system-ui,sans-serif}li{display:flex;justify-content:space-between;width:220px}</style></head><body><h3>Cart</h3><ul>${cart.items
    .map((item) => `<li><span>${item.sku}</span><span>× ${item.qty}</span></li>`)
    .join("")}</ul><p>Total: $${cart.total}</p></body></html>`;

/** Which version of the app a fuzz run exercises (see `../manifest.ts`). */
export type Variant = "base" | "pr3" | "head";

interface Address {
  readonly street: string;
  readonly city: string;
  readonly postcode: string;
  readonly country?: string;
}

const addressFields = {
  street: { type: "string", maxLength: 60 },
  city: { type: "string", maxLength: 40 },
  postcode: { type: "string", maxLength: 10 },
} as const;

const address: Fuzz.JsonSchema<Address> = {
  title: "Address",
  type: "object",
  required: ["street", "city", "postcode"],
  properties: addressFields,
};

/** The head commit adds `country`, so the part's input schema changed. */
const addressV2: Fuzz.JsonSchema<Address> = {
  title: "Address",
  type: "object",
  required: ["street", "city", "postcode", "country"],
  properties: { ...addressFields, country: { type: "string", maxLength: 2 } },
};

interface Invoice {
  readonly number: string;
  readonly amount: number;
  readonly paid: boolean;
}

const invoice: Fuzz.JsonSchema<Invoice> = {
  title: "Invoice",
  type: "object",
  required: ["number", "amount", "paid"],
  properties: {
    number: { type: "string", maxLength: 12 },
    amount: { type: "number" },
    paid: { type: "boolean" },
  },
};

const badge = { title: "Badge", type: "string", maxLength: 16 } as Fuzz.JsonSchema<string>;

const page = (body: string, css = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{margin:16px;font:14px/20px system-ui,sans-serif;color:#1f2328;background:#f6f7f9}${css}</style></head><body>${body}</body></html>`;

const addressHtml = (value: Address) =>
  page(
    `<address>${escape(value.street)}<br>${escape(value.postcode)} ${escape(value.city)}${value.country ? `<br>${escape(value.country)}` : ""}</address>`,
    "address{font-style:normal;width:220px}",
  );

const invoiceHtml = (value: Invoice) =>
  page(
    `<div style="display:flex;gap:16px;width:320px"><b>${escape(value.number)}</b><span>$${value.amount.toFixed(2)}</span><span>${value.paid ? "Paid" : "Open"}</span></div>`,
  );

const detailHtml = (customer: Customer, restyled: boolean) =>
  page(
    `<header style="display:flex;justify-content:space-between;padding:12px 16px;background:${restyled ? "#26251e" : "#fff"};color:${restyled ? "#f7f7f4" : "#1f2328"}"><strong>Acme CRM</strong><span>Customers</span></header><main style="padding:16px"><h1 style="font-size:20px;margin:0 0 8px">${escape(customer.name)}</h1><p>${escape(customer.email)} · ${customer.plan}</p></main>`,
  );

type SubjectKind = "component" | "part" | "page";
type Outcome = "ok" | "overflow" | "crash" | "a11y";

/**
 * Writes one offline fuzz run under `dir` with the real reporter: a component whose capture
 * changes in head, a part whose input schema changes in head (`schema-changed`), a part the
 * PR removes, a component the PR adds, a page restyled in pr3, and a page action trace.
 */
export const generate = async (dir: string, variant: Variant) => {
  const report = Console.reporter({
    project: "crm",
    dir,
    commit: "0000000000000000000000000000000000000000",
    branch: "seed",
    source: "github-actions",
    strict: true,
    log: () => {},
  });
  const add = <T>(
    kind: SubjectKind,
    name: string,
    schema: Fuzz.JsonSchema<T>,
    seed: number,
    count: number,
    render: (value: T) => { body: string; state: unknown; outcome: Outcome; message?: string },
  ) => {
    for (const item of Fuzz.cases(schema, { subject: { kind, name }, seed, count, name })) {
      const result = render(item.value);
      report.add(item, html(result.body), {
        state: result.state,
        outcome: result.outcome,
        ...(result.message ? { message: result.message } : {}),
      });
    }
  };
  const fixed = variant === "head";
  add("component", "customer/CustomerCard", customerSchema, 4217, 18, (value) => {
    try {
      return { body: card(value, fixed), state: { customer: value }, ...outcomeOf(value, fixed) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        body: page(`<pre>${escape(message)}</pre>`),
        state: { customer: value },
        outcome: "crash",
        message,
      };
    }
  });
  add("part", "customer/AddressBlock", fixed ? addressV2 : address, 77, 8, (value) => ({
    body: addressHtml(value),
    state: { address: value },
    outcome: value.city.length > 30 ? "overflow" : "ok",
  }));
  if (variant === "base")
    add("part", "customer/LegacyBadge", badge, 5, 4, (value) => ({
      body: page(
        `<span style="padding:0 6px;border-radius:9px;background:#eee">${escape(value)}</span>`,
      ),
      state: { label: value },
      outcome: "ok",
    }));
  if (variant !== "base")
    add("component", "billing/InvoiceRow", invoice, 31, 6, (value) => ({
      body: invoiceHtml(value),
      state: { invoice: value },
      outcome: value.number.trim() === "" ? "a11y" : "ok",
    }));
  add("page", "customers/CustomerDetail", customerSchema, 99, 6, (value) => ({
    body: detailHtml(value, variant !== "base"),
    state: { route: "/customers/:id", customer: value },
    outcome: value.name.trim() === "" ? "a11y" : "ok",
  }));
  report.trace(
    await Fuzz.run<Cart, CartAction>({
      subject: { kind: "page", name: "checkout/Cart" },
      name: "checkout/Cart",
      seed: 90210,
      steps: 8,
      runs: 200,
      initial: { items: [], total: 0 },
      actions: cartActions,
      step: cartStep(fixed),
      invariant: (cart) => {
        const expected = cart.items.reduce(
          (sum, item) => sum + (price[item.sku] ?? 0) * item.qty,
          0,
        );
        if (cart.total > expected)
          throw new Error(`Total ${cart.total} exceeds the sum of the lines (${expected})`);
      },
      capture: (cart) => html(cartHtml(cart)),
    }),
  );
  return report.flush();
};
