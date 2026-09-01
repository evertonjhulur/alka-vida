import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, nextOccurrence, daysBetween, planSchedule,
} from '../src/recurrence.ts';

describe('calendar arithmetic', () => {
  test('adds days across a month boundary', () => {
    assert.equal(addDays('2027-01-28', 7), '2027-02-04');
  });

  test('adds days across a year boundary', () => {
    assert.equal(addDays('2027-12-30', 7), '2028-01-06');
  });

  test('handles a leap day', () => {
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  });

  test('adding a month clamps to the end of a shorter month', () => {
    // The 31st plus a month is the end of February, not the 2nd of March.
    assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
    assert.equal(addMonths('2027-03-31', 1), '2027-04-30');
  });

  test('adding a month keeps the day where the month is long enough', () => {
    assert.equal(addMonths('2027-01-15', 1), '2027-02-15');
    assert.equal(addMonths('2027-11-30', 1), '2027-12-30');
  });

  test('adding a month rolls the year', () => {
    assert.equal(addMonths('2027-12-15', 1), '2028-01-15');
  });

  test('counts days between dates, signed', () => {
    assert.equal(daysBetween('2027-01-01', '2027-01-08'), 7);
    assert.equal(daysBetween('2027-01-08', '2027-01-01'), -7);
    assert.equal(daysBetween('2027-01-01', '2027-01-01'), 0);
  });

  test('rejects anything that is not a calendar date', () => {
    assert.throws(() => addDays('2027-1-1', 1), /YYYY-MM-DD/);
    assert.throws(() => addDays('not a date', 1), /YYYY-MM-DD/);
  });
});

describe('nextOccurrence', () => {
  test('weekly is seven days', () => {
    assert.equal(nextOccurrence('2027-03-01', 'Weekly'), '2027-03-08');
  });
  test('biweekly is fourteen days', () => {
    assert.equal(nextOccurrence('2027-03-01', 'Biweekly'), '2027-03-15');
  });
  test('monthly is one calendar month', () => {
    assert.equal(nextOccurrence('2027-03-01', 'Monthly'), '2027-04-01');
  });
  test('weekly keeps the same weekday indefinitely', () => {
    let d = '2027-03-01'; // a Monday
    for (let i = 0; i < 20; i++) d = nextOccurrence(d, 'Weekly');
    assert.equal(new Date(`${d}T00:00:00Z`).getUTCDay(), 1, 'still a Monday');
  });
});

describe('planSchedule', () => {
  const weekly = { pattern: 'Weekly' as const, today: '2027-05-10' };

  test('raises an occurrence early, within the lead time', () => {
    // Due in 3 days, lead is 7, so it should be raised now.
    const plan = planSchedule({ ...weekly, nextDate: '2027-05-13' });
    assert.deepEqual(plan.due, ['2027-05-13']);
    assert.equal(plan.nextDate, '2027-05-20');
  });

  test('does not raise anything beyond the lead time', () => {
    const plan = planSchedule({ ...weekly, nextDate: '2027-06-20' });
    assert.deepEqual(plan.due, []);
    assert.equal(plan.nextDate, '2027-06-20', 'the schedule does not move');
  });

  test('raises a recently overdue occurrence rather than losing it', () => {
    // Two days late: the customer still needs their water.
    const plan = planSchedule({ ...weekly, nextDate: '2027-05-08' });
    assert.ok(plan.due.includes('2027-05-08'));
    assert.deepEqual(plan.skipped, []);
  });

  test('skips occurrences too old to be worth raising, and rolls past them', () => {
    // The app sat closed for months. Do not create a pile of back-dated orders.
    const plan = planSchedule({ ...weekly, nextDate: '2027-01-04' }, { maxPerRun: 60 });
    assert.ok(plan.skipped.length > 0, 'the missed cycles are reported');
    assert.ok(
      plan.due.every((d) => daysBetween('2027-04-26', d) >= 0),
      'only recent occurrences are raised',
    );
    assert.ok(daysBetween('2027-05-10', plan.nextDate) > 0, 'the schedule catches up');
  });

  test('catches up several cycles at once when they are all recent', () => {
    // Weekly, two weeks behind: both the missed one and the upcoming one.
    const plan = planSchedule({ ...weekly, nextDate: '2027-05-03' });
    assert.deepEqual(plan.due, ['2027-05-03', '2027-05-10', '2027-05-17']);
  });

  test('stops at the end date', () => {
    const plan = planSchedule({
      ...weekly, nextDate: '2027-05-03', endsOn: '2027-05-10',
    });
    assert.deepEqual(plan.due, ['2027-05-03', '2027-05-10']);
  });

  test('a schedule already past its end date produces nothing', () => {
    const plan = planSchedule({
      ...weekly, nextDate: '2027-05-03', endsOn: '2027-04-01',
    });
    assert.deepEqual(plan.due, []);
  });

  test('never runs away, however corrupt the starting date', () => {
    const plan = planSchedule({ ...weekly, nextDate: '1990-01-01' });
    assert.ok(plan.due.length + plan.skipped.length <= 12, 'capped by maxPerRun');
  });

  test('is deterministic - planning twice from the same state plans the same work', () => {
    const a = planSchedule({ ...weekly, nextDate: '2027-05-03' });
    const b = planSchedule({ ...weekly, nextDate: '2027-05-03' });
    assert.deepEqual(a, b);
  });

  test('monthly schedules on the 31st stay on month ends', () => {
    const plan = planSchedule({
      pattern: 'Monthly', today: '2027-01-30', nextDate: '2027-01-31',
    });
    assert.deepEqual(plan.due, ['2027-01-31']);
    assert.equal(plan.nextDate, '2027-02-28');
  });
});
