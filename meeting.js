// Ignore our own capture (Electron helper) and always-on system listeners (Siri etc.).
// shortcut: allowlist of Apple apps is hand-picked, add more if a meeting app is missed.
const isMeetingApp = (b) =>
  !/electron|meeting-notes/i.test(b) &&
  (!b.startsWith('com.apple.') || /FaceTime|WebKit|Safari/.test(b));

module.exports = { isMeetingApp };
