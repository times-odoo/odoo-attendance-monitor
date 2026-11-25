/**
 * Odoo Attendance Monitor — MV3 service worker.
 *
 *  - Polls /hr_attendance/attendance_user_data every minute (the only poller)
 *  - Sets the toolbar icon: green = checked in, red = checked out, grey = unknown
 *  - Pushes the state to open Odoo tabs (favicon dot)
 *  - Check-in / check-out reminders at the configured times, with snooze
 */

import {
  ATTENDANCE_URL, ODOO_ORIGIN, ODOO_APP_URL, ODOO_TABS_PATTERN,
  DEFAULT_CHECKIN_TIME, DEFAULT_CHECKOUT_TIME,
  parseAttendanceResponse, nextOccurrence, isReminderDue, dayKey,
  formatHours, formatClock, parseOdooDatetime,
} from './lib/attendance.js';

const POLL_ALARM = 'poll';
const REMINDER_ALARMS = { checkin: 'remind:checkin', checkout: 'remind:checkout' };
const SNOOZE_ALARMS = { checkin: 'snooze:checkin', checkout: 'snooze:checkout' };
const SNOOZE_MINUTES = 5;
const FETCH_TIMEOUT_MS = 15_000;

const PREF_KEYS = ['reminder_enabled', 'checkin_reminder_time', 'checkout_reminder_enabled', 'checkout_reminder_time'];

const ICONS = {
  checked_in:  { 16: 'icons/green_16.png', 32: 'icons/green_32.png', 48: 'icons/green_48.png', 128: 'icons/green_128.png' },
  checked_out: { 16: 'icons/red_16.png',   32: 'icons/red_32.png',   48: 'icons/red_48.png',   128: 'icons/red_128.png' },
  unknown:     { 16: 'icons/icon16.png',   32: 'icons/icon32.png',   48: 'icons/icon48.png',   128: 'icons/icon128.png' },
};

// ── Setup ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // Leftovers from the removed backend-sync feature and old alarm names.
  await chrome.storage.local.remove(['backend_enabled', 'backend_url', 'backend_api_key']);
  for (const name of ['attendance_reminder', 'checkout_reminder', 'snooze_checkin', 'snooze_checkout', 'attendance_poll', 'sync_session']) {
    await chrome.alarms.clear(name);
  }
  await scheduleAll();
  poll();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAll();
  poll();
});

// Every service-worker wake-up: make sure the alarms exist (cheap).
ensureAlarms();

async function ensureAlarms() {
  const existing = new Set((await chrome.alarms.getAll()).map(a => a.name));
  if (!existing.has(POLL_ALARM) || !existing.has(REMINDER_ALARMS.checkin) || !existing.has(REMINDER_ALARMS.checkout)) {
    await scheduleAll();
  }
}

async function scheduleAll() {
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  const prefs = await chrome.storage.local.get(PREF_KEYS);
  scheduleDaily(REMINDER_ALARMS.checkin, prefs.checkin_reminder_time || DEFAULT_CHECKIN_TIME);
  scheduleDaily(REMINDER_ALARMS.checkout, prefs.checkout_reminder_time || DEFAULT_CHECKOUT_TIME);
}

function scheduleDaily(name, timeStr) {
  // One-shot alarm, re-armed after it fires: a 24h period would drift
  // across DST changes.
  chrome.alarms.create(name, { when: nextOccurrence(timeStr).getTime() });
}

// Reschedule when the popup changes reminder times.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.checkin_reminder_time || changes.checkout_reminder_time)) {
    scheduleAll();
  }
});

