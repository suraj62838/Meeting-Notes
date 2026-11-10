const assert = require('node:assert');
const { normalizeMom, momToMarkdown, momToHtml, fmtDuration } = require('./mom');

// untrusted model output: wrong types, blanks and extra fields are dropped
const mom = normalizeMom(JSON.stringify({
  title: ' Launch sync ',
  summary: 'Agreed to ship.',
  attendees: ['You', 'Priya', 42, ''],
  agenda: ['Pricing page'],
  discussion: [{ topic: 'Pricing', points: ['Ship Friday', null] }, { topic: '', points: [] }, 'junk'],
  decisions: ['Ship Friday'],
  action_items: [{ task: 'Send email', owner: 'Priya', due: 'Thu, 6 Nov' }, { task: 'Fix | bug', owner: '', due: '' }, { owner: 'x' }],
  next_steps: [],
  extra: 'ignored',
}));
assert.equal(mom.title, 'Launch sync');
assert.deepEqual(mom.attendees, ['You', 'Priya']);
assert.deepEqual(mom.discussion, [{ topic: 'Pricing', points: ['Ship Friday'] }]);
assert.equal(mom.action_items.length, 2);
assert.equal(mom.extra, undefined);
assert.equal(normalizeMom({}).title, 'Meeting');
assert.throws(() => normalizeMom('not json'));

const meta = { date: 'Wed, 5 Nov 2026, 14:00', duration: 3725 };
const md = momToMarkdown(mom, meta);
assert.match(md, /^# Minutes of Meeting: Launch sync/);
assert.match(md, /\*\*Duration:\*\* 1 h 2 min/);
assert.match(md, /\| 1 \| Send email \| Priya \| Thu, 6 Nov \|/);
assert.match(md, /\| 2 \| Fix \\\| bug \| - \| - \|/); // pipe escaped, blanks shown as "-"
assert.ok(!md.includes('## Next steps')); // empty sections omitted

const html = momToHtml({ ...mom, title: '<script>x</script>' }, meta);
assert.ok(!html.includes('<script>x'));
assert.ok(html.includes('&lt;script&gt;'));
assert.equal(fmtDuration(20), '1 min');
console.log('minutes of meeting ok');
