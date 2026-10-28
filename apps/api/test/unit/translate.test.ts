import { describe, expect, it } from "vitest";
import {
  AnthropicToOpenAiStream,
  anthropicToOpenAiRequest,
  anthropicToOpenAiResponse,
  OpenAiToAnthropicStream,
  openAiToAnthropicRequest,
  openAiToAnthropicResponse,
  type AnthResponse,
  type OAIChatRequest,
  type OAIChunk,
} from "../../src/gateway/translate";

describe("openAiToAnthropicRequest", () => {
  const req: OAIChatRequest = {
    model: "public-model",
    messages: [
      { role: "system", content: "Be brief" },
      { role: "developer", content: [{ type: "text", text: "Use metric" }] },
      { role: "user", content: "Hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "Look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
        ],
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "18C" },
    ],
    max_tokens: 100,
    max_completion_tokens: 200,
    temperature: 1.5,
    top_p: 0.9,
    stop: "END",
    stream: true,
    response_format: { type: "json_object" },
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ],
    tool_choice: "required",
  };

  it("hoists system and developer messages, merges same-role turns and maps tools", () => {
    const out = openAiToAnthropicRequest(req, "claude-upstream", 4096);
    expect(out.model).toBe("claude-upstream");
    expect(out.system).toBe(
      "Be brief\n\nUse metric\n\nRespond with a single valid JSON object and nothing else."
    );
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Hi" },
          { type: "text", text: "Look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "18C" }] },
    ]);
    expect(out.max_tokens).toBe(200);
    expect(out.temperature).toBe(1);
    expect(out.top_p).toBe(0.9);
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.stream).toBe(true);
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: "any" });
  });

  it("falls back to the default max tokens, an empty schema and an empty input for bad arguments", () => {
    const out = openAiToAnthropicRequest(
      {
        model: "m",
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: "Sure",
            tool_calls: [
              { id: "c", type: "function", function: { name: "f", arguments: "{not json" } },
            ],
          },
        ],
        tools: [{ type: "function", function: { name: "f" } }],
        tool_choice: { type: "function", function: { name: "f" } },
      },
      "up",
      4096
    );
    expect(out.max_tokens).toBe(4096);
    expect(out.system).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.tools![0]!.input_schema).toEqual({ type: "object", properties: {} });
    expect(out.tool_choice).toEqual({ type: "tool", name: "f" });
    expect(out.messages[1]!.content).toEqual([
      { type: "text", text: "Sure" },
      { type: "tool_use", id: "c", name: "f", input: {} },
    ]);
  });

  it("maps auto and none tool choices", () => {
    const base = { model: "m", messages: [{ role: "user" as const, content: "x" }] };
    expect(openAiToAnthropicRequest({ ...base, tool_choice: "auto" }, "up", 1).tool_choice).toEqual(
      { type: "auto" }
    );
    expect(openAiToAnthropicRequest({ ...base, tool_choice: "none" }, "up", 1).tool_choice).toEqual(
      { type: "none" }
    );
  });
});

describe("anthropicToOpenAiResponse", () => {
  const res: AnthResponse = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-upstream",
    content: [
      { type: "text", text: "Hi " },
      { type: "text", text: "there" },
      { type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
  };

  it("joins text, turns tool_use into tool_calls and counts cache tokens as prompt tokens", () => {
    const out = anthropicToOpenAiResponse(res, "public-model");
    expect(out.id).toBe("chatcmpl-msg_1");
    expect(out.model).toBe("public-model");
    expect(out.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: "Hi there",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ],
      },
      finish_reason: "tool_calls",
    });
    expect(out.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 4,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it("gives null content for a tool-only answer and an empty string for an empty one", () => {
    expect(
      anthropicToOpenAiResponse(
        { ...res, content: [{ type: "tool_use", id: "t", name: "f", input: {} }] },
        "p"
      ).choices[0]!.message.content
    ).toBeNull();
    const empty = anthropicToOpenAiResponse({ ...res, content: [] }, "p").choices[0]!.message;
    expect(empty.content).toBe("");
    expect(empty.tool_calls).toBeUndefined();
  });

  it("maps stop reasons to finish reasons", () => {
    const finish = (stop_reason: string | null) =>
      anthropicToOpenAiResponse({ ...res, stop_reason }, "p").choices[0]!.finish_reason;
    expect(finish("end_turn")).toBe("stop");
    expect(finish("max_tokens")).toBe("length");
    expect(finish("stop_sequence")).toBe("stop");
    expect(finish("refusal")).toBe("content_filter");
    expect(finish(null)).toBe("stop");
    expect(finish("something_new")).toBe("stop");
  });
});

describe("AnthropicToOpenAiStream", () => {
  it("turns a text and tool stream into chunks and reports merged usage", () => {
    const s = new AnthropicToOpenAiStream("public-model");
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"Paris"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ];
    const chunks = events.flatMap((e) => s.push(e));
    expect(
      chunks.every(
        (c) =>
          c.id === "chatcmpl-msg_1" &&
          c.model === "public-model" &&
          c.object === "chat.completion.chunk"
      )
    ).toBe(true);
    expect(chunks.map((c) => [c.choices[0]!.delta, c.choices[0]!.finish_reason])).toEqual([
      [{ role: "assistant", content: "" }, null],
      [{ content: "Hel" }, null],
      [{ content: "lo" }, null],
      [
        {
          tool_calls: [
            {
              index: 0,
              id: "toolu_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
        null,
      ],
      [{ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, null],
      [{ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, null],
      [{}, "tool_calls"],
    ]);
    const u = s.usageChunk();
    expect(u.choices).toEqual([]);
    expect(u.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 20,
      total_tokens: 35,
      prompt_tokens_details: { cached_tokens: 5 },
    });
  });

  it("ignores unknown events and deltas for unknown blocks", () => {
    const s = new AnthropicToOpenAiStream("p");
    expect(s.push({ type: "ping" })).toEqual([]);
    expect(
      s.push({
        type: "content_block_delta",
        index: 7,
        delta: { type: "input_json_delta", partial_json: "{}" },
      })
    ).toEqual([]);
  });
});

describe("anthropicToOpenAiRequest", () => {
  it("puts the system first, splits tool results into tool messages and keeps images", () => {
    const out = anthropicToOpenAiRequest(
      {
        model: "public-model",
        system: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
        messages: [
          { role: "user", content: "Hi" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling" },
              { type: "tool_use", id: "t1", name: "f", input: { x: 1 } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "done" },
              { type: "text", text: "thanks" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "text", text: "what" },
            ],
          },
        ],
        max_tokens: 50,
        temperature: 0.2,
        stop_sequences: ["X"],
        tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
        tool_choice: { type: "any" },
        stream: true,
      },
      "gpt-upstream"
    );
    expect(out.model).toBe("gpt-upstream");
    expect(out.messages).toEqual([
      { role: "system", content: "A\n\nB" },
      { role: "user", content: "Hi" },
      {
        role: "assistant",
        content: "Calling",
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "done" },
      { role: "user", content: "thanks" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "text", text: "what" },
        ],
      },
    ]);
    expect(out.max_tokens).toBe(50);
    expect(out.temperature).toBe(0.2);
    expect(out.stop).toEqual(["X"]);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object" } },
      },
    ]);
    expect(out.tool_choice).toBe("required");
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("maps a named tool choice and leaves stream options off for non-streaming", () => {
    const out = anthropicToOpenAiRequest(
      {
        model: "m",
        system: "S",
        messages: [{ role: "user", content: "x" }],
        max_tokens: 5,
        tool_choice: { type: "tool", name: "f" },
      },
      "up"
    );
    expect(out.messages[0]).toEqual({ role: "system", content: "S" });
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "f" } });
    expect(out.stream_options).toBeUndefined();
  });
});