// ── Alarms ───────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case POLL_ALARM:
      await poll();
      break;
    case REMINDER_ALARMS.checkin:
    case REMINDER_ALARMS.checkout: {
      const kind = alarm.name === REMINDER_ALARMS.checkin ? 'checkin' : 'checkout';
      const prefs = await chrome.storage.local.get(PREF_KEYS);
      const timeStr = kind === 'checkin'
        ? (prefs.checkin_reminder_time || DEFAULT_CHECKIN_TIME)
        : (prefs.checkout_reminder_time || DEFAULT_CHECKOUT_TIME);
      scheduleDaily(alarm.name, timeStr); // re-arm for tomorrow
      // A late alarm (computer was asleep) is only useful within a few hours.
      if (isReminderDue(timeStr)) await remind(kind, { snoozed: false });
      break;
    }
    case SNOOZE_ALARMS.checkin:
      await remind('checkin', { snoozed: true });
      break;
    case SNOOZE_ALARMS.checkout:
      await remind('checkout', { snoozed: true });
      break;
  }
});

// ── Polling ──────────────────────────────────────────────────────────

// Serialized so the alarm and a manual refresh never overlap.
let pollQueue = Promise.resolve();

function poll() {
  const run = pollQueue.then(doPoll);
  pollQueue = run.catch(() => {});
  return run;
}

async function doPoll() {
  let outcome = await fetchFromServiceWorker();
  if (outcome.kind === 'error') {
    // Fall back to an open Odoo tab (same-origin request from the page).
    const fromTab = await fetchFromTab();
    if (fromTab) outcome = fromTab;
  }
  await applyOutcome(outcome);
}

async function fetchFromServiceWorker() {
  try {
    // The browser attaches the www.odoo.com cookies itself (host permission).
    // The extension never reads them: no `cookies` permission, and a manual
    // Cookie header would be dropped by Chrome anyway (forbidden header).
    // Read-only route: this extension never checks you in or out.
    const resp = await fetch(ATTENDANCE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: {}, id: Date.now() }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return { kind: 'error', message: `HTTP ${resp.status}` };
    return parseAttendanceResponse(await resp.json());
  } catch (err) {
    return { kind: 'error', message: err.name === 'TimeoutError' ? 'Request timed out' : err.message };
  }
}

async function fetchFromTab() {
  const tabs = await chrome.tabs.query({ url: ODOO_TABS_PATTERN });
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_POLL_TAB' });
      if (response?.json) return parseAttendanceResponse(response.json);
    } catch {
      // Content script not loaded in this tab (e.g. opened before install).
    }
  }
  return null;
}

async function applyOutcome(outcome) {
  const now = new Date().toISOString();
  if (outcome.kind === 'ok') {
    await saveState({ ...outcome.data, last_polled: now, poll_status: 'ok', poll_error: null });
  } else if (outcome.kind === 'signed_out' || outcome.kind === 'no_employee') {
    // Definitive: we know we can't tell the state, so don't show a stale one.
    await saveState({ attendance_state: null, hours_today: null, last_check_in: null,
      last_polled: now, poll_status: outcome.kind, poll_error: null });
  } else {
    // Transient error: keep the last known state, just record the error.
    await chrome.storage.local.set({ poll_status: 'error', poll_error: outcome.message });
  }
}

async function saveState(state) {
  await chrome.storage.local.set(state);
  setIcon(state.attendance_state);
  broadcast(state);
}

function setIcon(attendanceState) {
  chrome.action.setIcon({ path: ICONS[attendanceState] || ICONS.unknown });
  chrome.action.setTitle({
    title: attendanceState === 'checked_in' ? 'Odoo: checked in'
      : attendanceState === 'checked_out' ? 'Odoo: checked out'
      : 'Odoo Attendance Monitor',
  });
}

async function broadcast(state) {
  const tabs = await chrome.tabs.query({ url: ODOO_TABS_PATTERN });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'ATTENDANCE_UPDATE', state: state.attendance_state }).catch(() => {});
  }
}

// ── Messages ─────────────────────────────────────────────────────────

