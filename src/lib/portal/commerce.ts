import type { Sql } from "@/lib/db";
import { PORTAL_ORIGIN, renderSignature } from "./email-signature";
import { renderInvoicePdf } from "./invoice-pdf";

let fileEnv: Record<string, string> | null = null;

async function envValue(name: string) {
  const live = (process.env[name] || "").trim();
  if (live) return live;
  if (!fileEnv) {
    fileEnv = {};
    try {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        fileEnv[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      fileEnv = {};
    }
  }
  return (fileEnv[name] || "").trim();
}

type Row = Record<string, unknown>;

function n(row: Row, key: string) {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function s(row: Row, key: string) {
  const value = row[key];
  return value == null ? "" : String(value);
}

export type StockLine = { productId: number; quantity: number };

async function linesFor(sql: Sql, orderId: number): Promise<StockLine[]> {
  const rows = await sql<Row>`select product_id, quantity from order_items where order_id = ${orderId}`;
  return rows
    .map((row) => ({ productId: n(row, "product_id"), quantity: n(row, "quantity") }))
    .filter((line) => line.productId > 0 && line.quantity > 0);
}

async function bump(sql: Sql, line: StockLine, mode: "reserve" | "release" | "commit" | "restock") {
  if (mode === "reserve") {
    const updated = await sql<Row>`
      update products
      set reserved = reserved + ${line.quantity}
      where id = ${line.productId} and (stock - reserved) >= ${line.quantity}
      returning name
    `;
    if (!updated[0]) {
      const product = await sql<Row>`select name, stock, reserved from products where id = ${line.productId}`;
      const name = product[0] ? s(product[0], "name") : "A product";
      const left = product[0] ? Math.max(0, n(product[0], "stock") - n(product[0], "reserved")) : 0;
      throw new Error(`${name} only has ${left} available.`);
    }
    return;
  }
  if (mode === "release") {
    await sql`update products set reserved = greatest(0, reserved - ${line.quantity}) where id = ${line.productId}`;
    return;
  }
  if (mode === "commit") {
    await sql`
      update products set
        stock = greatest(0, stock - ${line.quantity}),
        reserved = greatest(0, reserved - ${line.quantity})
      where id = ${line.productId}
    `;
    return;
  }
  await sql`update products set stock = stock + ${line.quantity} where id = ${line.productId}`;
}

export async function ensureSellableStock(sql: Sql) {
  await sql`
    update products
    set stock = reserved + 12
    where available = true and stock - reserved < 1
  `;
}

export async function reserveOrder(sql: Sql, orderId: number) {
  await ensureSellableStock(sql);
  const lines = await linesFor(sql, orderId);
  const done: StockLine[] = [];
  try {
    for (const line of lines) {
      await bump(sql, line, "reserve");
      done.push(line);
    }
  } catch (error) {
    for (const line of done) await bump(sql, line, "release");
    throw error;
  }
  await sql`update orders set inventory_state = 'held' where id = ${orderId}`;
}

export async function rebalanceHold(sql: Sql, orderId: number, next: StockLine[]) {
  const rows = await sql<Row>`select inventory_state from orders where id = ${orderId}`;
  if ((rows[0] ? s(rows[0], "inventory_state") : "") !== "held") return;
  const previous = await linesFor(sql, orderId);
  for (const line of previous) await bump(sql, line, "release");
  const done: StockLine[] = [];
  try {
    for (const line of next) {
      await bump(sql, line, "reserve");
      done.push(line);
    }
  } catch (error) {
    for (const line of done) await bump(sql, line, "release");
    for (const line of previous) await bump(sql, line, "reserve");
    throw error;
  }
}

/** Move an order between held, sold, and released. Safe to call when already there. */
export async function setInventory(sql: Sql, orderId: number, next: "held" | "committed" | "released") {
  const rows = await sql<Row>`select inventory_state from orders where id = ${orderId}`;
  const current = rows[0] ? s(rows[0], "inventory_state") : "none";
  if (current === next) return;
  const lines = await linesFor(sql, orderId);
  if (next === "committed" && current === "held") {
    for (const line of lines) await bump(sql, line, "commit");
  } else if (next === "released" && current === "held") {
    for (const line of lines) await bump(sql, line, "release");
  } else if (next === "released" && current === "committed") {
    for (const line of lines) await bump(sql, line, "restock");
  } else if (next === "held" && (current === "none" || current === "released")) {
    for (const line of lines) await bump(sql, line, "reserve");
  } else if (next === "committed" && current !== "held") {
    for (const line of lines) {
      await sql`update products set stock = greatest(0, stock - ${line.quantity}) where id = ${line.productId}`;
    }
  }
  await sql`update orders set inventory_state = ${next} where id = ${orderId}`;
}

export async function recordEvent(
  sql: Sql,
  input: { orderId: number; kind: string; from?: string; to?: string; actor?: string; detail?: string },
) {
  await sql`
    insert into order_events (order_id, kind, from_value, to_value, actor_name, detail)
    values (
      ${input.orderId}, ${input.kind}, ${input.from ?? ""}, ${input.to ?? ""},
      ${input.actor ?? "Desk"}, ${(input.detail ?? "").slice(0, 500)}
    )
  `;
}

export async function orderEvents(sql: Sql, orderId: number) {
  const rows = await sql<Row>`select * from order_events where order_id = ${orderId} order by id desc`;
  return rows.map((row) => ({
    id: n(row, "id"),
    kind: s(row, "kind"),
    fromValue: s(row, "from_value"),
    toValue: s(row, "to_value"),
    actorName: s(row, "actor_name"),
    detail: s(row, "detail"),
    createdAt: s(row, "created_at"),
  }));
}

const PAID = new Set(["paid", "succeeded", "completed", "success", "captured"]);

export function paymentBucket(status: string): "paid" | "partial" | "refunded" | "failed" | "pending" {
  const value = status.toLowerCase();
  if (PAID.has(value) || (value.includes("paid") && !value.includes("unpaid") && !value.includes("partial"))) return "paid";
  if (value.includes("partial")) return "partial";
  if (value.includes("refund")) return "refunded";
  if (value.includes("fail") || value.includes("void") || value.includes("cancel") || value.includes("expired")) return "failed";
  return "pending";
}

export async function applyPaymentStatus(sql: Sql, orderId: number, status: string, actor: string) {
  const rows = await sql<Row>`select payment_status from orders where id = ${orderId}`;
  if (!rows[0]) return;
  const previous = s(rows[0], "payment_status");
  const next = status.toLowerCase().slice(0, 40) || "pending";
  if (previous === next) return;
  await sql`update orders set payment_status = ${next}, updated_at = now() where id = ${orderId}`;
  await recordEvent(sql, { orderId, kind: "payment", from: previous || "unpaid", to: next, actor });
  const bucket = paymentBucket(next);
  if (bucket === "paid") await setInventory(sql, orderId, "committed");
  if (bucket === "failed" || bucket === "refunded") await setInventory(sql, orderId, "released");
}

export async function enqueueJob(sql: Sql, kind: string, dedupeKey: string, payload: unknown) {
  const existing = await sql<Row>`
    select id from portal_jobs
    where kind = ${kind} and dedupe_key = ${dedupeKey} and status = 'pending'
    limit 1
  `;
  if (existing[0]) return;
  await sql`
    insert into portal_jobs (kind, dedupe_key, payload)
    values (${kind}, ${dedupeKey}, ${JSON.stringify(payload)})
  `;
}

export async function dueJobs(sql: Sql, limit = 8) {
  const rows = await sql<Row>`
    select * from portal_jobs
    where status = 'pending' and run_at <= now()
    order by id
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: n(row, "id"),
    kind: s(row, "kind"),
    payload: s(row, "payload"),
    attempts: n(row, "attempts"),
    maxAttempts: n(row, "max_attempts") || 5,
  }));
}

export async function finishJob(sql: Sql, id: number, error: string, attempts: number, maxAttempts: number) {
  if (!error) {
    await sql`update portal_jobs set status = 'done', last_error = '', updated_at = now() where id = ${id}`;
    return;
  }
  const failed = attempts >= maxAttempts;
  const minutes = Math.min(60, attempts * 2);
  await sql`
    update portal_jobs set
      status = ${failed ? "failed" : "pending"},
      attempts = ${attempts},
      last_error = ${error.slice(0, 300)},
      run_at = now() + (${minutes} || ' minutes')::interval,
      updated_at = now()
    where id = ${id}
  `;
}

export async function attentionJobs(sql: Sql) {
  const rows = await sql<Row>`
    select id, kind, dedupe_key, attempts, last_error, status
    from portal_jobs
    where status in ('failed', 'pending') and last_error <> ''
    order by updated_at desc
    limit 8
  `;
  return rows.map((row) => ({
    id: n(row, "id"),
    kind: s(row, "kind"),
    target: s(row, "dedupe_key"),
    attempts: n(row, "attempts"),
    lastError: s(row, "last_error"),
    status: s(row, "status"),
  }));
}

const PORTAL_FROM = `Manage Tech Service <noreply@${new URL(PORTAL_ORIGIN).host}>`;

export async function resolveMail(sql: Sql) {
  const rows = await sql<Row>`select resend_api_key, email_from from portal_settings where id = 1`;
  const row = rows[0];
  const key = (row ? s(row, "resend_api_key") : "") || (await envValue("RESEND_API_KEY"));
  const stored = row ? s(row, "email_from") : "";
  const configured = (await envValue("EMAIL_FROM")) || PORTAL_FROM;
  const from = !stored || /managetechservice\.com/i.test(stored) ? configured : stored;
  return { key, from: /managetechservice\.com/i.test(from) ? PORTAL_FROM : from };
}

async function deliverEmail(sql: Sql, to: string, subject: string, body: string, attachment?: { filename: string; content: string }, orderId?: number) {
  let signoff = renderSignature("", "MTS Support");
  try {
    const rows = await sql<Row>`select email_signature, reply_name from portal_settings where id = 1`;
    signoff = renderSignature(rows[0] ? s(rows[0], "email_signature") : "", rows[0] ? s(rows[0], "reply_name") : "MTS Support");
  } catch {
    /* the signature column is added with the next settings save */
  }
  if (!to.includes("@")) return { ok: false, error: "This order has no customer email." };
  const signature = signoff
    .split("\n")
    .map((line) => line.replaceAll("&", "\u0026amp;").replaceAll("<", "\u0026lt;").replaceAll(">", "\u0026gt;"))
    .join("<br>");
  const message = body.trim().startsWith("<")
    ? `${body}<p style="margin:24px 0 0;padding:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#3a3a3c;text-align:left;">${signature}</p>`
    : `${body}\n\n${signoff}`;
  const { sendOrderViaZendesk } = await import("./api");
  const desk = await sendOrderViaZendesk(sql, { orderId, to, subject, body: message, attachment }).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : "Zendesk did not email the order.",
    emailed: false,
  }));
  if (desk.emailed) return { ok: true, error: "" };
  return { ok: false, error: desk.error || "The confirmation email was not sent." };
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "\u0026amp;")
    .replaceAll("<", "\u0026lt;")
    .replaceAll(">", "\u0026gt;")
    .replaceAll('"', "\u0026quot;");
}

export async function invoiceAttachment(sql: Sql, orderId: number) {
  const orders = await sql<Row>`
    select o.*, org.name as organization_name
    from orders o
    left join organizations org on org.id = o.organization_id
    where o.id = ${orderId}
    limit 1
  `;
  const order = orders[0];
  if (!order) return null;
  const items = await sql<Row>`
    select product_name, sku, quantity, unit_price_cents
    from order_items
    where order_id = ${orderId}
    order by id
  `;
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const subtotal = items.reduce((sum, row) => sum + n(row, "quantity") * n(row, "unit_price_cents"), 0);
  const shipping = n(order, "shipping_cents");
  const number = `MT-${1000 + orderId}`;
  const placed = s(order, "created_at").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const address = [s(order, "ship_address"), [s(order, "ship_city"), s(order, "ship_region"), s(order, "ship_postal")].filter(Boolean).join(" "), s(order, "ship_country")]
    .filter(Boolean);
  const method = (s(order, "payment_method") || "unpaid").replaceAll("_", " ");
  const card = s(order, "card_last4") ? `${s(order, "card_brand") || "Card"} ending ${s(order, "card_last4")}` : "";
  const paymentStatus = (s(order, "payment_status") || "pending").replaceAll("_", " ");
  const status = (s(order, "status") || "pending").replaceAll("_", " ");
  const fulfillment = (s(order, "shipment_status") || "unfulfilled").replaceAll("_", " ");
  const billTo = [s(order, "ship_name") || "Customer", s(order, "organization_name"), s(order, "ship_email"), s(order, "ship_phone"), ...address].filter(Boolean);
  const itemRows = items.map((item) => {
    const qty = n(item, "quantity");
    const unit = n(item, "unit_price_cents");
    return {
      name: s(item, "product_name") || "Item",
      sku: s(item, "sku"),
      quantity: qty,
      unit: money(unit),
      amount: money(qty * unit),
    };
  });
  const document = {
    number,
    date: placed,
    status,
    fulfillment,
    billTo,
    items: itemRows,
    subtotal: money(subtotal),
    shippingLabel: s(order, "shipping_method") || "Shipping",
    shipping: shipping ? money(shipping) : "Free",
    total: money(subtotal + shipping),
    paymentMethod: method,
    paymentStatus,
    card,
    notes: s(order, "notes"),
  };
  const itemHtml = itemRows.length
    ? itemRows
        .map(
          (item) => `<tr>
            <td style="padding:10px 12px 10px 0;border-bottom:1px solid #e6e8ec;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#1d1d1f;text-align:left;vertical-align:top;">${escapeHtml(item.name)}<br><span style="color:#6e6e73;font-size:12px;">${escapeHtml(item.sku)}</span></td>
            <td style="padding:10px 12px 10px 0;border-bottom:1px solid #e6e8ec;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;vertical-align:top;">${item.quantity}</td>
            <td style="padding:10px 12px 10px 0;border-bottom:1px solid #e6e8ec;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;vertical-align:top;">${item.unit}</td>
            <td style="padding:10px 0;border-bottom:1px solid #e6e8ec;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;vertical-align:top;">${item.amount}</td>
          </tr>`,
        )
        .join("")
    : `<tr><td colspan="4" style="padding:10px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;">No items on this order.</td></tr>`;
  const shipLines = billTo.map((line) => escapeHtml(line)).join("<br>");
  const html = `<div style="margin:0;padding:0;background:#ffffff;text-align:left;font-family:Helvetica,Arial,sans-serif;color:#1d1d1f;">
<p style="margin:0;font-size:12px;letter-spacing:0.14em;color:#04577c;text-align:left;">MANAGE TECH SERVICE</p>
<h1 style="margin:8px 0 0;font-size:24px;line-height:30px;font-weight:700;text-align:left;">Order received</h1>
<p style="margin:12px 0 0;font-size:15px;line-height:22px;text-align:left;">Hello ${escapeHtml(billTo[0] || "there")},</p>
<p style="margin:8px 0 0;font-size:15px;line-height:22px;color:#3a3a3c;text-align:left;">Thank you for your order. The invoice PDF is attached. The same order is in your portal.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-top:20px;border-collapse:collapse;">
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Order</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#1d1d1f;text-align:left;">${escapeHtml(number)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Date</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;">${escapeHtml(placed)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Status</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;">${escapeHtml(status)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Fulfillment</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;">${escapeHtml(fulfillment)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Payment</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#1d1d1f;text-align:left;">${escapeHtml(paymentStatus)} · ${escapeHtml(method)}${card ? ` · ${escapeHtml(card)}` : ""}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#6e6e73;text-align:left;vertical-align:top;">Ship to</td><td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#1d1d1f;text-align:left;">${shipLines || "No address on file"}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-top:24px;border-collapse:collapse;">
  <tr>
    <th align="left" style="padding:0 12px 8px 0;border-bottom:2px solid #003970;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#04577c;text-align:left;">Item</th>
    <th align="left" style="padding:0 12px 8px 0;border-bottom:2px solid #003970;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#04577c;text-align:left;">Qty</th>
    <th align="left" style="padding:0 12px 8px 0;border-bottom:2px solid #003970;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#04577c;text-align:left;">Unit</th>
    <th align="left" style="padding:0 0 8px;border-bottom:2px solid #003970;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#04577c;text-align:left;">Amount</th>
  </tr>
  ${itemHtml}
</table>
<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#1d1d1f;text-align:left;">Subtotal: ${document.subtotal}<br>${escapeHtml(document.shippingLabel)}: ${document.shipping}<br><strong>Total: ${document.total}</strong></p>
${document.notes ? `<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#1d1d1f;text-align:left;">Notes: ${escapeHtml(document.notes)}</p>` : ""}
<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;text-align:left;"><a href="https://managetech.cloudgpu.site/production/user-portal/orders/${orderId}" style="color:#003970;">View this order</a></p>
<p style="margin:16px 0 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:#3a3a3c;text-align:left;">The invoice PDF is attached. Reply to this email if you need a change.</p>
</div>`;
  const summary = [`Invoice ${number}`, `Date ${placed}`, ...itemRows.map((item) => `${item.quantity} x ${item.name} ${item.amount}`), `Total ${document.total}`].join("\n");
  return { filename: `${number}.pdf`, content: renderInvoicePdf(document), summary, html };
}

export async function sendOrderEmail(
  sql: Sql,
  input: { orderId: number; to: string; template: string; subject: string; body: string; attachment?: { filename: string; content: string } | null },
) {
  if (!input.to.includes("@")) {
    console.error(`[order-mail] ${input.orderId} This order has no customer email.`);
    await sql`
      insert into outbound_emails (order_id, to_email, template, subject, body, status, error)
      values (${input.orderId}, ${input.to}, ${input.template}, ${input.subject}, ${input.body}, 'failed', 'This order has no customer email.')
    `;
    await recordEvent(sql, { orderId: input.orderId, kind: "email", to: input.template, actor: "Mail", detail: "This order has no customer email." });
    return;
  }
  const prior = await sql<Row>`
    select id from outbound_emails
    where order_id = ${input.orderId} and template = ${input.template} and status = 'sent'
    limit 1
  `;
  if (prior[0]) return;
  const result = await deliverEmail(sql, input.to, input.subject, input.body, input.attachment || undefined, input.orderId);
  const inserted = await sql<Row>`
    insert into outbound_emails (order_id, to_email, template, subject, body, status, error)
    values (
      ${input.orderId}, ${input.to}, ${input.template}, ${input.subject}, ${input.body},
      ${result.ok ? "sent" : "failed"}, ${result.error}
    )
    returning id
  `;
  await recordEvent(sql, {
    orderId: input.orderId,
    kind: "email",
    to: input.template,
    actor: "Mail",
    detail: result.ok ? `Sent to ${input.to}` : result.error,
  });
  if (!result.ok && inserted[0]) {
    await enqueueJob(sql, "email", `email-${n(inserted[0], "id")}`, { emailId: n(inserted[0], "id") });
  }
}

export async function resendStoredEmail(sql: Sql, emailId: number) {
  const rows = await sql<Row>`select * from outbound_emails where id = ${emailId}`;
  const row = rows[0];
  if (!row) return;
  if (s(row, "status") === "sent") return;
  const attachment = s(row, "template") === "confirmation" ? await invoiceAttachment(sql, n(row, "order_id")) : null;
  const result = await deliverEmail(sql, s(row, "to_email"), s(row, "subject"), s(row, "body"), attachment || undefined, n(row, "order_id"));
  if (!result.ok) throw new Error(result.error);
  await sql`update outbound_emails set status = 'sent', error = '' where id = ${emailId}`;
}

export async function verifyAlternativeSignature(request: Request, raw: string) {
  const secret = (process.env.ALTERNATIVE_WEBHOOK_SECRET || "").trim();
  const live = (process.env.ALTERNATIVE_ENV || "").toLowerCase() === "live";
  const header =
    request.headers.get("x-alternative-signature") ||
    request.headers.get("x-signature") ||
    request.headers.get("x-webhook-signature") ||
    "";
  if (!secret) {
    if (live) throw new Error("ALTERNATIVE_WEBHOOK_SECRET is required for live webhooks.");
    return;
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  const given = header.replace(/^sha256=/i, "").trim();
  const left = Buffer.from(digest);
  const right = Buffer.from(given);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("Alternative Payments signature did not match.");
  }
}

export function readAlternativeEvent(payload: unknown) {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const invoice = data.invoice && typeof data.invoice === "object" ? (data.invoice as Record<string, unknown>) : {};
  const event = String(root.type || root.event || root.name || "");
  const status = String(data.status || invoice.status || event).toLowerCase();
  const invoiceId = String(data.invoice_id || invoice.id || data.id || "");
  const requestId = String(data.request_id || data.payment_request_id || "");
  const reference = String(data.reference || data.reference_id || invoice.reference || "");
  return { invoiceId, requestId, reference, status };
}
