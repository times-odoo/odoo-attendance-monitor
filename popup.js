/**
 * Odoo Attendance Monitor — popup.
 *
 * Reads everything from chrome.storage.local (written by the service worker)
 * and re-renders on change. Reminder settings are written straight to
 * storage; the service worker reschedules its alarms when they change.
 */

import {
  ODOO_APP_URL, DEFAULT_CHECKIN_TIME, DEFAULT_CHECKOUT_TIME,
  formatHours, formatClock, parseOdooDatetime,
} from './lib/attendance.js';

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const statusLabel = $('status-label');
const statusDetail = $('status-detail');
const errorEl = $('error');
const updatedEl = $('updated');
const btnRefresh = $('btn-refresh');

const STATE_KEYS = ['attendance_state', 'hours_today', 'last_check_in', 'last_polled', 'poll_status', 'poll_error'];

const SETTINGS = [
  { toggle: $('checkin-enabled'), time: $('checkin-time'),
    enabledKey: 'reminder_enabled', timeKey: 'checkin_reminder_time', defaultTime: DEFAULT_CHECKIN_TIME },
  { toggle: $('checkout-enabled'), time: $('checkout-time'),
    enabledKey: 'checkout_reminder_enabled', timeKey: 'checkout_reminder_time', defaultTime: DEFAULT_CHECKOUT_TIME },
];

// ── Status ───────────────────────────────────────────────────────────

async function render() {
  const s = await chrome.storage.local.get(STATE_KEYS);
  const state = s.attendance_state;
  statusEl.dataset.state = state || 'unknown';

  if (state === 'checked_in' || state === 'checked_out') {
    statusLabel.textContent = state === 'checked_in' ? 'Checked in' : 'Checked out';
    statusDetail.textContent = describe(s);
  } else if (s.poll_status === 'signed_out') {
    statusLabel.textContent = 'Not signed in';
    statusDetail.textContent = 'Sign in to odoo.com to see your attendance.';
  } else if (s.poll_status === 'no_employee') {
    statusLabel.textContent = 'No employee';
    statusDetail.textContent = 'Your odoo.com user has no linked employee.';
  } else {
    statusLabel.textContent = s.poll_status ? 'Unknown' : 'Loading…';
    statusDetail.textContent = '';
  }

  const failing = s.poll_status === 'error';
  errorEl.textContent = failing ? `Couldn't reach Odoo: ${s.poll_error}` : '';
  errorEl.classList.toggle('hidden', !failing);

  updatedEl.textContent = s.last_polled ? `Updated ${timeAgo(s.last_polled)}` : '';
}

function describe(s) {
  const parts = [];
  const checkIn = formatClock(parseOdooDatetime(s.last_check_in));
  if (s.attendance_state === 'checked_in') {
    if (checkIn) parts.push(`since ${checkIn}`);
  } else if (checkIn) {
    parts.push(`last check-in ${checkIn}`);
  }
  if (typeof s.hours_today === 'number') {
    let hours = s.hours_today;
    // Keep the counter moving between polls while checked in.
    if (s.attendance_state === 'checked_in' && s.last_polled) {
      hours += Math.max(0, Date.now() - new Date(s.last_polled)) / 3_600_000;
    }
    parts.push(`${formatHours(hours)} today`);
  }
  return parts.join(' · ');
}

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

// ── Reminder settings ────────────────────────────────────────────────

async function loadSettings() {
  const prefs = await chrome.storage.local.get(SETTINGS.flatMap(s => [s.enabledKey, s.timeKey]));
  for (const s of SETTINGS) {
    s.toggle.checked = prefs[s.enabledKey] !== false;
    s.time.value = prefs[s.timeKey] || s.defaultTime;
    s.time.disabled = !s.toggle.checked;

    s.toggle.addEventListener('change', () => {
      s.time.disabled = !s.toggle.checked;
      chrome.storage.local.set({ [s.enabledKey]: s.toggle.checked });
    });
    s.time.addEventListener('change', () => {
      if (s.time.value) chrome.storage.local.set({ [s.timeKey]: s.time.value });
    });
  }
}

// ── Actions ──────────────────────────────────────────────────────────

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  btnRefresh.classList.add('busy');
  try {
    await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
  } catch {
    // The error, if any, is shown from storage.
  } finally {
    btnRefresh.classList.remove('busy');
    btnRefresh.disabled = false;
  }
});

$('open-odoo').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: ODOO_APP_URL });
  window.close();
});

// ── Init ─────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STATE_KEYS.some(k => k in changes)) render();
});
setInterval(render, 30_000);

render();
loadSettings().then(() => {
  // Flush styles first, so the loaded values apply without animating.
  void document.body.offsetWidth;
  document.body.classList.add('ready');
});
// Fresh data when opening the popup (cheap, and the state may be a minute old).
chrome.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});
