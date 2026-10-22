/**
 * Reading the customer upload file (16 Oct 2026): the Excel workbook as it
 * is, or a CSV saved from it. The sample workbook is made-up customers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsx, parseCsv, centsFrom, isoFrom } from '../src/lib/sheetfile.ts';
import { readUpload } from '../src/lib/customerUpload.ts';

describe('Customer upload file', () => {
  test('the Excel workbook: every sheet, the upload rows and their open items', async () => {
    const buf = new Uint8Array(readFileSync(new URL('./fixtures/sample-upload.xlsx', import.meta.url)));
    const sheets = await readXlsx(buf);
    assert.deepEqual(Object.keys(sheets), ['Read Me', 'Customer Upload', 'Open Items']);
    const r = readUpload(sheets);
    assert.equal(r.sheet, 'Customer Upload');
    assert.deepEqual(r.problems, []);
    assert.equal(r.asOf, '2026-10-15');
    assert.equal(r.rows.length, 2);
    const [a, b] = r.rows;
    assert.equal(a.name, 'Sample Distributors Ltd');
    assert.equal(a.customerType, 'Distributor');
    assert.equal(a.openingBalanceCents, 1234567);
    assert.equal(a.deliveryDays, 'Mon, Thu');
    assert.equal(a.canOrderOwnBrand, 'No');
    assert.deepEqual(a.openItems, [{ reference: '90001', type: 'Invoice', date: '2026-09-04',
      dueDate: '2026-10-04', amountCents: 2000000, openCents: 1234567, description: null }]);
    assert.equal(b.name, 'Jane "JJ" Example');
    assert.equal(b.openingBalanceCents, -50000);
    assert.equal(b.openItems[0].openCents, -50000);
    assert.equal(r.withItems, 2);
  });

  test('a CSV saved from it', () => {
    const csv = '﻿Customer Name,Customer Type,Opening Balance (JMD),Delivery Day(s),Zone basis\r\n'
      + '"Smith, John",Individual,"1,500.00","Mon, Thu",ignored\r\n'
      + 'Credit Co,Corporate,(3000.00),,\r\n,,,,\r\n';
    const r = readUpload({ Sheet1: parseCsv(csv) });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.rows.map((x) => [x.name, x.openingBalanceCents, x.deliveryDays]),
      [['Smith, John', 150000, 'Mon, Thu'], ['Credit Co', -300000, '']]);
  });

  test('terms, invoice cycle, instructions and notes columns; price columns are reference only (16 Oct 2026)', () => {
    const csv = 'Customer Name,Payment Terms,Invoice Cycle,5-Gallon Price (JMD),Delivery Instructions,Notes,Check,Sources\n'
      + 'A Co,Due on receipt,Monthly,600,Gate code 1234#,Invoice urgently,Delivery day,1506 list\n';
    const r = readUpload({ Sheet1: parseCsv(csv) });
    assert.deepEqual(r.ignored, []);
    const [a] = r.rows;
    assert.deepEqual([a.paymentTerms, a.invoiceCycle, a.deliveryInstructions, a.notes],
      ['Due on receipt', 'Monthly', 'Gate code 1234#', 'Invoice urgently']);
    assert.ok(!('fiveGallonPriceCents' in a));
  });

  test('money and dates as Excel and QuickBooks write them', () => {
    assert.equal(centsFrom('4,357.26'), 435726);
    assert.equal(centsFrom('(3,000.00)'), -300000);
    assert.equal(centsFrom('-'), 0);
    assert.equal(centsFrom('J$1,000'), 100000);
    assert.ok(Number.isNaN(centsFrom('abc')));
    assert.equal(isoFrom('46310'), '2026-10-15');
    assert.equal(isoFrom('15/10/2026'), '2026-10-15');
    assert.equal(isoFrom('15-Oct-2026'), '2026-10-15');
    assert.equal(isoFrom('2026-10-15 00:00:00'), '2026-10-15');
  });

  test('a file that is not the upload file says so', () => {
    const r = readUpload({ Sheet1: parseCsv('Foo,Bar\n1,2\n') });
    assert.match(r.problems[0], /No "Customer Name" column/);
  });
});
