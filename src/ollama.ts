// Minimal Ollama client (chat streaming + embeddings). Local-only, no API keys.
import { config } from "./config.ts";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function readNDJSON(res: Response, onLine: (obj: any) => void, signal?: AbortSignal) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) {
      reader.cancel().catch(() => {});
      throw new DOMException("aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* ignore partial */
      }
    }
  }
}

/** Stream chat completion. Resolves with full text; calls onToken per token. */
export async function chatStream(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.llmModel, messages, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`ollama chat failed: ${res.status}`);
  let full = "";
  await readNDJSON(
    res,
    (obj) => {
      const t = obj?.message?.content ?? "";
      if (t) {
        full += t;
        onToken(t);
      }
    },
    signal,
  );
  return full;
}

export async function chatOnce(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  let full = "";
  await chatStream(messages, (t) => (full += t), signal);
  return full;
}

/** Embed texts with Ollama. Tries /api/embed then /api/embeddings. Returns null on failure. */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (!texts.length) return [];
  // New API: /api/embed { model, input: string|string[] }
  try {
    const res = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.embedModel, input: texts }),
    });
    if (res.ok) {
      const j = (await res.json()) as any;
      if (Array.isArray(j.embeddings)) return j.embeddings as number[][];
    }
  } catch {
    /* fall through */
  }
  // Legacy API: /api/embeddings { model, prompt } — one call per text
  try {
    const out: number[][] = [];
    for (const t of texts) {
      const res = await fetch(`${config.ollamaUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: config.embedModel, prompt: t }),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      if (!Array.isArray(j.embedding)) return null;
      out.push(j.embedding);
    }
    return out;
  } catch {
    return null;
  }
}

export async function ollamaHealth(): Promise<{ up: boolean; llm: boolean; embed: boolean }> {
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`);
    if (!res.ok) return { up: false, llm: false, embed: false };
    const j = (await res.json()) as any;
    const names: string[] = (j.models ?? []).map((m: any) => String(m.name ?? m.model ?? ""));
    const has = (want: string) =>
      names.some((n) => n === want || n.startsWith(want + ":") || n.startsWith(want + "-"));
    return { up: true, llm: has(config.llmModel), embed: has(config.embedModel) };
  } catch {
    return { up: false, llm: false, embed: false };
  }
}