// Only our own popup may trigger polls, and only content scripts running on
// www.odoo.com may report data (defence in depth: no other page or extension
// can reach this listener without `externally_connectable`).
// `origin` is the extension's own origin for its pages (popup), and the page
// origin for content scripts (verified in Chrome; `tab` is set for both when
// opened in a tab, so it can't tell them apart).
const fromOwnPage = (sender) => sender.id === chrome.runtime.id
  && sender.origin === `chrome-extension://${chrome.runtime.id}`;
const fromOdooTab = (sender) => sender.id === chrome.runtime.id && !!sender.tab
  && sender.origin === ODOO_ORIGIN;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'POLL_NOW' && fromOwnPage(sender)) {
    poll().then(() => sendResponse({ ok: true }), (err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg?.type === 'ATTENDANCE_DATA' && fromOdooTab(sender)) {
    // An open Odoo tab polled (every minute, same-origin) and reports.
    const outcome = parseAttendanceResponse(msg.json);
    if (outcome.kind !== 'error') applyOutcome(outcome);
    return false;
  }
});

// ── Reminders ────────────────────────────────────────────────────────

const REMINDER_TEXT = {
  checkin: {
    title: 'Not checked in',
    snoozedTitle: 'Still not checked in',
    message: (s) => (s.known
      ? "You haven't checked in to Odoo yet."
      : "Couldn't read your attendance (signed out of odoo.com?). Make sure you're checked in."),
  },
  checkout: {
    title: 'Time to check out',
    snoozedTitle: 'Still checked in',
    message: (s) => `You've been checked in${s.since ? ` since ${s.since}` : ''}${s.hours ? ` · ${s.hours} today` : ''}.`,
  },
};

async function remind(kind, { snoozed }) {
  const prefs = await chrome.storage.local.get(PREF_KEYS);
  const enabled = kind === 'checkin' ? prefs.reminder_enabled : prefs.checkout_reminder_enabled;
  if (enabled === false) return;

  // Decide on fresh data, not on whatever the last poll saw.
  await poll();
  const state = await chrome.storage.local.get(['attendance_state', 'hours_today', 'last_check_in', 'poll_status', 'reminded']);
  // Check-in: also remind when the state is unknown (signed out, offline);
  // missing a check-in is the costly mistake.
  const needed = kind === 'checkin'
    ? state.attendance_state !== 'checked_in'
    : state.attendance_state === 'checked_in';
  if (!needed) return;

  // Persisted so a service-worker restart can't cause a second daily reminder.
  const reminded = state.reminded || {};
  const today = dayKey();
  if (!snoozed && reminded[kind] === today) return;
  await chrome.storage.local.set({ reminded: { ...reminded, [kind]: today } });

  const text = REMINDER_TEXT[kind];
  const details = {
    known: !!state.attendance_state,
    hours: formatHours(state.hours_today),
    since: formatClock(parseOdooDatetime(state.last_check_in)),
  };
  chrome.notifications.create(`${kind}:${Date.now()}`, {
    type: 'basic',
    iconUrl: kind === 'checkin' ? 'icons/red_128.png' : 'icons/green_128.png',
    title: snoozed ? text.snoozedTitle : text.title,
    message: text.message(details),
    buttons: [{ title: 'Open Odoo' }, { title: `Snooze ${SNOOZE_MINUTES} min` }],
    priority: 2,
    requireInteraction: true,
  });
}

chrome.notifications.onButtonClicked.addListener((notifId, btnIndex) => {
  const kind = notifId.split(':')[0];
  if (btnIndex === 0) {
    openOdoo();
  } else if (btnIndex === 1 && SNOOZE_ALARMS[kind]) {
    chrome.alarms.create(SNOOZE_ALARMS[kind], { delayInMinutes: SNOOZE_MINUTES });
  }
  chrome.notifications.clear(notifId);
});

chrome.notifications.onClicked.addListener((notifId) => {
  openOdoo();
  chrome.notifications.clear(notifId);
});

async function openOdoo() {
  const [tab] = await chrome.tabs.query({ url: ODOO_TABS_PATTERN });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: ODOO_APP_URL });
  }
}