describe("openAiToAnthropicResponse", () => {
  it("builds text and tool_use blocks and splits cached tokens out of input", () => {
    const out = openAiToAnthropicResponse(
      {
        id: "chatcmpl-abc",
        object: "chat.completion",
        created: 1,
        model: "gpt-upstream",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hi",
              tool_calls: [
                { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
              ],
            },
            finish_reason: "length",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
      "public-model"
    );
    expect(out).toEqual({
      id: "msg_abc",
      type: "message",
      role: "assistant",
      model: "public-model",
      content: [
        { type: "text", text: "Hi" },
        { type: "tool_use", id: "c1", name: "f", input: { a: 1 } },
      ],
      stop_reason: "max_tokens",
      stop_sequence: null,
      usage: { input_tokens: 6, output_tokens: 5, cache_read_input_tokens: 4 },
    });
  });

  it("maps finish reasons and reports zero usage when none came back", () => {
    const r = (finish_reason: string | null) =>
      openAiToAnthropicResponse(
        {
          id: "x",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason }],
        },
        "p"
      );
    expect(r("stop").stop_reason).toBe("end_turn");
    expect(r("tool_calls").stop_reason).toBe("tool_use");
    expect(r("content_filter").stop_reason).toBe("refusal");
    expect(r(null).stop_reason).toBe("end_turn");
    expect(r("stop").content).toEqual([]);
    expect(r("stop").usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("OpenAiToAnthropicStream", () => {
  const chunk = (
    delta: OAIChunk["choices"][0]["delta"],
    finish_reason: string | null = null
  ): OAIChunk => ({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason }],
  });

  it("opens and closes blocks in order and ends with usage from the last chunk", () => {
    const s = new OpenAiToAnthropicStream("public-model", "msg_t");
    const events = [
      ...s.push(chunk({ role: "assistant", content: "" })),
      ...s.push(chunk({ content: "Hi" })),
      ...s.push(chunk({ content: "!" })),
      ...s.push(
        chunk({
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "" } },
          ],
        })
      ),
      ...s.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] })),
      ...s.push(chunk({}, "tool_calls")),
      ...s.push({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
          total_tokens: 19,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      }),
      ...s.finish(),
    ];
    expect(events).toEqual([
      {
        type: "message_start",
        message: {
          id: "msg_t",
          type: "message",
          role: "assistant",
          model: "public-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "f", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 7, input_tokens: 10, cache_read_input_tokens: 2 },
      },
      { type: "message_stop" },
    ]);
  });

  it("closes the previous tool block when a second tool starts", () => {
    const s = new OpenAiToAnthropicStream("p", "msg_x");
    s.push(
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{}" } }] })
    );
    const second = s.push(chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "g" } }] }));
    expect(second).toEqual([
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "b", name: "g", input: {} },
      },
    ]);
  });

  it("finishing an empty stream still yields a well formed message", () => {
    const events = new OpenAiToAnthropicStream("p", "msg_e").finish();
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
    expect(events[1]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
    });
  });
});
