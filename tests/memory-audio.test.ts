import { test, expect } from "bun:test";
import { VerbatimMemory, stemToken } from "../src/memory/mempalace.ts";
import { encodeWavPcm16, parseWav, pcm16ToBase64, base64ToPcm16, rmsEnergy } from "../src/voice/audio.ts";

test("memory stores verbatim and recalls via keyword fallback (no embeddings)", async () => {
  const mem = new VerbatimMemory(":memory:", async () => null);
  mem.store("user", "my dog is called Biscuit");
  mem.store("assistant", "noted, Biscuit the dog");
  mem.store("user", "unrelated quantum tunneling fact");
  const hits = await mem.recall("what is my dog called?");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.content.toLowerCase()).toContain("biscuit");
  expect(mem.count()).toBe(3);
  mem.close();
});

test("stemmer links morphological variants", () => {
  expect(stemToken("hiking")).toContain("hike");
  expect(stemToken("called")).toContain("call");
  expect(stemToken("alps")).toContain("alp");
});

test("memory recalls across word forms (hike ↔ hiking)", async () => {
  const mem = new VerbatimMemory(":memory:", async () => null);
  mem.store("user", "i love hiking in the alps");
  const hits = await mem.recall("where should i hike?");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.content).toContain("alps");
  mem.close();
});

test("memory semantic recall prefers cosine match when embeddings exist", async () => {
  const fakeEmbed = async (texts: string[]) =>
    texts.map((t) => (t.includes("biscuit") ? [1, 0, 0] : t.includes("QUERY") ? [0.9, 0.1, 0] : [0, 1, 0]));
  const mem = new VerbatimMemory(":memory:", fakeEmbed);
  mem.store("user", "my dog biscuit loves parks");
  mem.store("user", "the stock market closed higher");
  await mem.backfillEmbeddings();
  const hits = await mem.recall("QUERY about biscuit");
  expect(hits[0]!.content).toContain("biscuit");
  mem.close();
});

test("wav encode/parse roundtrip + base64", () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const wav = encodeWavPcm16(pcm, 16000);
  expect(wav.length).toBe(44 + 10);
  const { pcm: back, sampleRate } = parseWav(wav);
  expect(sampleRate).toBe(16000);
  expect(Array.from(back)).toEqual(Array.from(pcm));
  const b64 = pcm16ToBase64(pcm);
  expect(Array.from(base64ToPcm16(b64))).toEqual(Array.from(pcm));
});

test("rmsEnergy distinguishes silence from signal", () => {
  expect(rmsEnergy(new Int16Array(160))).toBe(0);
  const loud = new Int16Array(160).fill(10000);
  expect(rmsEnergy(loud)).toBeGreaterThan(0.2);
});
