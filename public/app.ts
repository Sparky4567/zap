// Zap frontend: mic capture (16k PCM16) + client VAD + barge-in + TTS playback.
// All audio stays on localhost (Bun server); no cloud calls.
const $ = (id: string) => document.getElementById(id)!;
const logEl = $("log"), statusEl = $("status"), statusText = $("statusText"),
  micBtn = $("micBtn") as HTMLButtonElement, stopBtn = $("stopBtn") as HTMLButtonElement,
  handsfree = $("handsfree") as HTMLInputElement, backendEl = $("backend"),
  memEl = $("memHits"), textIn = $("textIn") as HTMLInputElement,
  sendBtn = $("sendBtn") as HTMLButtonElement,
  viz = $("viz") as HTMLCanvasElement;
const vctx = viz.getContext("2d")!;

let ws: WebSocket | null = null;
let aiSpeaking = false;
let micLive = false;
let stream: MediaStream | null = null;
let capCtx: AudioContext | null = null;
let playCtx: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;

// ---- utterance / VAD state ----
let utterActive = false;
let silenceMs = 0;
let speechMs = 0;
let pendingChunks: string[] = []; // base64, kept for re-send after barge-in
const FRAME_MS = 100;             // worklet posts ~100ms frames
const START_THR = 0.022;          // RMS to start utterance
const STOP_SILENCE_MS = 850;      // silence to end utterance
const MIN_SPEECH_MS = 280;
let lastFrameAt = 0;

function log(who: string, text: string, cls = "") {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.innerHTML = `<div class="who"></div><div class="body"></div>`;
  d.querySelector(".who")!.textContent = who;
  d.querySelector(".body")!.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
  return d;
}
let streamingAiDiv: HTMLDivElement | null = null;

function setStatus(mode: string, text: string) {
  statusEl.className = mode;
  statusText.textContent = text;
  stopBtn.disabled = !aiSpeaking;
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => setStatus(aiSpeaking ? "speaking" : "live", "connected · local only");
  ws.onclose = () => {
    setStatus("", "reconnecting…");
    setTimeout(connect, 2000);
  };
  ws.onerror = () => { try { ws?.close(); } catch { /* noop */ } };
  ws.onmessage = (ev) => {
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case "ready":
        backendEl.textContent =
          `llm ${m.llmModel}${m.llmAvailable ? "" : " (missing — run scripts/setup.sh)"} · ` +
          `stt ${m.stt} · tts ${m.tts} · mem ${m.memory}`;
        if (!m.ollama) log("system", "Ollama not reachable at :11434 — run `ollama serve`.", "sys");
        break;
      case "stt-final": log("you 🎙", String(m.text), "user"); break;
      case "memory": {
        const hits = (m.hits ?? []) as { content: string; score: number }[];
        memEl.innerHTML = hits.length
          ? hits.map((h) => `<div>· ${escapeHtml(h.content.slice(0, 160))}</div>`).join("")
          : "<span>none</span>";
        break;
      }
      case "llm-token":
        if (!streamingAiDiv) {
          streamingAiDiv = log("zap ⚡", "", "ai");
          setStatus("speaking", "Zap is answering… (talk to interrupt)");
        }
        streamingAiDiv.querySelector(".body")!.textContent += String(m.token);
        logEl.scrollTop = logEl.scrollHeight;
        break;
      case "llm-done":
        if (streamingAiDiv && !(streamingAiDiv.querySelector(".body")!.textContent || "").trim())
          streamingAiDiv.querySelector(".body")!.textContent = String(m.text ?? "");
        streamingAiDiv = null;
        break;
      case "tts-sentence": break;
      case "tts-chunk": queueAudio(String(m.pcm), Number(m.sampleRate) || 22050); break;
      case "tts-end":
        if (!streamingAiDiv) setStatus("live", "listening…");
        break;
      case "turn-end":
        aiSpeaking = false;
        setStatus("live", micLive ? "listening…" : "connected · local only");
        streamingAiDiv = null;
        break;
      case "interrupted":
        aiSpeaking = false;
        stopPlayback();
        streamingAiDiv = null;
        setStatus("live", "interrupted — listening…");
        break;
      case "error": log("system", String(m.message), "sys"); aiSpeaking = false; break;
    }
  };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ---------- playback ----------
