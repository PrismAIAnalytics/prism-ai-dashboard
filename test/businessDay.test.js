// businessDay.test.js — T-124 / PRISM-715
//
// Locks the Eastern business-day helpers that fix the recurring "Daily Agenda
// shows yesterday's brief" bug. The root cause was UTC `today`: from ~8 PM ET to
// midnight ET (00:00-04:00 UTC) the server's UTC date had already rolled to
// tomorrow, so today's ET-dated brief resolved only as "yesterday" and got the
// stale banner. These tests pin a fixed instant and assert ET, not UTC.
//
// Pure unit tests — no filesystem, no network. Run with `npm test`.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { businessToday, businessDayMinus } = require('../services/businessDay');

test('businessToday: 8 PM-midnight ET window stays on the ET date, not UTC tomorrow', () => {
  // 2026-06-24T23:30 ET (EDT, -4) === 2026-06-25T03:30 UTC.
  // UTC slice would say 2026-06-25 (the bug); ET must say 2026-06-24.
  const at = new Date('2026-06-25T03:30:00.000Z');
  assert.strictEqual(at.toISOString().slice(0, 10), '2026-06-25', 'precondition: UTC has already rolled');
  assert.strictEqual(businessToday(at), '2026-06-24', 'must report the ET business day');
});

test('businessToday: just after midnight ET reports the new ET date', () => {
  // 2026-06-24T00:15 ET === 2026-06-24T04:15 UTC. Both agree here.
  const at = new Date('2026-06-24T04:15:00.000Z');
  assert.strictEqual(businessToday(at), '2026-06-24');
});

test('businessToday: midday is unambiguous', () => {
  const at = new Date('2026-06-24T16:00:00.000Z'); // 12:00 ET
  assert.strictEqual(businessToday(at), '2026-06-24');
});

test('businessToday: standard time (EST, -5) evening window', () => {
  // 2026-01-15T22:00 ET (EST) === 2026-01-16T03:00 UTC.
  const at = new Date('2026-01-16T03:00:00.000Z');
  assert.strictEqual(at.toISOString().slice(0, 10), '2026-01-16', 'precondition: UTC rolled');
  assert.strictEqual(businessToday(at), '2026-01-15', 'EST evening must stay on the ET date');
});

test('businessDayMinus(1): yesterday in the evening window is the true ET yesterday', () => {
  // Same instant as the symptom case: ET today = 2026-06-24, so yesterday = 2026-06-23.
  const at = new Date('2026-06-25T03:30:00.000Z');
  assert.strictEqual(businessDayMinus(1, at), '2026-06-23');
});

test('businessDayMinus(0) equals businessToday', () => {
  const at = new Date('2026-06-25T03:30:00.000Z');
  assert.strictEqual(businessDayMinus(0, at), businessToday(at));
});

test('businessDayMinus: crosses a month boundary correctly', () => {
  const at = new Date('2026-07-01T12:00:00.000Z'); // ET 2026-07-01
  assert.strictEqual(businessDayMinus(1, at), '2026-06-30');
});

test('businessDayMinus: DST-safe across the spring-forward boundary', () => {
  // DST 2026 begins Sun Mar 8. Anchor on Mar 9 ET; minus 1 must be Mar 8 (the
  // 23-hour day) — pure calendar math, no 86_400_000 ms drift.
  const at = new Date('2026-03-09T16:00:00.000Z'); // 12:00 ET on Mar 9
  assert.strictEqual(businessToday(at), '2026-03-09');
  assert.strictEqual(businessDayMinus(1, at), '2026-03-08');
});

test('businessToday: output is always a valid YYYY-MM-DD string', () => {
  assert.match(businessToday(new Date('2026-06-24T16:00:00.000Z')), /^\d{4}-\d{2}-\d{2}$/);
});
