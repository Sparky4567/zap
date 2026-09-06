import { test, expect } from "bun:test";
import { splitIntoSentences, sanitizeForSpeech } from "../src/voice/pipeline.ts";

test("splitIntoSentences splits on punctuation", () => {
  const { sentences, remainder } = splitIntoSentences("Hello world. How are you? Fine");
  expect(sentences).toEqual(["Hello world.", "How are you?"]);
  expect(remainder).toBe("Fine");
});

test("splitIntoSentences handles empty + no punctuation", () => {
  const r = splitIntoSentences("just words no end");
  expect(r.sentences).toEqual([]);
  expect(r.remainder).toBe("just words no end");
});

test("splitIntoSentences keeps ellipsis/exclamations", () => {
  const { sentences } = splitIntoSentences("Wait… Really! Yes.");
  expect(sentences.length).toBe(3);
});

test("sanitizeForSpeech strips markdown and links", () => {
  const out = sanitizeForSpeech("See [docs](http://x) and `code`:\n```js\nfoo()\n``` https://a.b 😀 **bold**");
  expect(out).not.toContain("```");
  expect(out).not.toContain("https://a.b");
  expect(out).not.toContain("😀");
  expect(out).toContain("bold");
});