type Queued = { buf: AudioBuffer; idx: number };
let playQueue: Queued[] = [];
let currentSrc: AudioBufferSourceNode | null = null;

function ensurePlayCtx() {
  if (!playCtx) playCtx = new AudioContext();
  if (playCtx.state === "suspended") void playCtx.resume();
}

function b64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i]! / 32768;
  return out;
}

function queueAudio(b64: string, sampleRate: number) {
  ensurePlayCtx();
  const f32 = b64ToF32(b64);
  const buf = playCtx!.createBuffer(1, f32.length, sampleRate);
  buf.copyToChannel(f32, 0);
  playQueue.push({ buf, idx: 0 });
  aiSpeaking = true;
  setStatus("speaking", "Zap is speaking… (talk to interrupt)");
  if (!currentSrc) playNext();
}

function playNext() {
  if (!playQueue.length) {
    currentSrc = null;
    return;
  }
  const { buf } = playQueue.shift()!;
  const src = playCtx!.createBufferSource();
  src.buffer = buf;
  src.connect(playCtx!.destination);
  currentSrc = src;
  src.onended = () => {
    if (currentSrc === src) playNext();
  };
  src.start();
}

function stopPlayback() {
  playQueue = [];
  try { currentSrc?.stop(); } catch { /* noop */ }
  currentSrc = null;
}

// ---------- capture + VAD ----------
const WORKLET = `
class ZapCap extends AudioWorkletProcessor {
  constructor() { super(); this._acc = []; this._accLen = 0; this._inRate = sampleRate; }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const target = 16000;
    const ratio = this._inRate / target;
    // downsample by averaging
    let pos = 0;
    const out = [];
    let sum = 0, n = 0, need = ratio;
    for (let i = 0; i < ch.length; i++) {
      sum += ch[i]; n++;
      if (n >= need) {
        out.push(sum / n);
        sum = 0; n = 0;
        pos += need;
        need = ratio - (pos % 1);
      }
    }
    if (out.length) {
      const pcm = new Int16Array(out.length);
      let e = 0;
      for (let i = 0; i < out.length; i++) {
        const s = Math.max(-1, Math.min(1, out[i]));
        pcm[i] = Math.round(s * 32767);
        e += s * s;
      }
      const rms = Math.sqrt(e / out.length);
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('zap-cap', ZapCap);
`;

async function startMic() {
  if (micLive) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    log("system", "Mic denied/unavailable. You can still type below.", "sys");
    return;
  }
  capCtx = new AudioContext();
  await capCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
  const src = capCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(capCtx, "zap-cap");
  workletNode.port.onmessage = (ev) => {
    const { pcm, rms } = ev.data as { pcm: ArrayBuffer; rms: number };
    drawViz(rms);
    if (!handsfree.checked && !pttHeld) return; // push-to-talk gating
    vadFrame(pcm, rms);
  };
  src.connect(workletNode);
  micLive = true;
  micBtn.textContent = "🎙 Mic live — click to stop";
  micBtn.classList.add("live");
  setStatus("live", "listening…");
  log("system", "Mic live. Speak, or hold SPACE for push-to-talk.", "sys");
}

function stopMic() {
  micLive = false;
  utterActive = false;
  pendingChunks = [];
  try { workletNode?.disconnect(); } catch { /* noop */ }
  try { capCtx?.close(); } catch { /* noop */ }
  stream?.getTracks().forEach((t) => t.stop());
  workletNode = null; capCtx = null; stream = null;
  micBtn.textContent = "🎙 Start mic";
  micBtn.classList.remove("live");
  setStatus("", "mic off");
}

