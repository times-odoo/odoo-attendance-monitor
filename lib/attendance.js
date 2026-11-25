/**
 * Pure helpers shared by the service worker and the popup.
 */

export const ODOO_ORIGIN = 'https://www.odoo.com';
export const ODOO_APP_URL = `${ODOO_ORIGIN}/odoo`;
export const ODOO_TABS_PATTERN = `${ODOO_ORIGIN}/odoo*`;
export const ATTENDANCE_URL = `${ODOO_ORIGIN}/hr_attendance/attendance_user_data`;

export const DEFAULT_CHECKIN_TIME = '10:00';
export const DEFAULT_CHECKOUT_TIME = '19:00';

/**
 * Interpret a JSON-RPC response from /hr_attendance/attendance_user_data.
 * @returns {{ kind: 'ok', data: {attendance_state, hours_today, last_check_in} }
 *         | { kind: 'signed_out' }
 *         | { kind: 'no_employee' }
 *         | { kind: 'error', message: string }}
 */
export function parseAttendanceResponse(json) {
  if (!json || typeof json !== 'object') {
    return { kind: 'error', message: 'Empty response' };
  }
  if (json.error) {
    const name = json.error.data?.name || '';
    if (name.includes('SessionExpired')) return { kind: 'signed_out' };
    return { kind: 'error', message: json.error.data?.message || json.error.message || 'Odoo error' };
  }
  const r = json.result;
  // The controller returns {} when the user has no employee.
  if (r && typeof r === 'object' && Object.keys(r).length === 0) return { kind: 'no_employee' };
  const d = r?.attendance_state ? r : r?.attendance_user_data;
  if (!d?.attendance_state) {
    return { kind: 'error', message: 'Unexpected response' };
  }
  return {
    kind: 'ok',
    data: {
      attendance_state: d.attendance_state,
      hours_today: typeof d.hours_today === 'number' ? d.hours_today : null,
      last_check_in: d.last_check_in || null,
    },
  };
}

/** Odoo datetimes are naive UTC strings: "2026-11-25 04:18:00". */
export function parseOdooDatetime(value) {
  if (!value) return null;
  const d = new Date(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Decimal hours → "8h05" / "8h" / "0h42". */
export function formatHours(decimal) {
  if (typeof decimal !== 'number' || Number.isNaN(decimal)) return '';
  let h = Math.floor(decimal);
  let m = Math.round((decimal - h) * 60);
  if (m === 60) { h += 1; m = 0; }
  return m > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

/** "HH:MM" → { hour, minute }, falling back to the given default. */
export function parseTime(value, fallback = '00:00') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '') || /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Next Date (after `now`) at which the local clock reads `timeStr`. */
export function nextOccurrence(timeStr, now = new Date()) {
  const { hour, minute } = parseTime(timeStr);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Whether a reminder for `timeStr` is still relevant at `now`: today, at or
 * after the configured time, and less than `graceHours` later. This drops
 * reminders whose alarm fired late (e.g. the computer was asleep overnight).
 */
export function isReminderDue(timeStr, now = new Date(), graceHours = 3) {
  const { hour, minute } = parseTime(timeStr);
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  const diff = now - at;
  return diff >= -60_000 && diff < graceHours * 3_600_000;
}

/** Local calendar day key, e.g. "2026-11-25". */
export function dayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** "9:30 AM"-style label in the user's locale. */
export function formatClock(date) {
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}
