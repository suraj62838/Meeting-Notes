// 44-byte header for 16-bit PCM WAV.
function wavHeader(dataBytes, sampleRate = 16000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);            // fmt chunk size
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34);            // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

module.exports = { wavHeader };