function vadFrame(pcmBuf: ArrayBuffer, rms: number) {
  const now = performance.now();
  const dt = Math.min(500, now - (lastFrameAt || now) || FRAME_MS);
  lastFrameAt = now;
  // Raise threshold while AI speaks to avoid speaker feedback triggering barge-in.
  const thr = aiSpeaking ? START_THR * 1.9 : START_THR;
  const b64 = arrayBufferToB64(pcmBuf);

  if (!utterActive) {
    if (rms > thr) {
      speechMs += dt;
      if (speechMs >= 120) {
        utterActive = true;
        silenceMs = 0;
        pendingChunks = [b64];
        ws?.send(JSON.stringify({ type: "start" }));
        ws?.send(JSON.stringify({ type: "audio", pcm: b64 }));
        if (aiSpeaking) {
          // BARGE-IN: stop local playback, abort server turn, re-send prefix so nothing is lost.
          ws?.send(JSON.stringify({ type: "barge-in" }));
          stopPlayback();
          aiSpeaking = false;
          streamingAiDiv = null;
          setStatus("live", "you took the floor…");
          ws?.send(JSON.stringify({ type: "start" }));
          for (const c of pendingChunks) ws?.send(JSON.stringify({ type: "audio", pcm: c }));
        }
      }
    } else {
      speechMs = 0;
    }
    return;
  }
  // utterance active
  pendingChunks.push(b64);
  ws?.send(JSON.stringify({ type: "audio", pcm: b64 }));
  if (rms > thr * 0.7) silenceMs = 0;
  else {
    silenceMs += dt;
    if (silenceMs >= STOP_SILENCE_MS) {
      const dur = pendingChunks.length * FRAME_MS;
      utterActive = false;
      speechMs = 0;
      silenceMs = 0;
      pendingChunks = [];
      if (dur >= MIN_SPEECH_MS) ws?.send(JSON.stringify({ type: "utterance-end" }));
    }
  }
}

function arrayBufferToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}

function drawViz(rms: number) {
  const w = viz.width, h = viz.height;
  vctx.fillStyle = "#0d1117";
  vctx.fillRect(0, 0, w, h);
  const level = Math.min(1, rms * 12);
  const bw = Math.max(2, level * w);
  vctx.fillStyle = utterActive ? "#3fb950" : aiSpeaking ? "#58a6ff" : "#30363d";
  vctx.fillRect(0, h / 2 - 8, bw, 16);
}

// ---------- UI wiring ----------
micBtn.onclick = () => (micLive ? stopMic() : void startMic());
stopBtn.onclick = () => {
  ws?.send(JSON.stringify({ type: "stop" }));
  stopPlayback();
  aiSpeaking = false;
  streamingAiDiv = null;
  setStatus("live", "interrupted — listening…");
};

function sendText() {
  const t = textIn.value.trim();
  if (!t || !ws || ws.readyState !== WebSocket.OPEN) return;
  log("you ✏️", t, "user");
  textIn.value = "";
  streamingAiDiv = null;
  ws.send(JSON.stringify({ type: "text", text: t }));
}
sendBtn.onclick = sendText;
textIn.onkeydown = (e) => { if (e.key === "Enter") sendText(); };

// push-to-talk on space (outside text field)
let pttHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== textIn && micLive && !pttHeld && !e.repeat) {
    pttHeld = true;
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && pttHeld) {
    pttHeld = false;
    if (utterActive) {
      utterActive = false;
      speechMs = 0; silenceMs = 0; pendingChunks = [];
      ws?.send(JSON.stringify({ type: "utterance-end" }));
    }
    e.preventDefault();
  }
});

connect();
log("zap ⚡", "Hey — I'm Zap, running fully offline on this machine. Turn on the mic and talk, or type below.", "ai");
