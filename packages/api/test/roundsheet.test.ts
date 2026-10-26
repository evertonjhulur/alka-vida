/**
 * The printed delivery sheet for a round (Everton, 25 Oct 2026).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { addCollection } from '../src/services/collections.ts';
import { renderDeliverySheetPdf } from '../src/services/roundsheet.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const h of body.matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}

describe('delivery sheet PDF', () => {
  test('lists each stop with name, address, phone, order, and slots for empties and payment', async () => {
    const day = addDays(businessToday(), 5);
    const o = await createOrder(f.db, f.office, {
      customerId: f.customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day,
      lines: [{ productId: f.fiveGalProductId, looseBottles: 3 }, { productId: f.casedProductId, cases: 2 }],
    });
    const st = await f.db.one<{ delivery_sheet_id: string }>(`SELECT delivery_sheet_id FROM delivery_stops WHERE order_id = $1`, [o.id]);
    await f.db.query(`UPDATE customers SET phone = '876-555-0101', delivery_address = '12 Hope Road, Kingston 6' WHERE id = $1`, [f.customerId]);
    await f.db.query(`UPDATE delivery_stops SET delivery_address = NULL, contact_phone = NULL WHERE order_id = $1`, [o.id]);
    await addCollection(f.db, f.office, st.delivery_sheet_id, { kind: 'Empties', customerId: f.otherCustomerId, emptiesCount: 4 } as never);

    const doc = await renderDeliverySheetPdf(f.db, st.delivery_sheet_id);
    assert.match(doc.filename, /^Delivery sheet .+\.pdf$/);
    assert.equal(doc.pdf.subarray(0, 4).toString(), '%PDF');
    const text = pdfText(doc.pdf).replace(/\s+/g, ' ');
    const name = (await f.db.one<{ name: string }>(`SELECT name FROM customers WHERE id = $1`, [f.customerId])).name;
    for (const want of [name, '876-555-0101', '12 Hope Road', o.orderNumber ?? 'SO-', 'Empties collected',
      'Payment collected', 'Cash', 'Cheque', 'Collection stops', 'Collect 4 empties', 'Driver signature']) {
      assert.ok(text.includes(want), `the sheet shows "${want}"`);
    }
  });

  test('an unknown round is refused', async () => {
    await assert.rejects(renderDeliverySheetPdf(f.db, '00000000-0000-0000-0000-000000000000'), /no longer exists/);
  });
});
