// Only open links on known meeting hosts: the URL is handed to the OS, so arbitrary
// schemes/hosts (file:, custom app handlers, phishing pages) must never get through.
const PLATFORMS = [
  { name: 'Zoom', host: /(^|\.)zoom\.us$/, id: (u) => u.pathname.match(/\/(?:j|wc\/join|my)\/([\w.-]+)/)?.[1] },
  { name: 'Google Meet', host: /^meet\.google\.com$/, id: (u) => u.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] },
  { name: 'Teams', host: /^teams\.(microsoft|live)\.com$/, id: () => null },
];

function parseMeetingLink(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Paste a meeting link first.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`; // invites often show "meet.google.com/..."
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That does not look like a link.');
  }
  if (url.protocol !== 'https:') throw new Error('Meeting links must start with https://');
  const p = PLATFORMS.find((x) => x.host.test(url.hostname));
  if (!p) throw new Error('Only Zoom, Google Meet and Microsoft Teams links are supported.');
  const id = p.id(url);
  return { url: url.href, platform: p.name, title: id ? `${p.name} ${id}` : `${p.name} meeting` };
}

module.exports = { parseMeetingLink };
