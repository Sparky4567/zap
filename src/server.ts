// Duplex voice server: Bun.serve + WebSocket turn loop + text/memory REST.
// WS protocol (JSON):
//   C→S: {type:'start'} {type:'audio',pcm:b64} {type:'utterance-end'}
//        {type:'text',text} {type:'barge-in'} {type:'stop'}
//   S→C: ready | stt-final | memory | llm-token | llm-done | tts-chunk |
//        tts-end | turn-end | interrupted | error
import index from "../public/index.html";
import { config, type HealthStatus } from "./config.ts";
import { chatStream, ollamaHealth, type ChatMessage } from "./ollama.ts";
import { VerbatimMemory } from "./memory/mempalace.ts";
import { base64ToPcm16 } from "./voice/audio.ts";
import { runTextTurn, runVoiceTurn } from "./voice/pipeline.ts";
import { detectSTT } from "./stt/provider.ts";
import { detectTTS } from "./tts/piper.ts";

const memory = new VerbatimMemory();
void memory.backfillEmbeddings().catch(() => {});

type ConnState = {
  pcm: Int16Array[];
  pcmSamples: number;
  history: ChatMessage[];
  current: AbortController | null;
  speaking: boolean;
};

async function health(): Promise<HealthStatus> {
  const [o, stt, tts] = await Promise.all([ollamaHealth(), detectSTT(), detectTTS()]);
  return {
    ok: o.up,
    ollama: o.up,
    llmModel: config.llmModel,
    llmAvailable: o.llm,
    embedAvailable: o.embed,
    stt,
    tts,
    memory: config.mempalaceBridgeUrl ? "mempalace-bridge" : "sqlite",
  };
}

function send(ws: any, obj: unknown) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* closed */
  }
}

function abortTurn(state: ConnState) {
  state.current?.abort();
  state.current = null;
  state.speaking = false;
}

async function runTurn(
  ws: any,
  state: ConnState,
  kind: { pcm?: Int16Array; text?: string },
) {
  abortTurn(state);
  const ctrl = new AbortController();
  state.current = ctrl;
  const signal = ctrl.signal;
  const events = {
    onSttFinal: (text: string) => send(ws, { type: "stt-final", text }),
    onMemory: (hits: unknown) => send(ws, { type: "memory", hits }),
    onLlmToken: (token: string) => send(ws, { type: "llm-token", token }),
    onTtsSentence: (sentence: string, index: number) => send(ws, { type: "tts-sentence", sentence, index }),
    onTtsAudio: (pcm: string, sampleRate: number, index: number) => {
      state.speaking = true;
      send(ws, { type: "tts-chunk", pcm, sampleRate, index });
    },
  };
  try {
    const deps = { memory, history: state.history };
    const result =
      kind.text !== undefined
        ? { userText: kind.text, ...(await runTextTurn(kind.text, deps, events, signal)) }
        : await runVoiceTurn(kind.pcm!, deps, events, signal);
    if (signal.aborted) return;
    send(ws, { type: "llm-done", text: result.assistantText });
    send(ws, { type: "tts-end" });
    send(ws, { type: "turn-end", userText: result.userText });
    state.speaking = false;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      send(ws, { type: "interrupted" });
    } else {
      console.error("[turn]", e?.message ?? e);
      send(ws, { type: "error", message: String(e?.message ?? e) });
    }
    state.speaking = false;
  } finally {
    if (state.current === ctrl) state.current = null;
  }
}

const server = Bun.serve({
  port: config.port,
  routes: {
    "/": index,
    "/api/health": {
      GET: async () => Response.json(await health()),
    },
    "/api/chat": {
      POST: async (req) => {
        try {
          const body = (await req.json()) as { message?: string };
          const message = String(body.message ?? "").trim();
          if (!message) return Response.json({ error: "empty message" }, { status: 400 });
          const history: ChatMessage[] = [];
          let reply = "";
          const hits = await runTextTurn(
            message,
            { memory, history },
            { onLlmToken: (t) => (reply += t) },
          ).then((r) => {
            reply = r.assistantText;
            return r.memoryHits;
          });
          return Response.json({ reply, memoryHits: hits });
        } catch (e: any) {
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      },
    },
    "/api/memory/search": {
      POST: async (req) => {
        try {
          const body = (await req.json()) as { query?: string; topK?: number };
          const hits = await memory.recall(String(body.query ?? ""), Number(body.topK ?? 5));
          return Response.json({ hits });
        } catch (e: any) {
          return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
        }
      },
    },
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const state: ConnState = { pcm: [], pcmSamples: 0, history: [], current: null, speaking: false };
      if (server.upgrade(req, { data: state })) return;
      return new Response("websocket upgrade failed", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws: any) {
      health()
        .then((h) => send(ws, { type: "ready", ...h }))
        .catch(() => send(ws, { type: "ready", ok: false }));
    },
    async message(ws: any, raw: string | Buffer) {
      const state = ws.data as ConnState;
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      switch (msg.type) {
        case "start":
          state.pcm = [];
          state.pcmSamples = 0;
          break;
        case "audio": {
          if (typeof msg.pcm !== "string") break;
          try {
            const chunk = base64ToPcm16(msg.pcm);
            const maxSamples = config.sampleRate * config.maxUtteranceSecs;
            if (state.pcmSamples + chunk.length > maxSamples) break; // drop overflow
            state.pcm.push(chunk);
            state.pcmSamples += chunk.length;
          } catch {
            /* bad chunk */
          }
          break;
        }
        case "utterance-end": {
          const total = state.pcmSamples;
          if (!total) break;
          const merged = new Int16Array(total);
          let off = 0;
          for (const c of state.pcm) {
            merged.set(c, off);
            off += c.length;
          }
          state.pcm = [];
          state.pcmSamples = 0;
          // Ignore trivially short blips (<250ms) — likely noise, not speech.
          if (merged.length < config.sampleRate / 4) break;
          void runTurn(ws, state, { pcm: merged });
          break;
        }
        case "text": {
          const text = String(msg.text ?? "").trim().slice(0, 2000);
          if (!text) break;
          void runTurn(ws, state, { text });
          break;
        }
        case "barge-in":
        case "stop":
          abortTurn(state);
          state.pcm = [];
          state.pcmSamples = 0;
          send(ws, { type: "interrupted" });
          break;
        default:
          break;
      }
    },
    close(ws: any) {
      try {
        (ws.data as ConnState)?.current?.abort();
      } catch {
        /* noop */
      }
    },
  },
});

console.log(`Zap (local duplex companion) listening on http://localhost:${server.port}`);
console.log(`LLM=${config.llmModel} STT=${config.sttUrl} MEM=${config.mempalaceBridgeUrl || config.memoryDb}`);
