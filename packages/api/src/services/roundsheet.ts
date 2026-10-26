/**
 * The printed delivery sheet for a round (Everton, 25 Oct 2026): "even though
 * the app should be available offline, I would like the ability to download
 * the delivery sheet for the round. Showing customer name, address, phone
 * number, order, slot for empties collected and slot for if payment is
 * collected."
 *
 * One landscape page (or more) per round, stops in visit order, then any
 * collection stops, then the totals and sign-off lines. The amount to collect
 * is the same figure the driver's screen shows (owedAtStop): tax-inclusive,
 * with money already paid or credit held taken off. A paper copy - nothing on
 * it is read back; the driver still records each stop in the app, or the
 * office does from the sheet when they are back.
 */

import PDFDocument from 'pdfkit';
import type { Db } from '../db/index.ts';
import { num } from './core.ts';
import { RuleViolation } from '@alka/shared';
import { owedAtStop } from './delivery.ts';
import { listCollections } from './collections.ts';
import { truckPosition } from './trucks.ts';
import { qtyWords } from './documents.ts';

const BLUE = '#0E76BC';
const INK = '#1F2937';
const SOFT = '#4B5563';
const MUTED = '#6B7280';
const RULE = '#C9D3DD';
const HEAD_BG = '#EAF3FB';
const R = 'Helvetica';
const B = 'Helvetica-Bold';

// Landscape Letter: 792 x 612.
const L = 30;
const W = 732;
const BOTTOM = 572;

/** Columns, left to right. Widths add up to W. */
const COLS = [
  { key: 'n', label: '#', w: 20 },
  { key: 'who', label: 'Customer and phone', w: 128 },
  { key: 'where', label: 'Address', w: 150 },
  { key: 'what', label: 'Order', w: 138 },
  { key: 'owed', label: 'To collect', w: 64 },
  { key: 'empties', label: 'Empties collected', w: 62 },
  { key: 'paid', label: 'Payment collected', w: 170 },
] as const;

const cash = (cents: number) => {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  return `${neg ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-JM')}.${String(abs % 100).padStart(2, '0')}`;
};

const longDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
};

const shortName = (n: string) => n.replace(/^Alka Vida\s+/i, '');

interface SheetStop {
  n: number;
  name: string;
  phone: string;
  contact: string | null;
  address: string;
  instructions: string | null;
  orderRef: string | null;
  lines: string[];
  note: string | null;
  owedCents: number;
  onAccount: boolean;
  emptiesExpected: number | null;
  outcome: string;
  paymentOnly: boolean;
  takesReturnables: boolean;
}

