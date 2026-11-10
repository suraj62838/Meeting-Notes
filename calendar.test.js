const assert = require('node:assert');
const { currentEvent, parse } = require('./calendar');

const cal = parse(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:standup
DTSTART:20261102T090000Z
DTEND:20261102T091500Z
RRULE:FREQ=DAILY;COUNT=10
SUMMARY:Daily standup
END:VEVENT
BEGIN:VEVENT
UID:review
DTSTART:20261105T140000Z
DTEND:20261105T150000Z
SUMMARY:Design review
END:VEVENT
BEGIN:VEVENT
UID:holiday
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106
SUMMARY:Office closed
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART:20261106T140000Z
DTEND:20261106T150000Z
STATUS:CANCELLED
SUMMARY:Cancelled sync
END:VEVENT
END:VCALENDAR`);

const at = (iso) => currentEvent(cal, new Date(iso))?.title ?? null;

assert.equal(at('2026-11-04T09:05:00Z'), 'Daily standup');   // recurring instance, 3rd day
assert.equal(at('2026-11-04T08:57:00Z'), 'Daily standup');   // early join
assert.equal(at('2026-11-04T08:50:00Z'), null);              // too early
assert.equal(at('2026-11-04T09:20:00Z'), null);              // over
assert.equal(at('2026-11-05T14:30:00Z'), 'Design review');   // one-off; all-day event ignored
assert.equal(at('2026-11-06T14:30:00Z'), null);              // cancelled
assert.equal(at('2026-11-20T09:05:00Z'), null);              // past COUNT
console.log('calendar matching ok');
