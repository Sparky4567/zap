// Piper TTS (local neural voices) with espeak fallback.
// Each sentence is synthesized to WAV, header stripped → PCM16 mono + sample rate.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.ts";
import { parseWav } from "../voice/audio.ts";

export type TtsAudio = { pcm: Buffer; sampleRate: number };

let piperVoiceCache: string | null | undefined;

export function piperVoicePath(): string | null {
  if (piperVoiceCache !== undefined) return piperVoiceCache;
  const candidates = [
    config.piperVoice,
    "./voices/en_US-lessac-medium.onnx",
    `${process.env.HOME ?? ""}/.local/share/piper/en_US-lessac-medium.onnx`,
  ];
  piperVoiceCache = candidates.find((p) => p && existsSync(p)) ?? null;
  return piperVoiceCache;
}

async function which(bin: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["which", bin], { stdout: "pipe" });
    await p.exited;
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

export async function detectTTS(): Promise<"piper" | "espeak" | "unavailable"> {
  if (piperVoicePath() && (await which(config.piperBin))) return "piper";
  if (await which(config.espeakBin)) return "espeak";
  return "unavailable";
}

function runProc(cmd: string[], stdinText?: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const p = Bun.spawn(cmd, { stdin: stdinText !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    if (stdinText !== undefined && p.stdin) {
      p.stdin.write(stdinText);
      p.stdin.end();
    }
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    (async () => {
      if (p.stdout) for await (const c of p.stdout) chunks.push(Buffer.from(c));
      if (p.stderr) for await (const c of p.stderr) errChunks.push(Buffer.from(c));
      await p.exited;
      resolve({ code: p.exitCode ?? 1, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errChunks).toString() });
    })();
  });
}

export async function synthWithPiper(text: string, signal?: AbortSignal): Promise<TtsAudio> {
  const voice = piperVoicePath();
  if (!voice) throw new Error("piper voice not found");
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  const outFile = join(tmpdir(), `zap-piper-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.wav`);
  const res = await runProc([config.piperBin, "--model", voice, "--output_file", outFile], text);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (res.code !== 0) throw new Error(`piper failed: ${res.stderr.slice(0, 300)}`);
  const wav = Buffer.from(await Bun.file(outFile).arrayBuffer());
  await Bun.file(outFile).unlink().catch(() => {});
  const { pcm, sampleRate } = parseWav(wav);
  return { pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate };
}

export async function synthWithEspeak(text: string, signal?: AbortSignal): Promise<TtsAudio> {
  // espeak --stdout emits a WAV to stdout. Fully local, preinstalled on Debian.
  const res = await runProc([config.espeakBin, "--stdout", "-v", "en", "-s", "175", text.slice(0, 2000)]);
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (res.code !== 0 || res.stdout.length < 100) throw new Error(`espeak failed: ${res.stderr.slice(0, 300)}`);
  const { pcm, sampleRate } = parseWav(res.stdout);
  return { pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), sampleRate };
}

export async function synthSentence(text: string, signal?: AbortSignal): Promise<TtsAudio> {
  const clean = text.trim();
  if (!clean) throw new Error("empty text");
  if (piperVoicePath() && (await which(config.piperBin))) return synthWithPiper(clean, signal);
  if (await which(config.espeakBin)) return synthWithEspeak(clean, signal);
  throw new Error("No local TTS available. Install Piper (scripts/setup.sh) — espeak also missing.");
}