async function sheetData(db: Db, sheetId: string) {
  const sheet = await db.maybeOne<{
    zone: string; delivery_date: string; driver: string | null; status: string;
  }>(
    `SELECT d.zone, d.delivery_date::text AS delivery_date, d.status,
            COALESCE(u.name, d.driver_name) AS driver
     FROM delivery_sheets d LEFT JOIN users u ON u.id = d.assigned_driver_id
     WHERE d.id = $1`, [sheetId],
  );
  if (!sheet) throw new RuleViolation('that round no longer exists');

  const rows = await db.query<{
    id: string; customer_name: string; phone: string | null; contact_person: string | null;
    address: string | null; instructions: string | null; order_id: string | null; order_ref: string | null;
    order_number: string | null; payment_only: boolean; summary: string | null; stop_outcome: string;
    empties_expected: number | null; pay_when: string | null; invoice_cycle: string | null;
    payment_terms: string | null;
  }>(
    `SELECT s.id, c.name AS customer_name,
            COALESCE(NULLIF(s.contact_phone, ''), NULLIF(ca.phone, ''), c.phone) AS phone,
            COALESCE(NULLIF(ca.contact_person, ''), c.contact_person) AS contact_person,
            COALESCE(NULLIF(s.delivery_address, ''), c.delivery_address) AS address,
            COALESCE(ca.delivery_instructions, c.delivery_instructions) AS instructions,
            s.order_id, s.order_ref, o.order_number, s.payment_only, s.line_items_summary AS summary,
            s.stop_outcome, o.empties_expected, o.pay_when, c.invoice_cycle, c.payment_terms
     FROM delivery_stops s
     JOIN customers c ON c.id = s.customer_id
     LEFT JOIN customer_orders o ON o.id = s.order_id
     LEFT JOIN customer_addresses ca ON ca.id = o.address_id
     WHERE s.delivery_sheet_id = $1 AND s.after_stop_id IS NULL
     ORDER BY s.sequence_no, c.name`, [sheetId],
  );

  const stops: SheetStop[] = [];
  let n = 0;
  for (const r of rows) {
    const lines = r.order_id ? await db.query<{
      name: string; bpc: number; cases: number; loose: number; returnable: boolean;
    }>(
      `SELECT p.name, p.bottles_per_case AS bpc, oli.cases, oli.loose_bottles AS loose, p.is_returnable AS returnable
       FROM order_line_items oli JOIN products p ON p.id = oli.product_id
       WHERE oli.order_id = $1 ORDER BY p.is_bottle_charge, p.name`, [r.order_id],
    ) : [];
    const owed = await owedAtStop(db, r.id);
    // Weekly/monthly customers and orders agreed "on account" pay later:
    // the sheet says so rather than showing a figure to collect.
    const onAccount = r.pay_when === 'On account' || r.invoice_cycle === 'Weekly' || r.invoice_cycle === 'Monthly';
    stops.push({
      n: ++n,
      name: r.customer_name,
      phone: r.phone ?? '',
      contact: r.contact_person,
      address: r.address ?? '',
      instructions: r.instructions,
      orderRef: r.order_number ?? r.order_ref,
      lines: lines.map((l) => `${qtyWords(num(l.bpc), num(l.cases), num(l.loose))}  ${shortName(l.name)}`),
      note: r.payment_only ? (r.summary ?? 'Collect a payment') : null,
      owedCents: owed.owedCents,
      onAccount,
      emptiesExpected: r.empties_expected === null ? null : num(r.empties_expected),
      outcome: r.stop_outcome,
      paymentOnly: r.payment_only,
      takesReturnables: lines.some((l) => l.returnable),
    });
  }

  const collections = await listCollections(db, sheetId) as Array<{
    kind: string; customer_name: string | null; supplier_name: string | null;
    delivery_address: string | null; supplier_address: string | null; po_number: string | null;
    empties_count: number; description: string | null; reason: string | null; status: string;
    lines: Array<{ name: string; bottlesPerCase?: number; cases?: number; looseBottles?: number; quantity?: number; unit?: string }>;
  }>;
  const truck = await truckPosition(db, sheetId);
  return { sheet, stops, collections, truck };
}

/** A small empty box to tick. */
function box(doc: PDFKit.PDFDocument, x: number, y: number): void {
  doc.save().lineWidth(0.8).strokeColor(SOFT).rect(x, y, 8, 8).stroke().restore();
}

/** A line to write on. */
function blank(doc: PDFKit.PDFDocument, x: number, y: number, w: number): void {
  doc.save().lineWidth(0.6).strokeColor(MUTED).moveTo(x, y).lineTo(x + w, y).stroke().restore();
}

