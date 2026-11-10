const assert = require('node:assert');
const { isMeetingApp } = require('./meeting');

for (const b of ['us.zoom.xos', 'com.microsoft.teams2', 'com.google.Chrome.helper', 'com.tinyspeck.slackmacgap', 'com.apple.FaceTime', 'com.apple.WebKit.GPU', 'pid:123'])
  assert.ok(isMeetingApp(b), b);
for (const b of ['com.github.Electron.helper', 'com.apple.corespeechd', 'com.apple.controlcenter'])
  assert.ok(!isMeetingApp(b), b);
console.log('meeting filter ok');
