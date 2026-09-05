/**
 * Composing a delivery address.
 *
 * Everything downstream - the stop the driver reads, the invoice PDF - takes
 * one string, and did so long before the parts existed. These pin the join so
 * the parts and the whole cannot drift apart.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { composeAddress } from '../src/types.ts';

describe('composeAddress', () => {
  test('joins the parts in the order a driver reads them', () => {
    assert.equal(
      composeAddress({
        addressLine1: '12 Hope Road', addressLine2: 'Suite 4',
        city: 'Kingston 6', parish: 'St Andrew',
      }),
      '12 Hope Road, Suite 4, Kingston 6, St Andrew',
    );
  });

  test('skips the parts that were left out', () => {
    assert.equal(
      composeAddress({ addressLine1: 'Main Street', parish: 'St Ann' }),
      'Main Street, St Ann',
    );
  });

  test('an empty address stays empty rather than becoming punctuation', () => {
    assert.equal(composeAddress({}), null);
    assert.equal(composeAddress({ addressLine1: '', city: '   ' }), null,
      'a form submitted with blank boxes must not produce ", ,"');
  });

  test('surrounding space is trimmed off each part', () => {
    assert.equal(
      composeAddress({ addressLine1: '  5 Braeton Parkway ', city: ' Portmore ' }),
      '5 Braeton Parkway, Portmore',
    );
  });
});
