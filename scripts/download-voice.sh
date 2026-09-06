#!/usr/bin/env bash
# Download default Piper voice (local files, HuggingFace). ~60MB.
set -u
cd "$(dirname "$0")/.."
mkdir -p voices
VOICE="${ZAP_PIPER_VOICE:-./voices/en_US-lessac-medium.onnx}"
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
if [ -f "$VOICE" ]; then echo "voice exists: $VOICE"; exit 0; fi
echo "downloading piper voice → $VOICE"
curl -sfL -o "$VOICE" "$BASE_URL/en_US-lessac-medium.onnx" && \
curl -sfL -o "$VOICE.json" "$BASE_URL/en_US-lessac-medium.onnx.json" && \
echo "voice ready: $VOICE" || {
  echo "WARN: voice download failed (offline?) — espeak fallback will be used."
  exit 1
}
