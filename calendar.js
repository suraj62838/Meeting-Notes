const ical = require('node-ical');

const EARLY_MS = 5 * 60 * 1000; // people join a few minutes before the scheduled start

const text = (v) => (v && typeof v === 'object' ? v.val : v) || '';

// All timed (not all-day) event instances overlapping [from, to], recurring ones expanded.
function instances(cal, from, to) {
  const out = [];
  for (const e of Object.values(cal)) {
    if (e.type !== 'VEVENT' || e.status === 'CANCELLED') continue;
    const list = e.rrule
      ? ical.expandRecurringEvent(e, { from, to, expandOngoing: true })
      : [{ start: e.start, end: e.end || e.start, summary: e.summary, isFullDay: e.datetype === 'date' }];
    for (const i of list) {
      if (i.isFullDay || i.end < from || i.start > to) continue;
      out.push({ title: text(i.summary) || 'Untitled event', start: new Date(i.start), end: new Date(i.end) });
    }
  }
  return out;
}

// The scheduled meeting happening at `now` (allowing an early join); latest-started wins.
function currentEvent(cal, now = new Date()) {
  const live = instances(cal, new Date(now - 24 * 3600e3), new Date(+now + EARLY_MS))
    .filter((e) => e.start - EARLY_MS <= now && now <= e.end)
    .sort((a, b) => b.start - a.start);
  return live[0] || null;
}

async function fetchCalendar(url) {
  const u = url.trim().replace(/^webcal:/i, 'https:'); // Apple/Outlook share links use webcal://
  if (!/^https?:\/\//i.test(u)) throw new Error('Calendar link must start with https:// or webcal://');
  return ical.async.fromURL(u);
}

module.exports = { currentEvent, fetchCalendar, parse: (s) => ical.sync.parseICS(s) };
