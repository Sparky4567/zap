// Central config — everything local-only, overridable via env / .env (Bun autoloads .env).
export const config = {
  port: Number(process.env.PORT ?? process.env.ZAP_PORT ?? 3000),
  ollamaUrl: (process.env.OLLAMA_URL ?? "http://localhost:11434").replace(/\/$/, ""),
  llmModel: process.env.ZAP_LLM_MODEL ?? "qwen2.5:0.5b",
  embedModel: process.env.ZAP_EMBED_MODEL ?? "nomic-embed-text",
  systemPrompt:
    process.env.ZAP_SYSTEM_PROMPT ??
    "You are Zap, a friendly local AI companion. Reply briefly for voice (1-3 sentences unless asked for more). Be warm, direct, and helpful.",
  // STT: faster-whisper sidecar first, then whisper.cpp server, then fail w/ helpful error.
  sttUrl: (process.env.ZAP_STT_URL ?? "http://localhost:8091").replace(/\/$/, ""),
  whisperCppUrl: (process.env.ZAP_WHISPER_CPP_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  // TTS: Piper preferred, espeak fallback (preinstalled on Debian).
  piperBin: process.env.ZAP_PIPER_BIN ?? "piper",
  piperVoice: process.env.ZAP_PIPER_VOICE ?? "./voices/en_US-lessac-medium.onnx",
  espeakBin: process.env.ZAP_ESPEAK_BIN ?? "espeak",
  // Memory (built-in verbatim store, MemPalace-style). Real `mempalace` bridge optional.
  memoryDb: process.env.ZAP_MEMORY_DB ?? "./data/memory.sqlite",
  mempalaceBridgeUrl: (process.env.MEMPALACE_BRIDGE_URL ?? "").replace(/\/$/, ""),
  memoryTopK: Number(process.env.ZAP_MEMORY_TOP_K ?? 4),
  sampleRate: 16000,
  maxUtteranceSecs: Number(process.env.ZAP_MAX_UTTERANCE_SECS ?? 30),
};

export type HealthStatus = {
  ok: boolean;
  ollama: boolean;
  llmModel: string;
  llmAvailable: boolean;
  embedAvailable: boolean;
  stt: "sidecar" | "whisper.cpp" | "unavailable";
  tts: "piper" | "espeak" | "unavailable";
  memory: "sqlite" | "mempalace-bridge";
};
