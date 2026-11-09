/**
 * The smallest WAV reader that can police what the broadcast extension sends.
 *
 * The extension converts the microphone to 16 kHz mono PCM16 and wraps it in a
 * container itself, because a broadcast extension has no encoder worth carrying.
 * That means the server cannot assume the bytes are well formed: this reads the
 * RIFF chunks, checks the sample format it can actually forward, and reports the
 * duration so the log and the reply can say how much audio one chunk was.
 */

function ascii(buffer, start, end) {
  return buffer.toString('ascii', start, end);
}

export function readWav(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buffer.length < 44) return null;
  if (ascii(buffer, 0, 4) !== 'RIFF' || ascii(buffer, 8, 12) !== 'WAVE') return null;

  let format = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = ascii(buffer, offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.length) return null;
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // A fmt chunk after the data is not something any writer does; refusing is
      // better than transcribing bytes whose layout is unknown.
      if (!format) return null;
      const available = Math.min(size, buffer.length - body);
      if (available <= 0) return null;
      // PCM only: the transcription route takes a container it can decode, and a
      // compressed payload in a WAV shell is not one of them.
      if (format.audioFormat !== 1) return null;
      if (format.bitsPerSample !== 16) return null;
      if (format.channels < 1 || format.channels > 2) return null;
      if (format.sampleRate < 8000 || format.sampleRate > 48000) return null;
      const frames = available / (format.channels * 2);
      return {
        channels: format.channels,
        sampleRate: format.sampleRate,
        bitsPerSample: format.bitsPerSample,
        dataBytes: available,
        seconds: frames / format.sampleRate,
      };
    }
    offset = body + size + (size % 2);
  }
  return null;
}
