// Duplex turn pipeline: utterance PCM → STT → memory recall → LLM stream → TTS.
// Sentence-incremental TTS keeps first-audio latency low; AbortSignal gives barge-in.
import { config } from "../config.ts";
import { chatStream, type ChatMessage } from "../ollama.ts";
import { buildMemoryContext, type MemoryHit, type VerbatimMemory } from "../memory/mempalace.ts";
import { transcribePcm16 } from "../stt/provider.ts";
import { synthSentence } from "../tts/piper.ts";

export type TurnEvents = {
  onSttFinal?: (text: string) => void;
  onMemory?: (hits: MemoryHit[]) => void;
  onLlmToken?: (token: string) => void;
  onTtsSentence?: (sentence: string, index: number) => void;
  onTtsAudio?: (pcmBase64: string, sampleRate: number, index: number) => void;
};

export type TurnDeps = {
  memory: VerbatimMemory;
  history: ChatMessage[];
  transcribe?: typeof transcribePcm16;
  synth?: typeof synthSentence;
  chat?: typeof chatStream;
};

/** Split streaming text into speakable sentences (keeps remainder buffered by caller). */
export function splitIntoSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  // Match up to sentence-ending punctuation, keeping abbreviations short-circuit simple.
  const re = /[^.!?…\n]+[.!?…]+["”')\]]*\s*/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s.length >= 3) {
      sentences.push(s);
      lastEnd = m.index + m[0].length;
    }
  }
  return { sentences, remainder: text.slice(lastEnd) };
}

/** Strip markdown/code/URLs so TTS doesn't read them aloud. */
export function sanitizeForSpeech(text: string): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, " code snippet ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[[^\]]*\]\(([^)]*)\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " link ")
      // remove most emoji
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
      .replace(/[*_#>|~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("turn cancelled (barge-in)", "AbortError");
}

/** Full voice turn from raw mic PCM. Returns assistant text. */
export async function runVoiceTurn(
  pcm: Int16Array,
  deps: TurnDeps,
  events: TurnEvents = {},
  signal?: AbortSignal,
): Promise<{ userText: string; assistantText: string; memoryHits: MemoryHit[] }> {
  const transcribe = deps.transcribe ?? transcribePcm16;
  const userText = (await transcribe(pcm, config.sampleRate, signal)).trim();
  throwIfAborted(signal);
  if (!userText) return { userText: "", assistantText: "", memoryHits: [] };
  events.onSttFinal?.(userText);
  const out = await runTextTurn(userText, deps, events, signal);
  return { userText, ...out };
}

/** Text turn (typed fallback or already-transcribed): memory → LLM → TTS. */
export async function runTextTurn(
  userText: string,
  deps: TurnDeps,
  events: TurnEvents = {},
  signal?: AbortSignal,
): Promise<{ assistantText: string; memoryHits: MemoryHit[] }> {
  const synth = deps.synth ?? synthSentence;
  const chat = deps.chat ?? chatStream;
  throwIfAborted(signal);

  const memoryHits = await deps.memory.recall(userText).catch(() => [] as MemoryHit[]);
  throwIfAborted(signal);
  events.onMemory?.(memoryHits);

  const context = buildMemoryContext(memoryHits);
  const messages: ChatMessage[] = [
    { role: "system", content: config.systemPrompt + (context ? `\n\n${context}` : "") },
    ...deps.history.slice(-12),
    { role: "user", content: userText },
  ];

  let full = "";
  let pending = "";
  let sentenceIndex = 0;
  const ttsQueue: Promise<void>[] = [];

  const speak = (sentence: string) => {
    const idx = sentenceIndex++;
    const clean = sanitizeForSpeech(sentence);
    if (!clean) return;
    events.onTtsSentence?.(clean, idx);
    // Don't await: synthesize concurrently, but check abort before emitting audio.
    const job = synth(clean, signal)
      .then((audio) => {
        throwIfAborted(signal);
        events.onTtsAudio?.(audio.pcm.toString("base64"), audio.sampleRate, idx);
      })
      .catch((e) => {
        if ((e as Error)?.name === "AbortError") return;
        console.error(`[tts] sentence ${idx} failed:`, (e as Error)?.message);
      });
    ttsQueue.push(job);
  };

  full = await chat(
    messages,
    (token) => {
      if (signal?.aborted) return;
      events.onLlmToken?.(token);
      pending += token;
      const { sentences, remainder } = splitIntoSentences(pending);
      pending = remainder;
      for (const s of sentences) speak(s);
      // Long unpunctuated ramble: flush every ~220 chars at a word boundary.
      if (pending.length > 240) {
        const cut = pending.lastIndexOf(" ", 200);
        if (cut > 40) {
          speak(pending.slice(0, cut));
          pending = pending.slice(cut);
        }
      }
    },
    signal,
  );
  throwIfAborted(signal);

  const tail = pending.trim();
  if (tail) speak(tail);

  await Promise.all(ttsQueue);
  throwIfAborted(signal);

  // Commit verbatim to local memory (MemPalace philosophy: no summarization).
  try {
    deps.memory.store("user", userText);
    if (full.trim()) deps.memory.store("assistant", full.trim());
  } catch {
    /* memory must never break a turn */
  }
  deps.history.push({ role: "user", content: userText }, { role: "assistant", content: full });

  return { assistantText: full, memoryHits };
}
