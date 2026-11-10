// Minutes of Meeting: JSON schema for the model, validation of what it returns, and exports.

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const SCHEMA = obj({
  title: str,
  summary: str,
  attendees: strs,
  agenda: strs,
  discussion: { type: 'array', items: obj({ topic: str, points: strs }) },
  decisions: strs,
  action_items: { type: 'array', items: obj({ task: str, owner: str, due: str }) },
  next_steps: strs,
});

const PROMPT = (meetingDate) => `You write formal Minutes of Meeting (MOM) in English from a meeting transcript.
The transcript may be English, Hindi or Hinglish (Hindi in Roman letters mixed with English). Lines may be labeled "You" (the person who recorded) or "Others" (everyone else on the call).
The meeting took place on ${meetingDate}. Resolve relative deadlines ("kal tak", "tomorrow", "next Monday") to a calendar date from that day, e.g. "Thu, 6 Nov".
Rules:
- title: short, specific meeting title from the content.
- summary: 2-4 sentences covering purpose and outcome.
- attendees: people named or clearly speaking; use "You" for the recorder. No guesses.
- agenda: topics covered, in order.
- discussion: group key points by topic; concise bullet points, facts only.
- decisions: only things actually agreed.
- action_items: task, owner (empty string if nobody was named), due (empty string if no deadline was said; never invent one).
- next_steps: follow-ups or open questions still pending.
Never invent facts that are not in the transcript. Use empty arrays when a section has nothing.`;

// The model's output is untrusted: keep only the expected shape, as trimmed strings.
const s = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v.map(s).filter(Boolean) : []);
const objs = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

function normalizeMom(raw) {
  const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!m || typeof m !== 'object') throw new Error('Minutes came back in an unexpected format.');
  return {
    title: s(m.title) || 'Meeting',
    summary: s(m.summary),
    attendees: list(m.attendees),
    agenda: list(m.agenda),
    discussion: objs(m.discussion).map((d) => ({ topic: s(d.topic), points: list(d.points) })).filter((d) => d.topic || d.points.length),
    decisions: list(m.decisions),
    action_items: objs(m.action_items).map((a) => ({ task: s(a.task), owner: s(a.owner), due: s(a.due) })).filter((a) => a.task),
    next_steps: list(m.next_steps),
  };
}

const fmtDuration = (sec) => {
  const m = Math.round(sec / 60);
  return m < 60 ? `${Math.max(m, 1)} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

// meta: { date: 'Wed, 5 Nov 2026, 14:00', duration: seconds }
function momToMarkdown(mom, meta) {
  const out = [`# Minutes of Meeting: ${mom.title}`, '', `**Date:** ${meta.date}  `, `**Duration:** ${fmtDuration(meta.duration)}  `];
  if (mom.attendees.length) out.push(`**Attendees:** ${mom.attendees.join(', ')}`);
  const section = (title, items) => items.length && out.push('', `## ${title}`, ...items);
  section('Summary', mom.summary ? [mom.summary] : []);
  section('Agenda', mom.agenda.map((a, i) => `${i + 1}. ${a}`));
  section('Discussion', mom.discussion.flatMap((d) => [`### ${d.topic}`, ...d.points.map((p) => `- ${p}`)]));
  section('Decisions', mom.decisions.map((d) => `- ${d}`));
  section('Action items', mom.action_items.length
    ? ['| # | Task | Owner | Due |', '|---|---|---|---|',
      ...mom.action_items.map((a, i) => `| ${i + 1} | ${a.task.replace(/\|/g, '\\|')} | ${a.owner || '-'} | ${a.due || '-'} |`)]
    : []);
  section('Next steps', mom.next_steps.map((n) => `- ${n}`));
  return `${out.join('\n')}\n`;
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Standalone HTML document for PDF export and rich-text copy (all content escaped).
function momToHtml(mom, meta) {
  const ul = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  const sec = (title, body) => (body ? `<h2>${title}</h2>${body}` : '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(mom.title)}</title><style>
body{font:11pt -apple-system,system-ui,sans-serif;color:#1f2330;margin:40px 48px;line-height:1.5}
h1{font-size:20pt;margin:0 0 4px}.kicker{color:#6b4eff;font-weight:600;letter-spacing:.08em;font-size:9pt;text-transform:uppercase}
.meta{color:#555;margin:6px 0 18px}.meta b{color:#1f2330}h2{font-size:12.5pt;margin:22px 0 6px;padding-bottom:4px;border-bottom:2px solid #ece9ff}
h3{font-size:11pt;margin:12px 0 2px}ul,ol{margin:4px 0;padding-left:20px}.summary{background:#f6f5ff;border-left:4px solid #6b4eff;padding:10px 14px;border-radius:6px}
table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f3f7}
</style></head><body>
<div class="kicker">Minutes of Meeting</div><h1>${esc(mom.title)}</h1>
<div class="meta"><b>Date:</b> ${esc(meta.date)} &nbsp;·&nbsp; <b>Duration:</b> ${esc(fmtDuration(meta.duration))}${mom.attendees.length ? ` &nbsp;·&nbsp; <b>Attendees:</b> ${esc(mom.attendees.join(', '))}` : ''}</div>
${sec('Summary', mom.summary && `<div class="summary">${esc(mom.summary)}</div>`)}
${sec('Agenda', mom.agenda.length && `<ol>${mom.agenda.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>`)}
${sec('Discussion', mom.discussion.length && mom.discussion.map((d) => `<h3>${esc(d.topic)}</h3>${ul(d.points)}`).join(''))}
${sec('Decisions', mom.decisions.length && ul(mom.decisions))}
${sec('Action items', mom.action_items.length && `<table><tr><th>#</th><th>Task</th><th>Owner</th><th>Due</th></tr>${mom.action_items.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.task)}</td><td>${esc(a.owner || '-')}</td><td>${esc(a.due || '-')}</td></tr>`).join('')}</table>`)}
${sec('Next steps', mom.next_steps.length && ul(mom.next_steps))}
</body></html>`;
}

module.exports = { SCHEMA, PROMPT, normalizeMom, momToMarkdown, momToHtml, fmtDuration };
