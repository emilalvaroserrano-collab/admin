function ascii(value: string) {
  return value.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
}

function escapePdf(value: string) {
  return ascii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function clip(value: string, max: number) {
  const clean = ascii(value);
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 3))}...` : clean;
}

export type InvoiceDocument = {
  number: string;
  date: string;
  status: string;
  fulfillment: string;
  billTo: string[];
  items: { name: string; sku: string; quantity: number; unit: string; amount: string }[];
  subtotal: string;
  shippingLabel: string;
  shipping: string;
  total: string;
  paymentMethod: string;
  paymentStatus: string;
  card: string;
  notes: string;
};

export function renderInvoicePdf(invoice: InvoiceDocument) {
  const commands: string[] = [];
  const text = (font: "F1" | "F2", size: number, x: number, y: number, value: string, color = "0 0 0") => {
    commands.push(`${color} rg`);
    commands.push(`BT /${font} ${size} Tf ${x} ${y} Td (${escapePdf(value)}) Tj ET`);
  };
  const fill = (r: number, g: number, b: number, x: number, y: number, w: number, h: number) => {
    commands.push(`${r} ${g} ${b} rg`);
    commands.push(`${x} ${y} ${w} ${h} re f`);
  };
  const line = (x1: number, y: number, x2: number) => {
    commands.push("0.86 0.89 0.92 RG 0.6 w");
    commands.push(`${x1} ${y} m ${x2} ${y} l S`);
  };

  fill(0, 0.224, 0.439, 0, 724, 612, 68);
  text("F2", 16, 48, 758, "MANAGE TECH SERVICE", "1 1 1");
  text("F1", 9, 48, 740, "Technology that keeps the office running", "0.78 0.9 0.93");
  text("F2", 18, 430, 758, "INVOICE", "1 1 1");
  text("F1", 10, 430, 740, invoice.number, "1 1 1");

  text("F1", 8, 48, 696, "INVOICE DATE", "0.43 0.48 0.54");
  text("F2", 11, 48, 680, invoice.date);
  text("F1", 8, 180, 696, "ORDER STATUS", "0.43 0.48 0.54");
  text("F2", 11, 180, 680, invoice.status);
  text("F1", 8, 330, 696, "FULFILLMENT", "0.43 0.48 0.54");
  text("F2", 11, 330, 680, invoice.fulfillment);

  fill(0.96, 0.97, 0.98, 48, 560, 240, 100);
  text("F1", 8, 60, 642, "BILL AND SHIP TO", "0.07 0.49 0.53");
  invoice.billTo.slice(0, 6).forEach((row, index) => text(index === 0 ? "F2" : "F1", 10, 60, 624 - index * 14, clip(row, 36)));

  fill(0.96, 0.97, 0.98, 320, 560, 244, 100);
  text("F1", 8, 332, 642, "PAYMENT", "0.07 0.49 0.53");
  text("F2", 11, 332, 622, clip(invoice.paymentStatus, 28));
  text("F1", 10, 332, 604, clip(invoice.paymentMethod, 32));
  if (invoice.card) text("F1", 10, 332, 588, clip(invoice.card, 32));

  const tableTop = 528;
  fill(0, 0.224, 0.439, 48, tableTop, 516, 22);
  text("F2", 8, 56, tableTop + 7, "ITEM", "1 1 1");
  text("F2", 8, 280, tableTop + 7, "SKU", "1 1 1");
  text("F2", 8, 380, tableTop + 7, "QTY", "1 1 1");
  text("F2", 8, 430, tableTop + 7, "PRICE", "1 1 1");
  text("F2", 8, 500, tableTop + 7, "AMOUNT", "1 1 1");

  const rows = invoice.items.length ? invoice.items : [{ name: "No items", sku: "", quantity: 0, unit: "", amount: "" }];
  rows.slice(0, 12).forEach((item, index) => {
    const y = tableTop - 24 - index * 22;
    if (index % 2 === 0) fill(0.97, 0.98, 0.99, 48, y - 6, 516, 22);
    text("F1", 10, 56, y, clip(item.name, 32));
    text("F1", 9, 280, y, clip(item.sku, 14), "0.35 0.39 0.45");
    text("F1", 10, 388, y, item.quantity ? String(item.quantity) : "");
    text("F1", 10, 424, y, item.unit);
    text("F2", 10, 492, y, item.amount);
  });

  const totalsY = tableTop - 24 - Math.min(rows.length, 12) * 22 - 28;
  line(340, totalsY + 46, 564);
  text("F1", 10, 360, totalsY + 28, "Subtotal", "0.35 0.39 0.45");
  text("F1", 10, 490, totalsY + 28, invoice.subtotal);
  text("F1", 10, 360, totalsY + 12, clip(invoice.shippingLabel, 18), "0.35 0.39 0.45");
  text("F1", 10, 490, totalsY + 12, invoice.shipping);
  fill(0, 0.224, 0.439, 340, totalsY - 22, 224, 26);
  text("F2", 11, 352, totalsY - 13, "Total", "1 1 1");
  text("F2", 11, 478, totalsY - 13, invoice.total, "1 1 1");

  if (invoice.notes) text("F1", 9, 48, 96, clip(`Notes: ${invoice.notes}`, 90), "0.35 0.39 0.45");
  line(48, 72, 564);
  text("F1", 9, 48, 54, "Thank you for your order.", "0.07 0.49 0.53");
  text("F1", 8, 48, 40, "Manage Tech Service  ·  mtsportal.cloudgpu.site  ·  The invoice PDF is the record of this order.", "0.43 0.48 0.54");

  const content = commands.join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    "6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xref = Buffer.byteLength(body);
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) trailer += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body + trailer).toString("base64");
}
