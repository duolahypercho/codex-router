import assert from "node:assert/strict";
import test from "node:test";

const { generateHeaders, toGenerateRequest } = await import("../src/commandcode-generate.mjs");

const AT = Date.parse("2026-08-16T09:00:00.000Z");

// Every one of these is required. The gateway answers a 400 that lists the
// exact missing JSON paths, so a dropped field is a dead provider rather than
// a degraded one.
test("the config envelope carries every field the route validates", () => {
  const { config, memory, taste, skills, permissionMode } = toGenerateRequest(
    { messages: [{ role: "user", content: "hi" }] },
    { model: "deepseek/deepseek-v4-flash", at: AT },
  );
  assert.deepEqual(Object.keys(config).sort(), [
    "currentBranch",
    "date",
    "environment",
    "gitStatus",
    "isGitRepo",
    "mainBranch",
    "recentCommits",
    "structure",
    "workingDir",
  ]);
  assert.equal(config.date, "2026-08-16");
  assert.equal(config.isGitRepo, false);
  // A string, not an object: an object here is a hard 400.
  assert.equal(memory, "");
  assert.equal(taste, null);
  assert.equal(skills, null);
  assert.equal(permissionMode, "standard");
});

test("openai system messages become the system field, not a message", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        { role: "system", content: "Be terse." },
        { role: "developer", content: "Never guess." },
        { role: "user", content: "Hello" },
      ],
    },
    { model: "m", at: AT },
  );
  assert.equal(params.system, "Be terse.\n\nNever guess.");
  assert.deepEqual(params.messages, [{ role: "user", content: [{ type: "text", text: "Hello" }] }]);
});

test("openai tool calls and results translate to ModelMessage shape", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "checking",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "18C" },
        { role: "tool", tool_call_id: "call_1", content: "clear" },
      ],
    },
    { model: "m", at: AT },
  );
  assert.deepEqual(params.messages[1], {
    role: "assistant",
    content: [
      { type: "text", text: "checking" },
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "get_weather",
        input: { location: "Paris" },
      },
    ],
  });
  // Results live in their own tool message, and consecutive results merge into
  // one -- two tool messages would read to the model as two separate turns.
  assert.equal(params.messages.length, 3);
  assert.equal(params.messages[2].role, "tool");
  assert.equal(params.messages[2].content.length, 2);
  assert.deepEqual(params.messages[2].content[0], {
    type: "tool-result",
    toolCallId: "call_1",
    toolName: "get_weather",
    output: { type: "text", value: "18C" },
  });
});

test("unparseable tool arguments still produce an object", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "not json" } }],
        },
      ],
    },
    { model: "m", at: AT },
  );
  assert.deepEqual(params.messages[0].content[0].input, { value: "not json" });
});

test("openai images become data-url image parts with a media type", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    },
    { model: "m", at: AT },
  );
  assert.deepEqual(params.messages[0].content[1], {
    type: "image",
    image: "data:image/png;base64,AAAA",
    mediaType: "image/png",
  });
});

test("openai tools translate to snake_case input_schema", () => {
  const { params } = toGenerateRequest(
    {
      messages: [],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file.",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    },
    { model: "m", at: AT },
  );
  assert.deepEqual(params.tools, [
    {
      name: "read_file",
      description: "Read a file.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
  ]);
});

test("anthropic turns split tool results out of the user message", () => {
  const { params } = toGenerateRequest(
    {
      system: [{ type: "text", text: "Be exact." }],
      max_tokens: 2048,
      messages: [
        { role: "user", content: [{ type: "text", text: "weather?" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "checking" },
            { type: "tool_use", id: "tu_1", name: "get_weather", input: { location: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "18C" }] },
            { type: "text", text: "and tomorrow?" },
          ],
        },
      ],
    },
    { protocol: "anthropic", model: "claude-sonnet-5", at: AT },
  );
  assert.equal(params.system, "Be exact.");
  assert.equal(params.max_tokens, 2048);
  // The thinking block is Anthropic's own replay format and means nothing to a
  // gateway that never issued it, so it is dropped rather than forwarded.
  assert.deepEqual(params.messages[1].content, [
    { type: "text", text: "checking" },
    { type: "tool-call", toolCallId: "tu_1", toolName: "get_weather", input: { location: "Paris" } },
  ]);
  assert.equal(params.messages[2].role, "tool");
  assert.deepEqual(params.messages[2].content[0].output, { type: "text", value: "18C" });
  assert.deepEqual(params.messages[3], {
    role: "user",
    content: [{ type: "text", text: "and tomorrow?" }],
  });
});

test("anthropic error results keep their error tag", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "boom" },
          ],
        },
      ],
    },
    { protocol: "anthropic", model: "m", at: AT },
  );
  assert.deepEqual(params.messages[0].content[0].output, { type: "error-text", value: "boom" });
});

test("anthropic base64 images become data urls", () => {
  const { params } = toGenerateRequest(
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
            },
          ],
        },
      ],
    },
    { protocol: "anthropic", model: "m", at: AT },
  );
  assert.deepEqual(params.messages[0].content[0], {
    type: "image",
    image: "data:image/jpeg;base64,QUJD",
    mediaType: "image/jpeg",
  });
});

// Measured live: the same one-line turn cost 92 prompt tokens with a system
// prompt and 7,637 without, because an empty one makes the gateway splice in
// the Command Code agent's own preamble -- on the caller's credits, and
// telling the model it is a different product.
test("a turn with no system prompt of its own does not inherit the agent's", () => {
  const { params } = toGenerateRequest(
    { messages: [{ role: "user", content: "hi" }] },
    { model: "m", at: AT },
  );
  assert.equal(params.system, "You are a helpful assistant.");
  assert.equal(
    toGenerateRequest(
      { messages: [{ role: "system", content: "Be terse." }] },
      { model: "m", at: AT },
    ).params.system,
    "Be terse.",
  );
  assert.equal(
    toGenerateRequest({ system: "Be exact.", messages: [] }, { protocol: "anthropic", model: "m", at: AT })
      .params.system,
    "Be exact.",
  );
});

test("the turn always streams and defaults its own ceiling", () => {
  const { params } = toGenerateRequest({ messages: [] }, { model: "m", at: AT });
  assert.equal(params.stream, true);
  assert.equal(params.max_tokens, 64_000);
  assert.equal(params.temperature, undefined);
  assert.equal(
    toGenerateRequest({ messages: [], temperature: 0.2 }, { model: "m", at: AT }).params.temperature,
    0.2,
  );
});

test("headers identify the client the envelope was derived from", () => {
  const headers = generateHeaders("user_secret", { sessionId: "s-1" });
  assert.equal(headers.Authorization, "Bearer user_secret");
  assert.equal(headers["x-cli-environment"], "production");
  assert.equal(headers["x-session-id"], "s-1");
  assert.match(headers["x-command-code-version"], /^\d+\.\d+\.\d+$/);
  assert.equal(headers["x-cmd-zdr"], undefined);
  assert.equal(generateHeaders("k", { zdr: true })["x-cmd-zdr"], "1");
});
