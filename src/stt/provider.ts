// STT provider: faster-whisper sidecar → whisper.cpp → unavailable.
// Audio arrives as 16kHz PCM16 mono; we wrap it as WAV for the HTTP APIs.
import { config } from "../config.ts";
import { encodeWavPcm16 } from "../voice/audio.ts";

export class STTUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "STTUnavailableError";
  }
}

export async function detectSTT(): Promise<"sidecar" | "whisper.cpp" | "unavailable"> {
  try {
    const r = await fetch(`${config.sttUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return "sidecar";
  } catch {
    /* no sidecar */
  }
  try {
    // whisper.cpp server exposes /health or responds to GET /
    const r = await fetch(`${config.whisperCppUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) return "whisper.cpp";
  } catch {
    /* no whisper.cpp */
  }
  return "unavailable";
}

/** Transcribe 16kHz PCM16 mono samples. */
export async function transcribePcm16(pcm: Int16Array, sampleRate = 16000, signal?: AbortSignal): Promise<string> {
  const wav = encodeWavPcm16(pcm, sampleRate);
  return transcribeWav(wav, signal);
}

export async function transcribeWav(wav: Buffer, signal?: AbortSignal): Promise<string> {
  // 1) faster-whisper sidecar (sidecar/stt_server.py)
  try {
    const res = await fetch(`${config.sttUrl}/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal,
    });
    if (res.ok) {
      const j = (await res.json()) as { text?: string };
      return (j.text ?? "").trim();
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
  }
  // 2) whisper.cpp server (POST /inference with wav bytes)
  try {
    const res = await fetch(`${config.whisperCppUrl}/inference`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(wav),
      signal,
    });
    if (res.ok) {
      const j = (await res.json()) as { text?: string };
      if (typeof j.text === "string") return j.text.trim();
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
  }
  throw new STTUnavailableError(
    "No local STT backend reachable. Start the sidecar: `bun run stt` (needs faster-whisper, see scripts/setup.sh), " +
      "or run whisper.cpp server on :8080. Text chat still works.",
  );
}
