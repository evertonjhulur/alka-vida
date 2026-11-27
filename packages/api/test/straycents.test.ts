/**
 * Stray cents on credit (Everton, 27 Nov 2026): Doris Jackson's J$0.01 made
 * the driver ask for J$999.99. Clear odd cents of J$0.04 or less on credit,
 * whatever the rest of the balance; receipts stay as they were.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { listStrayCents, clearStrayCents } from '../src/services/straycents.ts';
import { insertPayment, applyAccountCredit } from '../src/services/payments.ts';
import { createInvoice } from '../src/services/invoices.ts';
import { getStatement } from '../src/services/ledger.ts';

let f: Fixture;
before(async () => { f = await setupFixture(); });
after(async () => { await f.close(); });

const bal = async (id: string) => Number((await f.db.one<{ b: number }>(
  `SELECT COALESCE(balance_cents,0) AS b FROM customer_balances WHERE customer_id = $1`, [id])).b);
const newCustomer = async (name: string) => (await f.db.one<{ id: string }>(
  `INSERT INTO customers (name, phone, email) VALUES ($1, '876-555-0000', lower(replace($1,' ','')) || '@x.jm') RETURNING id`, [name])).id;
const pay = (customerId: string, cents: number, receiptNumber?: string) =>
  insertPayment(f.db, f.admin, { customerId, amountCents: cents, method: 'Cash', receiptNumber } as never);
const fiveGal = (customerId: string, n: number) => f.db.tx((t) => createInvoice(t, f.admin, { customerId,
  lines: [{ productId: f.fiveGalProductId, cases: 0, looseBottles: n, pricePerCaseCents: 0, pricePerBottleCents: 43478 }] }));

describe('Stray cents on credit', () => {
  test('a cent on its own, a cent inside a balance owed, and the tail of a real credit', async () => {
    const a = await newCustomer('Cent Only');
    await pay(a, 1);
    const b = await newCustomer('Owes Too');
    await fiveGal(b, 2); await pay(b, 1);
    const c = await newCustomer('Real Credit');
    await pay(c, 370001);
    const d = await newCustomer('Fifty Cents');
    await pay(d, 750);

    const list = await listStrayCents(f.db);
    const names = list.map((x) => x.name);
    assert.ok(names.includes('Cent Only') && names.includes('Owes Too') && names.includes('Real Credit'));
    assert.ok(!names.includes('Fifty Cents'), 'J$7.50 is a real credit, left alone');
    assert.equal(list.find((x) => x.name === 'Owes Too')!.balanceAfterCents, 100000);

    const r = await clearStrayCents(f.db, f.admin, { customerIds: [a, b, c] });
    assert.equal(r.cleared.length, 3);
    assert.equal(await bal(a), 0);
    assert.equal(await bal(b), 100000);
    assert.equal(await bal(c), -370000, 'J$3,700.00 credit kept');
    assert.equal((await listStrayCents(f.db)).some((x) => [a, b, c].includes(x.customerId)), false);

    // The cent never goes on an invoice again: a J$1,000 invoice stays J$1,000 to pay.
    const inv = await fiveGal(a, 2);
    assert.equal(await f.db.tx((t) => applyAccountCredit(t, f.admin, inv.id)), 0);
    // The real credit still applies.
    const invC = await fiveGal(c, 2);
    assert.equal(await f.db.tx((t) => applyAccountCredit(t, f.admin, invC.id)), 100000);

    const st = await getStatement(f.db, a) as unknown as { entries?: Array<{ description: string }>; lines?: Array<{ description: string }> };
    const lines = st.entries ?? st.lines ?? [];
    assert.ok(JSON.stringify(st).includes('Rounding adjustment'));
    void lines;
  });

  test('admins only, and clearing twice does nothing more', async () => {
    const a = await newCustomer('Twice');
    await pay(a, 2);
    await assert.rejects(clearStrayCents(f.db, f.office, { customerIds: [a] }), /role/);
    await clearStrayCents(f.db, f.admin, { customerIds: [a] });
    const again = await clearStrayCents(f.db, f.admin, { customerIds: [a] });
    assert.equal(again.cleared.length, 0);
    assert.equal(await bal(a), 0);
  });
});
