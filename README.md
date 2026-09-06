# ⚡ Zap — local duplex AI companion

Talk with an AI **in real time, fully offline**: speech in → thinking → speech out,
with **barge-in** (interrupt it mid-sentence, it listens while talking) and
**verbatim long-term memory** (MemPalace-style, zero cloud calls).

```
mic ──► VAD ──► STT ──► memory recall ──► Ollama LLM (stream) ──► Piper TTS ──► speaker
              (browser)  (faster-whisper,   (sqlite + Ollama      (sentence-chunked,
               client     local sidecar)     embeddings, or real   local neural voice)
               VAD +                       `mempalace` bridge)
               barge-in)
```

100% local: **Ollama** (LLM + embeddings) · **faster-whisper** (STT) · **Piper**
(TTS, espeak fallback) · **MemPalace** (memory, built-in fallback). No API keys,
no cloud, no telemetry.

## Quickstart

```bash
bun install
bun run setup        # pulls ollama models, installs STT deps, piper + voice
bun run stt          # terminal 1: local STT sidecar :8091 (whisper tiny)
bun run dev          # terminal 2: Zap on http://localhost:3000
```

Open the page → allow mic → talk. Hold `SPACE` for push-to-talk, or just speak
hands-free. **Talk while Zap speaks to interrupt it.** Typing always works, even
with no mic/models.

Low-RAM (2–4 GB)? Defaults already target that: `qwen2.5:0.5b` LLM + `tiny`
whisper + `lessac-medium` Piper voice. Override in `.env` (copy `.env.example`).

## Components

| Piece | Implementation | Notes |
|---|---|---|
| LLM | Ollama `ZAP_LLM_MODEL` (default `qwen2.5:0.5b`) | streams tokens via `/api/chat` |
| STT | `sidecar/stt_server.py` (faster-whisper, `ZAP_STT_MODEL=tiny`) | `bun run stt`; whisper.cpp `:8080` also accepted |
| TTS | Piper `voices/*.onnx` → `espeak` fallback | `scripts/download-voice.sh`; sentence-chunked for low latency |
| Memory | `src/memory/mempalace.ts` (verbatim sqlite + Ollama embeddings, FTS fallback) | optional real backend: `bun run memory-bridge` + `MEMPALACE_BRIDGE_URL` |
| Duplex | WS `/ws` + client VAD + `barge-in`/`stop` abort | one turn per connection; new speech cancels old |

## WS protocol

Client→server: `start` · `audio {pcm:b64 16k PCM16}` · `utterance-end` ·
`text {text}` · `barge-in` / `stop`.
Server→client: `ready` · `stt-final` · `memory {hits}` · `llm-token` · `llm-done` ·
`tts-chunk {pcm,sampleRate,index}` · `tts-end` · `turn-end` · `interrupted` · `error`.

REST: `GET /api/health` · `POST /api/chat {message}` · `POST /api/memory/search {query,topK}`.

## Memory (mempalace)

Philosophy copied from [MemPalace](https://github.com/MemPalace/mempalace):
**store everything verbatim, never summarize; retrieve semantically.**
Built-in store needs nothing but disk; with an Ollama embedding model it does
cosine retrieval, otherwise keyword (FTS5/LIKE) fallback. Set
`MEMPALACE_BRIDGE_URL=http://localhost:8092` + `bun run memory-bridge` to use the
real `mempalace` ChromaDB backend when installed.

## Tests

```bash
bun test
```

Covers sentence splitting/TTS sanitizing, wav roundtrip, memory recall
(keyword + semantic), and full mocked turns incl. barge-in abort.