export async function renderDeliverySheetPdf(db: Db, sheetId: string): Promise<{ filename: string; pdf: Buffer }> {
  const { sheet, stops, collections, truck } = await sheetData(db, sheetId);

  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 30, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const title = `Delivery sheet · ${sheet.zone}`;
  const sub = `${longDay(sheet.delivery_date)}   ·   Driver: ${sheet.driver ?? '________________'}   ·   ${stops.length} stop${stops.length === 1 ? '' : 's'}`
    + (collections.length ? ` + ${collections.length} collection${collections.length === 1 ? '' : 's'}` : '');

  const header = (first: boolean): number => {
    doc.font(B).fontSize(first ? 16 : 12).fillColor(BLUE).text(title, L, 28, { width: W - 160 });
    doc.font(R).fontSize(9).fillColor(SOFT).text(sub, L, doc.y + 2, { width: W - 160 });
    let y = doc.y + 6;
    doc.font(R).fontSize(8).fillColor(MUTED)
      .text('Alka Vida · 876-528-6112', L + W - 160, 30, { width: 160, align: 'right' });
    if (first && truck && truck.lines.length) {
      const loaded = truck.lines
        .map((l) => `${shortName(l.name)} ${l.bottlesPerCase > 0 ? `${Math.trunc(l.loadedBottles / l.bottlesPerCase)} cs` : l.loadedBottles}`)
        .join('   ·   ');
      doc.font(B).fontSize(8.5).fillColor(INK).text('On the truck: ', L, y, { continued: true })
        .font(R).fillColor(SOFT).text(loaded, { width: W });
      y = doc.y + 6;
    }
    // Column heads.
    doc.save().rect(L, y, W, 24).fill(HEAD_BG).restore();
    let x = L;
    doc.font(B).fontSize(8).fillColor(INK);
    for (const c of COLS) {
      doc.text(c.label, x + 4, y + 4, { width: c.w - 8 });
      x += c.w;
    }
    return y + 24;
  };

  const cellText = (s: SheetStop) => {
    const who = [s.phone || 'no phone on file', s.contact ? `Contact: ${s.contact}` : ''].filter(Boolean).join('\n');
    const where = [s.address || '—', s.instructions ? `Note: ${s.instructions}` : ''].filter(Boolean).join('\n');
    const what = s.paymentOnly
      ? (s.note ?? 'Collect a payment')
      : [s.orderRef ?? '', ...s.lines].filter(Boolean).join('\n');
    return { who, where, what };
  };

  const rowHeight = (s: SheetStop): number => {
    const t = cellText(s);
    doc.font(B).fontSize(9);
    const nameH = doc.heightOfString(s.name, { width: COLS[1].w - 8 });
    doc.font(R).fontSize(8);
    const whoH = nameH + 2 + doc.heightOfString(t.who, { width: COLS[1].w - 8 });
    const whereH = doc.heightOfString(t.where, { width: COLS[2].w - 8 });
    const whatH = doc.heightOfString(t.what, { width: COLS[3].w - 8 });
    // Room to write: at least enough for the payment boxes and a line.
    return Math.max(58, whoH, whereH, whatH) + 12;
  };

  let y = header(true);
  let totalOwed = 0;
  let totalEmptiesExpected = 0;

  for (const s of stops) {
    const h = rowHeight(s);
    if (y + h > BOTTOM) { doc.addPage(); y = header(false); }
    const t = cellText(s);
    const top = y + 6;
    let x = L;
    // #
    doc.font(B).fontSize(10).fillColor(INK).text(String(s.n), x + 4, top, { width: COLS[0].w - 6 });
    x += COLS[0].w;
    // Customer and phone
    doc.font(B).fontSize(9).fillColor(INK).text(s.name, x + 4, top, { width: COLS[1].w - 8 });
    doc.font(R).fontSize(8).fillColor(SOFT).text(t.who, x + 4, doc.y + 2, { width: COLS[1].w - 8 });
    x += COLS[1].w;
    // Address
    doc.font(R).fontSize(8).fillColor(INK).text(t.where, x + 4, top, { width: COLS[2].w - 8 });
    x += COLS[2].w;
    // Order
    doc.font(R).fontSize(8).fillColor(INK).text(t.what, x + 4, top, { width: COLS[3].w - 8 });
    x += COLS[3].w;
    // To collect
    if (s.onAccount && !s.paymentOnly) {
      doc.font(R).fontSize(8).fillColor(SOFT).text('On account', x + 4, top, { width: COLS[4].w - 8, align: 'right' });
    } else {
      doc.font(B).fontSize(9).fillColor(INK).text(s.owedCents > 0 ? cash(s.owedCents) : '—', x + 4, top, { width: COLS[4].w - 8, align: 'right' });
      totalOwed += s.owedCents;
    }
    x += COLS[4].w;
    // Empties collected: a box to write in, with what they said they would hand over.
    if (!s.paymentOnly) {
      doc.save().lineWidth(0.8).strokeColor(SOFT).rect(x + 10, top, COLS[5].w - 20, 20).stroke().restore();
      if (s.emptiesExpected !== null) {
        doc.font(R).fontSize(7).fillColor(MUTED).text(`expect ${s.emptiesExpected}`, x + 4, top + 24, { width: COLS[5].w - 8, align: 'center' });
        totalEmptiesExpected += s.emptiesExpected;
      } else if (!s.takesReturnables) {
        doc.font(R).fontSize(7).fillColor(MUTED).text('if any', x + 4, top + 24, { width: COLS[5].w - 8, align: 'center' });
      }
    }
    x += COLS[5].w;
    // Payment collected: how, and how much.
    const px = x + 6;
    doc.font(R).fontSize(8).fillColor(INK);
    const ways = ['Cash', 'Cheque', 'Transfer', 'None'];
    let wx = px;
    for (const w of ways) {
      box(doc, wx, top + 1);
      doc.text(w, wx + 11, top + 1, { lineBreak: false });
      wx += 11 + doc.widthOfString(w) + 6;
    }
    doc.font(R).fontSize(8).fillColor(SOFT).text('Amount $', px, top + 22, { lineBreak: false });
    blank(doc, px + 40, top + 31, COLS[6].w - 52);
    if (s.outcome !== 'Pending') {
      doc.font(R).fontSize(7).fillColor(MUTED).text(`Recorded: ${s.outcome}`, px, top + 38, { lineBreak: false });
    }

    y += h;
    doc.save().lineWidth(0.5).strokeColor(RULE).moveTo(L, y).lineTo(L + W, y).stroke().restore();
  }
  if (stops.length === 0) {
    doc.font(R).fontSize(9).fillColor(MUTED).text('No stops on this round.', L + 4, y + 8);
    y += 26;
  }

  // Collection stops: empties, returned goods, supplier pick-ups.
  if (collections.length) {
    if (y + 40 + collections.length * 30 > BOTTOM) { doc.addPage(); y = header(false); }
    y += 10;
    doc.font(B).fontSize(10).fillColor(BLUE).text('Collection stops', L, y);
    y = doc.y + 4;
    for (const c of collections) {
      const who = c.kind === 'Supplier' ? (c.supplier_name ?? 'Supplier') : (c.customer_name ?? 'Customer');
      const where = c.kind === 'Supplier' ? c.supplier_address : c.delivery_address;
      const what = c.kind === 'Empties'
        ? `Collect ${num(c.empties_count)} empt${num(c.empties_count) === 1 ? 'y' : 'ies'}`
        : c.kind === 'Returns'
          ? `Collect returned goods: ${(c.lines ?? []).map((l) => `${Number(l.bottlesPerCase) > 0 ? `${l.cases} cs` : `${l.looseBottles}`} ${shortName(l.name)}`).join(', ') || c.description || ''}${c.reason ? ` (${c.reason})` : ''}`
          : `Pick up${c.po_number ? ` on ${c.po_number}` : ''}: ${(c.lines ?? []).map((l) => `${l.quantity ?? ''} ${l.unit ?? ''} ${l.name}`.replace(/\s+/g, ' ').trim()).join(', ') || c.description || ''}`;
      doc.font(B).fontSize(8.5).fillColor(INK).text(who, L + 4, y, { width: 170 });
      const h1 = doc.y;
      doc.font(R).fontSize(8).fillColor(SOFT).text(where ?? '', L + 180, y, { width: 200 });
      const h2 = doc.y;
      doc.font(R).fontSize(8).fillColor(INK).text(what, L + 390, y, { width: 220 });
      const h3 = doc.y;
      box(doc, L + 630, y + 1);
      doc.font(R).fontSize(8).fillColor(INK).text('Collected   Count ____', L + 642, y + 1, { lineBreak: false });
      y = Math.max(h1, h2, h3, y + 14) + 6;
      doc.save().lineWidth(0.5).strokeColor(RULE).moveTo(L, y - 3).lineTo(L + W, y - 3).stroke().restore();
    }
  }

  // Totals and sign-off.
  if (y + 92 > BOTTOM) { doc.addPage(); y = header(false); }
  y += 14;
  doc.font(B).fontSize(9).fillColor(INK)
    .text(`To collect on this round: ${cash(totalOwed)}`, L, y, { continued: true })
    .font(R).fillColor(SOFT)
    .text(totalEmptiesExpected ? `      Empties expected: ${totalEmptiesExpected}` : '');
  y = doc.y + 16;
  const sign = [
    ['Cash handed in $', 150], ['Cheques $', 120], ['Empties returned', 110],
  ] as const;
  let sx = L;
  doc.font(R).fontSize(8.5).fillColor(INK);
  for (const [label, w] of sign) {
    doc.text(label, sx, y, { lineBreak: false });
    const lw = doc.widthOfString(label) + 4;
    blank(doc, sx + lw, y + 9, w - lw);
    sx += w + 30;
  }
  y += 26;
  sx = L;
  for (const label of ['Driver signature', 'Checked by (office)', 'Date / time back']) {
    doc.text(label, sx, y, { lineBreak: false });
    const lw = doc.widthOfString(label) + 4;
    blank(doc, sx + lw, y + 9, 200 - lw);
    sx += 230;
  }

  // Page numbers.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Writing in the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    doc.font(R).fontSize(7).fillColor(MUTED)
      .text(`Page ${i + 1} of ${range.count}   ·   Record each stop in the app as well; this sheet is the paper copy.`,
        L, 596, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  const safe = sheet.zone.replace(/[^\w -]+/g, '').trim() || 'round';
  return { filename: `Delivery sheet ${safe} ${sheet.delivery_date.slice(0, 10)}.pdf`, pdf: await finished };
}
