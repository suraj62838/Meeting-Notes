const assert = require('node:assert');
const { parseMeetingLink: p } = require('./meeting-link');

assert.deepEqual(p(' https://us06web.zoom.us/j/81234567890?pwd=abc '), {
  url: 'https://us06web.zoom.us/j/81234567890?pwd=abc', platform: 'Zoom', title: 'Zoom 81234567890',
});
assert.equal(p('https://zoom.us/j/123').title, 'Zoom 123');
assert.equal(p('meet.google.com/abc-defg-hij').url, 'https://meet.google.com/abc-defg-hij'); // no scheme
assert.throws(() => p('  '), /Paste a meeting link/);
assert.equal(p('https://meet.google.com/abc-defg-hij?authuser=0').title, 'Google Meet abc-defg-hij');
assert.equal(p('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0').title, 'Teams meeting');
assert.equal(p('https://teams.live.com/meet/9876').platform, 'Teams');

for (const bad of ['http://zoom.us/j/1', 'file:///etc/passwd', 'zoommtg://zoom.us/join', 'https://zoom.us.evil.com/j/1',
  'https://evilzoom.us/j/1', 'https://example.com', 'not a link'])
  assert.throws(() => p(bad), undefined, bad);
console.log('meeting links ok');
