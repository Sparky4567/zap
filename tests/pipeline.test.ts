import { test, expect } from "bun:test";
import { VerbatimMemory } from "../src/memory/mempalace.ts";
import { runTextTurn } from "../src/voice/pipeline.ts";

// Full turn with mocked LLM/TTS: verifies memory recall injection, token
// streaming, per-sentence TTS fan-out, verbatim commit, and barge-in abort.
test("runTextTurn streams, speaks per sentence, commits memory", async () => {
  const mem = new VerbatimMemory(":memory:", async () => null);
  mem.store("user", "i love hiking in the alps");
  const history: { role: "system" | "user" | "assistant"; content: string }[] = [];
  const tokens: string[] = [];
  const spoken: string[] = [];
  const audios: string[] = [];

  const out = await runTextTurn(
    "where should i hike?",
    {
      memory: mem,
      history,
      chat: async (msgs, onToken) => {
        // memory context must be injected into the system prompt
        expect(msgs[0]!.content).toContain("alps");
        for (const t of ["First. ", "Second!"]) onToken(t);
        return "First. Second!";
      },
      synth: async (text) => {
        spoken.push(text);
        return { pcm: Buffer.from([1, 2, 3]), sampleRate: 16000 };
      },
    },
    {
      onLlmToken: (t) => tokens.push(t),
      onTtsAudio: (b64) => audios.push(b64),
    },
  );
  expect(out.assistantText).toBe("First. Second!");
  expect(tokens.join("")).toBe("First. Second!");
  expect(spoken).toEqual(["First.", "Second!"]);
  expect(audios.length).toBe(2);
  expect(history.length).toBe(2);
  expect(mem.count()).toBe(3); // 1 seeded + user + assistant
  mem.close();
});

test("runTextTurn abort (barge-in) stops the turn", async () => {
  const mem = new VerbatimMemory(":memory:", async () => null);
  const ctrl = new AbortController();
  ctrl.abort();
  let err: unknown = null;
  try {
    await runTextTurn("hello", { memory: mem, history: [] }, {}, ctrl.signal);
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
  expect((err as Error).name).toBe("AbortError");
  mem.close();
});
