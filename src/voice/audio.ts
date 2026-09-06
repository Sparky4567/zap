// PCM16 / WAV helpers shared by server STT/TTS and tests.
export function encodeWavPcm16(pcm: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

/** Parse a WAV file; returns PCM16 mono + sample rate (resampling NOT done). */
export function parseWav(wav: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    // Assume raw PCM16
    return { pcm: new Int16Array(wav.buffer, wav.byteOffset, Math.floor(wav.length / 2)), sampleRate: 16000 };
  }
  // Walk chunks to find fmt + data (handles JUNK/LIST/extra chunks from tools)
  let pos = 12;
  let sampleRate = 16000;
  let pcm = new Int16Array(0);
  while (pos + 8 <= wav.length) {
    const id = wav.toString("ascii", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      sampleRate = wav.readUInt32LE(body + 4);
    } else if (id === "data") {
      const end = Math.min(wav.length, body + size);
      const n = Math.floor((end - body) / 2);
      const arr = new Int16Array(n);
      for (let i = 0; i < n; i++) arr[i] = wav.readInt16LE(body + i * 2);
      pcm = arr;
      break;
    }
    pos = body + size + (size % 2);
  }
  return { pcm, sampleRate };
}

/** Strip WAV header → raw PCM16 bytes. */
export function wavToPcm16Bytes(wav: Buffer): { bytes: Buffer; sampleRate: number } {
  const { pcm, sampleRate } = parseWav(wav);
  return { bytes: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate };
}

export function pcm16ToBase64(pcm: Int16Array | Buffer): string {
  const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return buf.toString("base64");
}

export function base64ToPcm16(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
}

export function rmsEnergy(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i]! / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / pcm.length);
}
