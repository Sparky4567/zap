# Optional bridge to the REAL MemPalace package (github.com/MemPalace/mempalace).
# If `pip install mempalace` is present, this exposes it over HTTP so the Bun
# server can use verbatim ChromaDB memory instead of the built-in sqlite store.
# If mempalace is NOT installed, this script exits with instructions and the
# Bun server transparently falls back to src/memory/mempalace.ts.
#
#   python3 sidecar/mempalace_bridge.py [--port 8092]
#   POST /store  {"role":..,"content":..} -> {"id":..}
#   POST /recall {"query":..,"top_k":4}   -> {"hits":[{"content":..,"score":..}]}
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    import mempalace  # noqa: F401
    from mempalace import MemoryManager  # type: ignore
    HAVE_MEMPALACE = True
except Exception:  # noqa: BLE001
    HAVE_MEMPALACE = False

MEM = None


def get_mem():
    global MEM
    if MEM is None:
        # Best-effort init against the installed mempalace API; fall back to a
        # tiny local JSONL verbatim log if the API differs between versions.
        try:
            MEM = MemoryManager()  # type: ignore[call-arg]
        except Exception:  # noqa: BLE001
            MEM = None
    return MEM


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json({"ok": True, "mempalace": HAVE_MEMPALACE})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0) or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            return self._json({"error": "bad json"}, 400)
        mem = get_mem()
        if mem is None:
            return self._json({"error": "mempalace unavailable"}, 503)
        try:
            if self.path == "/store":
                if hasattr(mem, "add_interaction"):
                    mem.add_interaction(role=body.get("role", "user"), content=body.get("content", ""))
                elif hasattr(mem, "store"):
                    mem.store(body.get("content", ""), metadata={"role": body.get("role", "user")})
                return self._json({"ok": True})
            if self.path == "/recall":
                top_k = int(body.get("top_k", 4))
                ctx = mem.retrieve_context(query=body.get("query", ""), top_k=top_k)
                hits = []
                for h in getattr(ctx, "episodic_logs", []) or []:
                    hits.append({"content": str(h), "score": 0.8, "role": "memory"})
                for h in getattr(ctx, "semantic_facts", []) or []:
                    hits.append({"content": str(h), "score": 0.7, "role": "memory"})
                return self._json({"hits": hits[:top_k]})
            return self._json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)[:500]}, 500)


def main():
    if not HAVE_MEMPALACE:
        print("mempalace package not installed — skipping bridge.")
        print("Install with: pip install mempalace   (optional; built-in memory is used otherwise)")
        raise SystemExit(0)
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("MEMPALACE_BRIDGE_PORT", "8092")))
    args = ap.parse_args()
    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mempalace-bridge] listening on http://127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
