/**
 * Tests for lib/attendance.js. Run: node --test tests/
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  parseAttendanceResponse, parseOdooDatetime, formatHours,
  nextOccurrence, isReminderDue, dayKey,
} from '../lib/attendance.js';

describe('parseAttendanceResponse', () => {
  it('reads the flat result returned by hr_attendance', () => {
    const r = parseAttendanceResponse({ result: { attendance_state: 'checked_in', hours_today: 2.5, last_check_in: '2026-11-25 04:18:00', id: 7 } });
    assert.deepEqual(r, { kind: 'ok', data: { attendance_state: 'checked_in', hours_today: 2.5, last_check_in: '2026-11-25 04:18:00' } });
  });

  it('reads the nested attendance_user_data shape', () => {
    const r = parseAttendanceResponse({ result: { attendance_user_data: { attendance_state: 'checked_out' } } });
    assert.equal(r.kind, 'ok');
    assert.equal(r.data.attendance_state, 'checked_out');
    assert.equal(r.data.hours_today, null);
  });

  it('detects an expired session', () => {
    const r = parseAttendanceResponse({ error: { code: 100, message: 'Odoo Session Expired', data: { name: 'odoo.http.SessionExpiredException' } } });
    assert.deepEqual(r, { kind: 'signed_out' });
  });

  it('detects a user without employee (empty result)', () => {
    assert.deepEqual(parseAttendanceResponse({ result: {} }), { kind: 'no_employee' });
  });

  it('reports other errors', () => {
    assert.equal(parseAttendanceResponse({ error: { message: 'Odoo Server Error', data: { name: 'x', message: 'boom' } } }).message, 'boom');
    assert.equal(parseAttendanceResponse(null).kind, 'error');
    assert.equal(parseAttendanceResponse({ result: { foo: 1 } }).kind, 'error');
  });
});

describe('parseOdooDatetime', () => {
  it('treats naive Odoo datetimes as UTC', () => {
    assert.equal(parseOdooDatetime('2026-11-25 04:18:00').toISOString(), '2026-11-25T04:18:00.000Z');
  });
  it('returns null for empty or invalid values', () => {
    assert.equal(parseOdooDatetime(false), null);
    assert.equal(parseOdooDatetime('nope'), null);
  });
});

describe('formatHours', () => {
  it('formats decimal hours', () => {
    assert.equal(formatHours(8.0833), '8h05');
    assert.equal(formatHours(8), '8h');
    assert.equal(formatHours(0.7), '0h42');
  });
  it('carries 60 minutes over to the next hour', () => {
    assert.equal(formatHours(1.999), '2h');
  });
  it('returns an empty string for non-numbers', () => {
    assert.equal(formatHours(null), '');
  });
});

describe('reminder timing', () => {
  const at = (h, m) => new Date(2026, 10, 25, h, m, 0, 0);

  it('nextOccurrence is later today when the time has not passed', () => {
    assert.equal(nextOccurrence('10:00', at(9, 0)).getTime(), at(10, 0).getTime());
  });
  it('nextOccurrence is tomorrow when the time has passed', () => {
    assert.equal(nextOccurrence('10:00', at(10, 0)).getDate(), 26);
  });
  it('isReminderDue within the grace period only', () => {
    assert.equal(isReminderDue('19:00', at(19, 0)), true);
    assert.equal(isReminderDue('19:00', at(21, 30)), true);
    assert.equal(isReminderDue('19:00', at(23, 0)), false);
    assert.equal(isReminderDue('19:00', at(9, 0)), false); // alarm fired the next morning
  });
  it('dayKey uses the local date', () => {
    assert.equal(dayKey(at(23, 59)), '2026-11-25');
  });
});
