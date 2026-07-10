// Shared helpers for the offline render tests: 16-bit mono WAV writer and
// simple signal metrics.

export function toWav(samples, sampleRate) {
  const data = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    data[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
  }
  const bytes = data.length * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(bytes, 40);
  Buffer.from(data.buffer).copy(buffer, 44);
  return buffer;
}

export function stats(buf) {
  let peak = 0;
  let hasNaN = false;
  for (const v of buf) {
    if (Number.isNaN(v)) hasNaN = true;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return { peak, hasNaN };
}

export function rms(buf, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / (to - from));
}
