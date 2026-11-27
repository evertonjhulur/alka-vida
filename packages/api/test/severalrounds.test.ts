/**
 * Several rounds a day (Everton, 27 Nov 2026): rounds made by hand, orders
 * following the first round not started, moving stops between rounds (also
 * after a round has started, with the driver re-sorting), and merging.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupFixture, type Fixture } from './helpers.ts';
import { createOrder } from '../src/services/orders.ts';
import { markStop, getSheet } from '../src/services/delivery.ts';
import { listSheets, keepStopOrder } from '../src/services/routing.ts';
import { createRound, updateRound, moveTargets, moveStops, mergeRound } from '../src/services/rounds.ts';
import { loadRound, confirmLoad } from '../src/services/trucks.ts';
import { noRound } from '../src/services/noround.ts';
import { setPlantLocation, setCustomerPin, proposeSort, applySort } from '../src/services/locations.ts';
import { businessToday } from '../src/services/core.ts';
import { addDays } from '@alka/shared';

let f: Fixture;
const today = businessToday();
let offset = 40;
const nextDay = () => addDays(today, offset++);

before(async () => {
  f = await setupFixture();
  delete process.env.ORS_API_KEY;
  await f.db.query(`INSERT INTO delivery_zones (name) VALUES ('Kingston'), ('Portmore') ON CONFLICT DO NOTHING`);
  await f.db.query(`INSERT INTO finished_goods_stock (product_id, quantity_on_hand) VALUES ($1, 2400), ($2, 2400)
                    ON CONFLICT (product_id) DO UPDATE SET quantity_on_hand = 2400`, [f.casedProductId, f.fiveGalProductId]);
  await f.db.query(`UPDATE system_settings SET value = '2000-01-01' WHERE key = 'no_round_from'`);
});
after(async () => { await f.close(); });

const order = (day: string, customerId = f.customerId, cases = 2) => createOrder(f.db, f.office, {
  customerId, deliveryMode: 'Delivery', requestedDeliveryDate: day, lines: [{ productId: f.casedProductId, cases }],
});
const stopOf = (orderId: string) => f.db.maybeOne<{ id: string; sheet: string; seq: number }>(
  `SELECT st.id, st.delivery_sheet_id AS sheet, st.sequence_no AS seq FROM delivery_stops st
   JOIN delivery_sheets ds ON ds.id = st.delivery_sheet_id
   WHERE st.order_id = $1 AND ds.status = 'Open'`, [orderId]);
const stock = async (id: string) => Number((await f.db.one<{ q: number }>(
  `SELECT quantity_on_hand AS q FROM finished_goods_stock WHERE product_id = $1`, [id])).q);
const sheetRow = (id: string) => f.db.maybeOne<{ name: string | null; resort_needed_at: string | null; resort_note: string | null }>(
  `SELECT name, resort_needed_at, resort_note FROM delivery_sheets WHERE id = $1`, [id]);

describe('Making a round by hand', () => {
  test('a second round for the same zone and day gets a name of its own', async () => {
    const day = nextDay();
    const a = await createRound(f.db, f.office, { day, zone: 'Kingston', driverId: f.driver.id, vehicle: 'Truck 2' });
    assert.equal(a.label, 'Kingston');
    assert.deepEqual(a.warnings, []);
    const b = await createRound(f.db, f.office, { day, zone: 'Kingston' });
    assert.equal(b.label, 'Kingston 2');
    const c = await createRound(f.db, f.office, { day, zone: 'Kingston', name: 'Kingston (Andre)' });
    assert.equal(c.label, 'Kingston (Andre)');
    const all = (await listSheets(f.db, f.office, { date: day })) as Array<{ id: string; driver_name: string | null; vehicle: string | null }>;
    assert.equal(all.length, 3);
    const first = all.find((s) => s.id === a.id)!;
    assert.equal(first.driver_name, 'Driver');
    assert.equal(first.vehicle, 'Truck 2');
    await updateRound(f.db, f.office, b.id, { name: 'Kingston late', vehicle: 'Van' });
    assert.equal((await sheetRow(b.id))!.name, 'Kingston late');
    assert.equal((await moveTargets(f.db, a.id)).length, 2);
  });

  test('not for a day that has passed, nor a zone that does not exist', async () => {
    await assert.rejects(createRound(f.db, f.office, { day: addDays(today, -1), zone: 'Kingston' }), /today or a later day/);
    await assert.rejects(createRound(f.db, f.office, { day: nextDay(), zone: 'Atlantis' }), /no delivery zone called/);
    await assert.rejects(createRound(f.db, f.driver, { day: nextDay(), zone: 'Kingston' }), /role/);
  });
});

describe('Where new orders go', () => {
  test('the first round not started; once all have started, no round', async () => {
    const day = nextDay();
    const o1 = await order(day);
    const first = (await stopOf(o1.id))!.sheet;
    const second = (await createRound(f.db, f.office, { day, zone: 'Kingston' })).id;
    const o2 = await order(day);
    assert.equal((await stopOf(o2.id))!.sheet, first, 'follows the first round');

    await f.db.query(`UPDATE delivery_sheets SET started_at = now() WHERE id = $1`, [first]);
    const o3 = await order(day);
    assert.equal((await stopOf(o3.id))!.sheet, second, 'the first has started: the next one');

    await f.db.query(`UPDATE delivery_sheets SET started_at = now() WHERE id = $1`, [second]);
    const o4 = await order(day);
    assert.equal(await stopOf(o4.id), null, 'every round is out: it waits');
    const waiting = (await noRound(f.db)).orders.find((x) => x.id === o4.id);
    assert.ok(waiting);
    assert.match(waiting!.reason, /had already started/);
  });
});

describe('Moving stops between rounds', () => {
  test('to another round the same day, with or without a reason; zones can mix', async () => {
    const day = nextDay();
    const k = await order(day);
    const p = await order(day, f.otherCustomerId);
    const kSheet = (await stopOf(k.id))!.sheet;
    const pSheet = (await stopOf(p.id))!.sheet;
    assert.notEqual(kSheet, pSheet);

    const r = await moveStops(f.db, f.office, { stopIds: [(await stopOf(p.id))!.id], toSheetId: kSheet, reason: 'Portmore truck down' });
    assert.deepEqual(r.moved, [p.orderNumber]);
    assert.equal((await stopOf(p.id))!.sheet, kSheet);
    const sheet = await getSheet(f.db, kSheet) as unknown as { stop_zones: string[] };
    assert.deepEqual(sheet.stop_zones, ['Kingston', 'Portmore']);
    const log = await f.db.one<{ details: { reason: string; movedTo: string } }>(
      `SELECT details FROM audit_log WHERE entity_type = 'DeliveryStop' AND entity_label = $1 ORDER BY ts DESC LIMIT 1`, [p.orderNumber]);
    assert.equal(log.details.reason, 'Portmore truck down');

    // Back again, no reason needed.
    await moveStops(f.db, f.office, { stopIds: [(await stopOf(p.id))!.id], toSheetId: pSheet });
    assert.equal((await stopOf(p.id))!.sheet, pSheet);
  });

  test('not a stop already recorded, nor to another day', async () => {
    const day = nextDay();
    const a = await order(day);
    const b = await order(day, f.otherCustomerId);
    const sa = (await stopOf(a.id))!;
    await markStop(f.db, f.driver, { stopId: sa.id, outcome: 'Delivered' } as never);
    await assert.rejects(moveStops(f.db, f.office, { stopIds: [sa.id], toSheetId: (await stopOf(b.id))!.sheet }), /already been recorded/);

    const later = await order(nextDay(), f.otherCustomerId);
    await assert.rejects(moveStops(f.db, f.office, { stopIds: [(await stopOf(b.id))!.id], toSheetId: (await stopOf(later.id))!.sheet }),
      /same day/);
  });

  test('onto a round out on the road: added to its load, and the driver re-sorts', async () => {
    await setPlantLocation(f.db, f.admin, { lat: 18.0, lng: -76.95 });
    await setCustomerPin(f.db, f.office, f.customerId, { lat: 18.0, lng: -76.80 });
    await setCustomerPin(f.db, f.office, f.otherCustomerId, { lat: 18.0, lng: -76.90 });
    const day = nextDay();
    const k1 = await order(day, f.customerId, 3);
    const out = (await stopOf(k1.id))!.sheet;
    await loadRound(f.db, f.office, out, {});
    await confirmLoad(f.db, f.driver, out);
    await markStop(f.db, f.driver, { stopId: (await stopOf(k1.id))!.id, outcome: 'Delivered' } as never);

    const p = await order(day, f.otherCustomerId, 2);
    const before_ = await stock(f.casedProductId);
    const r = await moveStops(f.db, f.office, { stopIds: [(await stopOf(p.id))!.id], toSheetId: out });
    assert.ok(r.additionId, 'a last-minute addition for the driver to reconfirm');
    assert.equal(await stock(f.casedProductId), before_ - 48, 'its water came off the shelf');
    const add = await f.db.one<{ driver_confirmed_at: string | null; note: string }>(
      `SELECT driver_confirmed_at, note FROM round_load_additions WHERE id = $1`, [r.additionId]);
    assert.equal(add.driver_confirmed_at, null);
    assert.match(add.note, new RegExp(p.orderNumber));
    const flagged = await sheetRow(out);
    assert.ok(flagged!.resort_needed_at);
    assert.match(flagged!.resort_note!, /moved onto this round/);

    // The driver sorts what is left; the delivered stop stays first.
    const proposal = await proposeSort(f.db, f.driver, out, 'Straight');
    assert.deepEqual(proposal.order, [(await stopOf(p.id))!.id]);
    await applySort(f.db, f.driver, out, { order: proposal.order });
    assert.equal((await sheetRow(out))!.resort_needed_at, null);
    const seqs = await f.db.query<{ outcome: string; seq: number }>(
      `SELECT stop_outcome AS outcome, sequence_no AS seq FROM delivery_stops WHERE delivery_sheet_id = $1 ORDER BY sequence_no`, [out]);
    assert.equal(seqs[0].outcome, 'Delivered');
    assert.ok(seqs[1].seq > seqs[0].seq);
    // Locked again until something else moves onto it.
    await assert.rejects(proposeSort(f.db, f.driver, out), /locked/);
  });

  test('off a loaded round: the water stays on that truck', async () => {
    const day = nextDay();
    const a = await order(day);
    const aSheet = (await stopOf(a.id))!.sheet;
    const b = (await createRound(f.db, f.office, { day, zone: 'Kingston' })).id;
    await loadRound(f.db, f.office, aSheet, {});
    let r = await moveStops(f.db, f.office, { stopIds: [(await stopOf(a.id))!.id], toSheetId: b });
    assert.match(r.warnings.join(' '), /still includes .*Change that loading/);
    await moveStops(f.db, f.office, { stopIds: [(await stopOf(a.id))!.id], toSheetId: aSheet });
    await confirmLoad(f.db, f.driver, aSheet);
    r = await moveStops(f.db, f.office, { stopIds: [(await stopOf(a.id))!.id], toSheetId: b });
    assert.match(r.warnings.join(' '), /stays on the Kingston truck/);
    assert.equal(r.additionId, null, 'the round it joined has no loading yet');
  });

  test('the driver may keep the order instead', async () => {
    const day = nextDay();
    const a = await order(day);
    const out = (await stopOf(a.id))!.sheet;
    await f.db.query(`UPDATE delivery_sheets SET started_at = now(), assigned_driver_id = $2 WHERE id = $1`, [out, f.driver.id]);
    const p = await order(day, f.otherCustomerId);
    await moveStops(f.db, f.office, { stopIds: [(await stopOf(p.id))!.id], toSheetId: out });
    assert.ok((await sheetRow(out))!.resort_needed_at);
    await keepStopOrder(f.db, f.driver, out);
    assert.equal((await sheetRow(out))!.resort_needed_at, null);
  });
});

describe('Merging rounds', () => {
  test('its stops and its loading move onto the other round, and it goes', async () => {
    const day = nextDay();
    const a = await order(day);
    const from = (await stopOf(a.id))!.sheet;
    const p = await order(day, f.otherCustomerId);
    const into = (await stopOf(p.id))!.sheet;
    await loadRound(f.db, f.office, from, { extras: [{ productId: f.casedProductId, extraUnits: 1 }] });
    const shelf = await stock(f.casedProductId);

    const r = await mergeRound(f.db, f.office, from, { intoSheetId: into, reason: 'one driver off sick' });
    assert.deepEqual(r.moved, [a.orderNumber]);
    assert.equal(await sheetRow(from), null, 'the merged round is gone');
    assert.equal((await stopOf(a.id))!.sheet, into);
    assert.equal(await stock(f.casedProductId), shelf, 'nothing moved on the shelf: the goods were already loaded');
    const lines = await f.db.query<{ loaded: number; extra: number }>(
      `SELECT loaded_bottles AS loaded, extra_bottles AS extra FROM round_load_lines WHERE delivery_sheet_id = $1`, [into]);
    assert.equal(Number(lines[0].loaded), 72, 'two cases ordered plus one extra');
    assert.equal(Number(lines[0].extra), 24);
  });

  test('into a round out on the road: the driver reconfirms; a round that has started cannot be merged', async () => {
    const day = nextDay();
    const k = await order(day);
    const out = (await stopOf(k.id))!.sheet;
    await loadRound(f.db, f.office, out, {});
    await confirmLoad(f.db, f.driver, out);
    const extra = (await createRound(f.db, f.office, { day, zone: 'Portmore' })).id;
    const p = await order(day, f.otherCustomerId);
    assert.equal((await stopOf(p.id))!.sheet, extra);
    await loadRound(f.db, f.office, extra, {});
    const shelf = await stock(f.casedProductId);

    await assert.rejects(mergeRound(f.db, f.office, out, { intoSheetId: extra }), /has started/);
    const r = await mergeRound(f.db, f.office, extra, { intoSheetId: out });
    assert.match(r.warnings.join(' '), /reconfirms/);
    assert.equal(await stock(f.casedProductId), shelf);
    const adds = await f.db.query<{ lines: Array<{ bottles: number }> }>(
      `SELECT lines FROM round_load_additions WHERE delivery_sheet_id = $1 AND driver_confirmed_at IS NULL`, [out]);
    assert.equal(adds.length, 1);
    assert.equal(Number(adds[0].lines[0].bottles), 48);
    assert.ok((await sheetRow(out))!.resort_needed_at);
  });
});
