# Local STT sidecar: faster-whisper over a tiny stdlib HTTP server.
# No cloud, no API keys. Models download once from HuggingFace, then run offline.
#
#   python3 sidecar/stt_server.py [--model tiny] [--port 8091] [--device cpu]
#   POST /transcribe  (body: wav bytes) -> {"text": ...}
#   GET  /health -> {"ok": true, "model": ...}
import argparse
import json
import tempfile
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = None
MODEL_NAME = "tiny"


def get_model():
    global MODEL
    if MODEL is None:
        from faster_whisper import WhisperModel

        device = os.environ.get("ZAP_STT_DEVICE", "cpu")
        compute = os.environ.get("ZAP_STT_COMPUTE", "int8")
        print(f"[stt] loading faster-whisper model {MODEL_NAME} ({device}/{compute}) …", flush=True)
        MODEL = WhisperModel(MODEL_NAME, device=device, compute_type=compute)
        print("[stt] model ready", flush=True)
    return MODEL


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        try:
            body = json.dumps(obj).encode()
        except Exception:
            body = b'{"error": "encode failed"}'
            code = 500
        try:
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
            # Client went away (barge-in abort / timeout). Not a server bug.
            pass

    def do_GET(self):
        if self.path == "/health":
            return self._json({"ok": True, "model": MODEL_NAME, "loaded": MODEL is not None})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/transcribe":
            return self._json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("content-length", 0) or 0)
        except ValueError:
            return self._json({"error": "bad content-length"}, 400)
        if length <= 0 or length > 20 * 1024 * 1024:
            return self._json({"error": "bad audio size"}, 400)
        try:
            wav = self.rfile.read(length)
        except (OSError, ValueError):
            return
        if not wav:
            return self._json({"error": "empty audio"}, 400)
        try:
            model = get_model()
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                f.write(wav)
                path = f.name
            try:
                try:
                    segments, info = model.transcribe(path, beam_size=1, vad_filter=True)
                    text = "".join(s.text for s in segments).strip()
                except Exception as e:
                    # onnxruntime missing -> VAD unavailable; retry without VAD.
                    msg = str(e).lower()
                    if "onnx" in msg or "vad" in msg or "silero" in msg:
                        segments, info = model.transcribe(path, beam_size=1, vad_filter=False)
                        text = "".join(s.text for s in segments).strip()
                    else:
                        raise
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
            try:
                return self._json({"text": text, "language": getattr(info, "language", None)})
            except (OSError, ValueError):
                return
        except (OSError, ValueError):
            # Client aborted mid-transcribe (barge-in). Silence is expected.
            return
        except Exception as e:  # noqa: BLE001
            try:
                return self._json({"error": str(e)[:500]}, 500)
            except (OSError, ValueError):
                return


def main():
    global MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("ZAP_STT_MODEL", "tiny"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("ZAP_STT_PORT", "8091")))
    args = ap.parse_args()
    MODEL_NAME = args.model
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[stt] listening on http://127.0.0.1:{args.port} model={MODEL_NAME}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
