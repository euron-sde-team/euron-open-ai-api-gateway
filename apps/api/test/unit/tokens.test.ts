import { describe, expect, it } from "vitest";
import {
  estimateChatInput,
  estimateEmbeddingInput,
  estimateTextTokens,
} from "../../src/gateway/tokens";

describe("estimateTextTokens", () => {
  it("is about four characters a token, rounded up", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
  });
});

describe("estimateChatInput", () => {
  it("adds per-message overhead and a fixed base", () => {
    expect(estimateChatInput({})).toBe(3);
    expect(estimateChatInput({ messages: [{ role: "user", content: "abcdefgh" }] })).toBe(
      4 + 2 + 3
    );
  });

  it("counts a fixed allowance per image in content arrays, OpenAI and Anthropic shapes", () => {
    const content = [
      { type: "text", text: "abcd" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ];
    expect(estimateChatInput({ messages: [{ role: "user", content }] })).toBe(4 + 1 + 1200 + 3);
    expect(
      estimateChatInput({
        messages: [
          { role: "user", content: [{ type: "image", source: {} }, { type: "input_image" }] },
        ],
      })
    ).toBe(4 + 2400 + 3);
  });

  it("counts the system prompt, tool definitions and tool calls", () => {
    expect(estimateChatInput({ system: "abcd" })).toBe(1 + 3);
    // '[{"a":1}]' is 9 characters
    expect(estimateChatInput({ tools: [{ a: 1 }] })).toBe(3 + 3);
    // '[{"id":"c"}]' is 12 characters
    expect(
      estimateChatInput({
        messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c" }] }],
      })
    ).toBe(4 + 3 + 3);
  });

  it("serialises parts without text", () => {
    // '{"type":"x"}' is 12 characters
    expect(estimateChatInput({ messages: [{ content: [{ type: "x" }] }] })).toBe(4 + 3 + 3);
  });
});

describe("estimateEmbeddingInput", () => {
  it("handles a string, strings, a token array and token arrays", () => {
    expect(estimateEmbeddingInput("abcdefgh")).toBe(2);
    expect(estimateEmbeddingInput(["abcd", "abcdefgh"])).toBe(3);
    expect(estimateEmbeddingInput([1, 2, 3])).toBe(3);
    expect(
      estimateEmbeddingInput([
        [1, 2],
        [3, 4, 5],
      ])
    ).toBe(5);
  });

  it("is 0 for anything else", () => {
    expect(estimateEmbeddingInput(42)).toBe(0);
    expect(estimateEmbeddingInput(null)).toBe(0);
    expect(estimateEmbeddingInput([])).toBe(0);
  });
});
