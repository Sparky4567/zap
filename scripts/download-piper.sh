#!/usr/bin/env bash
# Fallback Piper binary install from GitHub releases (linux x86_64).
set -u
cd "$(dirname "$0")/.."
mkdir -p .bin
VER="${PIPER_VERSION:-2023.11.09}"
URL="https://github.com/rhasspy/piper/releases/download/${VER}/piper_linux_x86_64.tar.gz"
if command -v piper >/dev/null; then echo "piper present"; exit 0; fi
echo "downloading piper $VER…"
curl -sfL -o /tmp/piper.tgz "$URL" || { echo "WARN: piper binary download failed"; exit 1; }
tar xzf /tmp/piper.tgz -C .bin
BIN="$(find .bin -name piper -type f | head -1)"
chmod +x "$BIN" 2>/dev/null || true
echo "piper at $BIN — add to PATH or set ZAP_PIPER_BIN=$BIN"
