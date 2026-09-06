#!/usr/bin/env bash
# Zap setup: everything local. Installs Ollama models, STT sidecar deps,
# Piper TTS + voice, and (optionally) the real MemPalace package.
set -u
cd "$(dirname "$0")/.."

LLM="${ZAP_LLM_MODEL:-qwen2.5:0.5b}"
EMBED="${ZAP_EMBED_MODEL:-nomic-embed-text}"
STT_MODEL="${ZAP_STT_MODEL:-tiny}"

echo "== Zap setup (local only) =="

command -v bun >/dev/null || { echo "ERROR: bun not found (https://bun.sh)"; exit 1; }
echo "--- bun deps ---"
bun install

echo "--- ollama ---"
if ! command -v ollama >/dev/null; then
  echo "ERROR: ollama not found (https://ollama.com/download). Install it, then re-run."
  exit 1
fi
if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "starting 'ollama serve' in background…"
  (ollama serve > /tmp/ollama.log 2>&1 &) 
  sleep 3
fi
echo "pulling chat model: $LLM"
ollama pull "$LLM" || echo "WARN: could not pull $LLM (low disk/RAM?) — set ZAP_LLM_MODEL to a pulled model."
echo "pulling embedding model: $EMBED (optional, memory falls back to keywords without it)"
ollama pull "$EMBED" || echo "WARN: embedding model missing — keyword memory fallback will be used."

echo "--- STT sidecar (faster-whisper) ---"
if python3 -c "import faster_whisper" 2>/dev/null; then
  echo "faster-whisper already installed"
else
  pip3 install --break-system-packages -q "faster-whisper>=1.0.0" 2>&1 | tail -2 || \
  pip3 install -q "faster-whisper>=1.0.0" 2>&1 | tail -2 || \
  echo "WARN: faster-whisper install failed — STT sidecar unavailable (text chat still works)."
fi

echo "--- Piper TTS ---"
if command -v piper >/dev/null; then
  echo "piper already installed: $(command -v piper)"
else
  pip3 install --break-system-packages -q "piper-tts>=1.2.0" 2>&1 | tail -2 || \
  pip3 install -q "piper-tts>=1.2.0" 2>&1 | tail -2 || true
  if ! command -v piper >/dev/null && [ -x "$HOME/.local/bin/piper" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
  if command -v piper >/dev/null; then echo "piper installed via pip"; else
    echo "WARN: piper not installed — will try GitHub release binary…"
    ./scripts/download-piper.sh || echo "WARN: no piper; espeak fallback will be used for TTS."
  fi
fi
./scripts/download-voice.sh || true

echo "--- MemPalace (optional; built-in memory works without it) ---"
python3 -c "import mempalace" 2>/dev/null && echo "mempalace already installed" || \
  (pip3 install --break-system-packages -q mempalace 2>&1 | tail -1 || pip3 install -q mempalace 2>&1 | tail -1 || \
   echo "SKIP: mempalace not installed — built-in verbatim memory will be used.")

echo
echo "== done. Next: =="
echo "  1) bun run stt          # terminal 1: local STT (tiny whisper)"
echo "  2) bun run dev          # terminal 2: Zap on http://localhost:3000"
echo "  3) open the page, allow mic, talk (you can interrupt Zap mid-sentence)"
