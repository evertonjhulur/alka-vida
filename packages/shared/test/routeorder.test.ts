import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orderStops, tourKm, haversineKm, parseLatLng, inJamaica } from '../src/routeorder.ts';

const plant = { lat: 18.0, lng: -76.95 };

describe('straight-line stop order (23 Oct 2026)', () => {
  test('a kilometre is about right', () => {
    // One degree of latitude is about 111 km.
    assert.ok(Math.abs(haversineKm({ lat: 18, lng: -77 }, { lat: 19, lng: -77 }) - 111.2) < 0.5);
  });

  test('stops along a line are visited in line, not zig-zag', () => {
    const pts = [0.05, 0.01, 0.04, 0.02, 0.03].map((d) => ({ lat: 18.0, lng: -76.95 + d }));
    const order = orderStops(plant, pts);
    const along = order.map((i) => pts[i].lng);
    const sorted = [...along].sort((a, b) => a - b);
    assert.ok(JSON.stringify(along) === JSON.stringify(sorted) || JSON.stringify(along) === JSON.stringify([...sorted].reverse()));
  });

  test('never longer than the order it was given', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 20; run++) {
      const pts = Array.from({ length: 30 }, () => ({ lat: 17.95 + rnd() * 0.15, lng: -76.95 + rnd() * 0.25 }));
      const order = orderStops(plant, pts);
      assert.equal(new Set(order).size, pts.length, 'every stop exactly once');
      assert.ok(tourKm(plant, order.map((i) => pts[i])) <= tourKm(plant, pts) + 1e-9);
    }
  });

  test('none or one stop', () => {
    assert.deepEqual(orderStops(plant, []), []);
    assert.deepEqual(orderStops(plant, [{ lat: 18.01, lng: -76.8 }]), [0]);
  });
});

describe('reading coordinates people paste', () => {
  test('plain, @, q= and !3d!4d forms', () => {
    assert.deepEqual(parseLatLng('18.0123, -76.9456'), { lat: 18.0123, lng: -76.9456 });
    assert.deepEqual(parseLatLng('https://www.google.com/maps/@18.0123,-76.9456,17z'), { lat: 18.0123, lng: -76.9456 });
    assert.deepEqual(parseLatLng('https://maps.google.com/?q=18.0123,-76.9456'), { lat: 18.0123, lng: -76.9456 });
    assert.deepEqual(parseLatLng('https://www.google.com/maps/place/X/data=!3m1!4b1!4m6!3d18.0123!4d-76.9456'), { lat: 18.0123, lng: -76.9456 });
    assert.equal(parseLatLng('Shop 4, Papine Square'), null);
  });
  test('only Jamaica', () => {
    assert.ok(inJamaica({ lat: 18.01, lng: -76.8 }));
    assert.ok(!inJamaica({ lat: 25.76, lng: -80.19 })); // Miami
    assert.ok(!inJamaica({ lat: -76.8, lng: 18.01 })); // the wrong way round
  });
});
