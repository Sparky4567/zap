// Local-first verbatim memory, MemPalace-style:
// store every turn verbatim, retrieve with semantic (Ollama embeddings + cosine)
// with keyword/FTS fallback so it works even without an embedding model.
// If MEMPALACE_BRIDGE_URL is set, recall/store delegate to the real `mempalace`
// Python package via sidecar/mempalace_bridge.py (verbatim ChromaDB backend).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { embedTexts } from "../ollama.ts";

export type MemoryHit = { id: number; role: string; content: string; score: number; createdAt: string };
export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

/** Tiny stemmer so "hike"/"hiking", "call"/"called" etc. match in keyword fallback. */
export function stemToken(t: string): string[] {
  const out = new Set([t]);
  let m = t.match(/^(.{3,}?)ing$/);
  if (m) {
    out.add(m[1]!);
    out.add(`${m[1]}e`);
  }
  m = t.match(/^(.{3,}?)ed$/);
  if (m) {
    out.add(m[1]!);
    out.add(`${m[1]}e`);
  }
  m = t.match(/^(.{3,}?)s$/);
  if (m) out.add(m[1]!);
  return [...out].filter((s) => s.length > 2);
}

export function stemText(text: string): string {
  const toks = text.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2);
  return [...new Set(toks.flatMap(stemToken))].join(" ");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class VerbatimMemory {
  private db: Database;
  private embedFn: EmbedFn;

  constructor(dbPath: string = config.memoryDb, embedFn: EmbedFn = embedTexts) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        embedding BLOB,
        stems TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, stems);
    `);
    // Migrate DBs created before the stems column existed.
    try {
      this.db.exec(`ALTER TABLE memories ADD COLUMN stems TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already there */
    }
    this.embedFn = embedFn;
  }

  close() {
    this.db.close();
  }

  store(role: "user" | "assistant" | "system" | string, content: string): number {
    const trimmed = content.trim().slice(0, 4000);
    if (!trimmed) return -1;
    const stems = stemText(trimmed);
    const row = this.db
      .query("INSERT INTO memories (role, content, stems) VALUES (?, ?, ?) RETURNING id")
      .get(role, trimmed, stems) as { id: number };
    try {
      this.db.query("INSERT INTO memories_fts(rowid, content, stems) VALUES (?, ?, ?)").run(row.id, trimmed, stems);
    } catch {
      try {
        // Legacy single-column FTS table from older DBs.
        this.db.query("INSERT INTO memories_fts(rowid, content) VALUES (?, ?)").run(row.id, `${trimmed} ${stems}`);
      } catch {
        /* fts optional */
      }
    }
    // Embed lazily in background (don't block the voice loop).
    void this.embedOne(row.id, trimmed);
    return row.id;
  }

  private async embedOne(id: number, text: string) {
    try {
      const vecs = await this.embedFn([text]);
      const v = vecs?.[0];
      if (v?.length) {
        this.db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(Buffer.from(Float32Array.from(v).buffer), id);
      }
    } catch {
      /* embeddings optional — keyword fallback covers recall */
    }
  }

  /** Backfill missing embeddings (called opportunistically, e.g. at startup). */
  async backfillEmbeddings(limit = 50): Promise<void> {
    try {
      const rows = this.db.query("SELECT id, content FROM memories WHERE embedding IS NULL ORDER BY id DESC LIMIT ?").all(limit) as {
        id: number;
        content: string;
      }[];
      if (!rows.length) return;
      const vecs = await this.embedFn(rows.map((r) => r.content));
      if (!vecs) return;
      const stmt = this.db.query("UPDATE memories SET embedding = ? WHERE id = ?");
      rows.forEach((r, i) => {
        const v = vecs[i];
        if (v?.length) stmt.run(Buffer.from(Float32Array.from(v).buffer), r.id);
      });
    } catch {
      /* ignore */
    }
  }

  async recall(query: string, topK: number = config.memoryTopK): Promise<MemoryHit[]> {
    // 1) Prefer the real MemPalace backend when bridged.
    if (config.mempalaceBridgeUrl) {
      try {
        const res = await fetch(`${config.mempalaceBridgeUrl}/recall`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, top_k: topK }),
        });
        if (res.ok) {
          const j = (await res.json()) as any;
          if (Array.isArray(j.hits)) return j.hits as MemoryHit[];
        }
      } catch {
        /* fall through to local */
      }
    }
    // 2) Semantic search over stored embeddings.
    try {
      const vecs = await this.embedFn([query]);
      const q = vecs?.[0];
      if (q?.length) {
        const rows = this.db.query("SELECT id, role, content, created_at, embedding FROM memories ORDER BY id DESC LIMIT 500").all() as any[];
        const scored: MemoryHit[] = [];
        for (const r of rows) {
          if (!r.embedding) continue;
          const buf = r.embedding as Buffer;
          const v = Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
          const s = cosine(q, v);
          scored.push({ id: r.id, role: r.role, content: r.content, score: s, createdAt: r.created_at });
        }
        scored.sort((a, b) => b.score - a.score);
        if (scored.length && scored[0]!.score > 0.05) return scored.slice(0, topK);
      }
    } catch {
      /* fall through */
    }
    // 3) Keyword fallback (FTS5 prefix → LIKE across stems of all tokens).
    const tokens = query.toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2).slice(0, 8);
    if (!tokens.length) return [];
    const expanded = [...new Set(tokens.flatMap(stemToken))];
    try {
      const ftsQuery = expanded.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
      const rows = this.db
        .query("SELECT rowid AS id FROM memories_fts WHERE memories_fts MATCH ? LIMIT ?")
        .all(ftsQuery, topK * 2) as { id: number }[];
      if (rows.length) {
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(",");
        const full = this.db.query(`SELECT id, role, content, created_at FROM memories WHERE id IN (${placeholders})`).all(...ids) as any[];
        return full.map((r) => ({ id: r.id, role: r.role, content: r.content, score: 0.5, createdAt: r.created_at })).slice(0, topK);
      }
    } catch {
      /* FTS may fail on weird input — use LIKE */
    }
    const where = expanded.map(() => "(content LIKE ? OR stems LIKE ?)").join(" OR ");
    const params: unknown[] = [];
    for (const t of expanded) params.push(`%${t}%`, `%${t}%`);
    params.push(topK);
    const rows = this.db
      .query(`SELECT id, role, content, created_at FROM memories WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params) as any[];
    return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, score: 0.4, createdAt: r.created_at }));
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  }
}

export function buildMemoryContext(hits: MemoryHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h) => `- [${h.createdAt} ${h.role}] ${h.content}`.slice(0, 500));
  return `Relevant past memories (verbatim, local):\n${lines.join("\n")}`;
}
