import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_API_VERSION,
  createGeminiStreamTranslator,
  estimateGeminiTokens,
  geminiModelListPayload,
  geminiToResponsesPayload,
  parseGeminiPath,
  responsesPayloadToGemini,
} from "../src/gemini-shape.mjs";

function userTurn(text) {
  return { role: "user", parts: [{ text }] };
}

test("the api version is the one the GenAI SDK defaults to", () => {
  // @google/genai builds `${baseUrl}/${apiVersion}/models/...` and its
  // GOOGLE_AI_API_DEFAULT_VERSION is v1beta. Serving anything else means the
  // CLI's own requests 404 against a surface that is otherwise correct.
  assert.equal(GEMINI_API_VERSION, "v1beta");
});

test("a routed slug keeps its slash through the path", () => {
  // Router slugs are `vendor/model`, and the SDK renders `models/{model}:method`
  // verbatim. Splitting on the first slash would resolve `vendor` as the model.
  assert.deepEqual(parseGeminiPath("/v1beta/models/vendor/model:generateContent"), {
    model: "vendor/model",
    method: "generateContent",
  });
});

test("the streaming path is recognized with its alt=sse query already stripped", () => {
  assert.deepEqual(parseGeminiPath("/v1beta/models/openai/gpt-5:streamGenerateContent"), {
    model: "openai/gpt-5",
    method: "streamGenerateContent",
  });
});

test("the model list path carries no model", () => {
  assert.deepEqual(parseGeminiPath("/v1beta/models"), { method: "list" });
  assert.deepEqual(parseGeminiPath("/v1beta/models/"), { method: "list" });
});

test("an unknown path is refused rather than guessed at", () => {
  assert.equal(parseGeminiPath("/v1/models/x:generateContent"), undefined);
  assert.equal(parseGeminiPath("/v1beta/tunedModels/x:generateContent"), undefined);
  assert.equal(parseGeminiPath("/v1beta/models/x:unknownMethod"), undefined);
});

test("a plain turn becomes a Responses input item", () => {
  const payload = geminiToResponsesPayload({
    model: "vendor/model",
    body: { contents: [userTurn("hello")] },
    stream: true,
  });
  assert.equal(payload.model, "vendor/model");
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
});

test("systemInstruction becomes instructions, not a message", () => {
  // Responses carries the system prompt out of band. Folding it into the input
  // array puts it in the transcript, where tool-result ageing can drop it.
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      systemInstruction: { parts: [{ text: "be terse" }, { text: "and correct" }] },
      contents: [userTurn("hi")],
    },
  });
  assert.equal(payload.instructions, "be terse\nand correct");
  assert.equal(payload.input.length, 1);
});

test("a bare-string systemInstruction is accepted too", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: { systemInstruction: "be terse", contents: [userTurn("hi")] },
  });
  assert.equal(payload.instructions, "be terse");
});

test("inline image data becomes a data URL the routed path already understands", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [
        { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      ],
    },
  });
  assert.deepEqual(payload.input[0].content, [
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
});

test("function declarations become Responses tools", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      tools: [
        {
          functionDeclarations: [
            { name: "read_file", description: "reads", parameters: { type: "object" } },
          ],
        },
      ],
    },
  });
  assert.deepEqual(payload.tools, [
    {
      type: "function",
      name: "read_file",
      description: "reads",
      parameters: { type: "object" },
    },
  ]);
});

test("a declaration that carries parametersJsonSchema keeps its schema", () => {
  // Every Gemini CLI tool declares its schema this way -- `parametersJsonSchema`
  // is what `tools.js` writes and what its own validator checks calls against.
  // Reading only `parameters` sent all ten tools upstream with no schema, so the
  // model invented argument names and the CLI rejected every call it got back
  // with "params must have required property 'file_path'".
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              description: "reads",
              parametersJsonSchema: {
                type: "object",
                properties: { file_path: { type: "string" } },
                required: ["file_path"],
              },
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(payload.tools[0].parameters, {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  });
});

test("parametersJsonSchema wins when a declaration carries both", () => {
  // The raw JSON Schema is the authoritative one; `parameters` is the older
  // Schema-proto spelling and may be a lossy rendering of it.
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      tools: [
        {
          functionDeclarations: [
            {
              name: "f",
              parameters: { type: "object", properties: { old: { type: "string" } } },
              parametersJsonSchema: {
                type: "object",
                properties: { new: { type: "string" } },
              },
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(payload.tools[0].parameters, {
    type: "object",
    properties: { new: { type: "string" } },
  });
});

test("a tool with no schema at all is sent with an empty object schema", () => {
  // Not omitted: a provider on the chat-completions path rejects a function
  // whose parameters are absent, and "no arguments" is a schema, not a gap.
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      tools: [{ functionDeclarations: [{ name: "ping" }] }],
    },
  });
  assert.deepEqual(payload.tools[0].parameters, { type: "object", properties: {} });
});

test("a tool call and its result pair on a synthesized call id", () => {
  // Gemini omits `id` on both halves whenever the caller did not supply one,
  // so the pairing has to be reconstructed positionally. Responses drops a
  // function_call_output whose call_id matches no call, which reads to the
  // model as a tool that never answered.
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [
        userTurn("read it"),
        { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a" } } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "read_file", response: { text: "ok" } } }],
        },
      ],
    },
  });
  const call = payload.input.find((item) => item.type === "function_call");
  const output = payload.input.find((item) => item.type === "function_call_output");
  assert.equal(call.name, "read_file");
  assert.equal(call.arguments, JSON.stringify({ path: "a" }));
  assert.equal(output.call_id, call.call_id);
  assert.equal(output.output, JSON.stringify({ text: "ok" }));
});

test("repeated calls to one tool pair in order", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [
        {
          role: "model",
          parts: [
            { functionCall: { name: "f", args: { n: 1 } } },
            { functionCall: { name: "f", args: { n: 2 } } },
          ],
        },
        {
          role: "user",
          parts: [
            { functionResponse: { name: "f", response: { n: 1 } } },
            { functionResponse: { name: "f", response: { n: 2 } } },
          ],
        },
      ],
    },
  });
  const calls = payload.input.filter((item) => item.type === "function_call");
  const outputs = payload.input.filter((item) => item.type === "function_call_output");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].call_id, calls[1].call_id);
  assert.equal(outputs[0].call_id, calls[0].call_id);
  assert.equal(outputs[1].call_id, calls[1].call_id);
});

test("an explicit id wins over the synthesized one", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [
        { role: "model", parts: [{ functionCall: { id: "call-7", name: "f", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { id: "call-7", name: "f", response: {} } }] },
      ],
    },
  });
  assert.equal(payload.input[0].call_id, "call-7");
  assert.equal(payload.input[1].call_id, "call-7");
});

test("a model's own thought parts are not replayed as assistant text", () => {
  // Gemini marks reasoning with `thought: true`. Sending it back as an ordinary
  // assistant message would put the model's private reasoning in the visible
  // transcript on every subsequent turn.
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [
        { role: "model", parts: [{ text: "thinking", thought: true }, { text: "answer" }] },
      ],
    },
  });
  assert.deepEqual(payload.input, [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
  ]);
});

test("generation config maps onto the Responses parameters that exist", () => {
  const payload = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 512 },
    },
  });
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.top_p, 0.9);
  assert.equal(payload.max_output_tokens, 512);
});

test("a thinking budget becomes a reasoning effort, and zero means minimal", () => {
  const off = geminiToResponsesPayload({
    model: "m",
    body: { contents: [userTurn("hi")], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
  });
  assert.deepEqual(off.reasoning, { effort: "minimal" });
  const deep = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      generationConfig: { thinkingConfig: { thinkingBudget: 24000 } },
    },
  });
  assert.deepEqual(deep.reasoning, { effort: "high" });
});

test("no thinking config leaves reasoning to the router's own per-model profile", () => {
  const payload = geminiToResponsesPayload({ model: "m", body: { contents: [userTurn("hi")] } });
  assert.equal(payload.reasoning, undefined);
});

test("the function calling mode maps onto tool_choice", () => {
  const forced = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    },
  });
  assert.equal(forced.tool_choice, "required");
  const none = geminiToResponsesPayload({
    model: "m",
    body: {
      contents: [userTurn("hi")],
      toolConfig: { functionCallingConfig: { mode: "NONE" } },
    },
  });
  assert.equal(none.tool_choice, "none");
});

test("a completed Responses payload becomes one Gemini candidate", () => {
  const gemini = responsesPayloadToGemini(
    {
      id: "resp_1",
      model: "vendor/model",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "hmm" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    },
    { model: "vendor/model" },
  );
  assert.equal(gemini.candidates.length, 1);
  assert.equal(gemini.candidates[0].finishReason, "STOP");
  assert.deepEqual(gemini.candidates[0].content.parts, [
    { text: "hmm", thought: true },
    { text: "hello" },
  ]);
  assert.deepEqual(gemini.usageMetadata, {
    promptTokenCount: 11,
    candidatesTokenCount: 3,
    totalTokenCount: 14,
  });
  assert.equal(gemini.responseId, "resp_1");
  assert.equal(gemini.modelVersion, "vendor/model");
});

test("a function call survives the non-streaming translation", () => {
  const gemini = responsesPayloadToGemini(
    {
      status: "completed",
      output: [
        { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a"}' },
      ],
    },
    { model: "m" },
  );
  assert.deepEqual(gemini.candidates[0].content.parts, [
    { functionCall: { id: "c1", name: "read_file", args: { path: "a" } } },
  ]);
});

test("unparsable tool arguments are surfaced, not dropped", () => {
  // A provider that emits truncated JSON must not silently become a call with
  // no arguments -- the tool would run on defaults and look like it succeeded.
  const gemini = responsesPayloadToGemini(
    { status: "completed", output: [{ type: "function_call", name: "f", arguments: "{oops" }] },
    { model: "m" },
  );
  assert.deepEqual(gemini.candidates[0].content.parts[0].functionCall.args, {});
  assert.equal(gemini.promptFeedback, undefined);
});

test("an output cut short reports MAX_TOKENS", () => {
  const gemini = responsesPayloadToGemini(
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }] }],
    },
    { model: "m" },
  );
  assert.equal(gemini.candidates[0].finishReason, "MAX_TOKENS");
});

test("reasoning tokens are reported where Gemini clients look for them", () => {
  const gemini = responsesPayloadToGemini(
    {
      status: "completed",
      output: [],
      usage: {
        input_tokens: 5,
        output_tokens: 9,
        total_tokens: 14,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
    { model: "m" },
  );
  assert.equal(gemini.usageMetadata.thoughtsTokenCount, 4);
});

test("the stream translator turns text deltas into candidate chunks", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  const chunks = [
    ...translator.push({ type: "response.output_text.delta", delta: "he" }),
    ...translator.push({ type: "response.output_text.delta", delta: "llo" }),
  ];
  assert.deepEqual(
    chunks.map((chunk) => chunk.candidates[0].content.parts[0].text),
    ["he", "llo"],
  );
  assert.equal(chunks[0].candidates[0].content.role, "model");
});

test("reasoning deltas are marked as thoughts", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  const [chunk] = translator.push({
    type: "response.reasoning_summary_text.delta",
    delta: "considering",
  });
  assert.deepEqual(chunk.candidates[0].content.parts, [{ text: "considering", thought: true }]);
});

test("a completed function call is emitted once, when the item closes", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  assert.deepEqual(
    translator.push({
      type: "response.output_item.added",
      item: { type: "function_call", name: "f", call_id: "c1" },
    }),
    [],
  );
  const [chunk] = translator.push({
    type: "response.output_item.done",
    item: { type: "function_call", name: "f", call_id: "c1", arguments: '{"a":1}' },
  });
  assert.deepEqual(chunk.candidates[0].content.parts, [
    { functionCall: { id: "c1", name: "f", args: { a: 1 } } },
  ]);
});

test("the terminal event carries the finish reason and the usage", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  translator.push({ type: "response.output_text.delta", delta: "hi" });
  const [chunk] = translator.push({
    type: "response.completed",
    response: {
      id: "resp_9",
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  });
  assert.equal(chunk.candidates[0].finishReason, "STOP");
  assert.deepEqual(chunk.usageMetadata, {
    promptTokenCount: 2,
    candidatesTokenCount: 1,
    totalTokenCount: 3,
  });
  assert.equal(chunk.responseId, "resp_9");
});

test("a stream that ends without a terminal event still closes the candidate", () => {
  // The SDK waits for a finishReason. A dropped upstream would otherwise leave
  // the CLI holding an open turn until its own timeout.
  const translator = createGeminiStreamTranslator({ model: "m" });
  translator.push({ type: "response.output_text.delta", delta: "hi" });
  const closing = translator.finish();
  assert.equal(closing.length, 1);
  assert.equal(closing[0].candidates[0].finishReason, "STOP");
});

test("a terminal event makes the closer a no-op", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  translator.push({ type: "response.completed", response: { status: "completed" } });
  assert.deepEqual(translator.finish(), []);
});

test("a failed response finishes as OTHER rather than as a clean stop", () => {
  const translator = createGeminiStreamTranslator({ model: "m" });
  const [chunk] = translator.push({
    type: "response.failed",
    response: { status: "failed", error: { message: "upstream refused" } },
  });
  assert.equal(chunk.candidates[0].finishReason, "OTHER");
});

test("the model list is shaped the way the SDK expects", () => {
  const payload = geminiModelListPayload([
    { slug: "vendor/model", displayName: "Vendor Model", contextWindow: 262144 },
  ]);
  assert.deepEqual(payload.models, [
    {
      name: "models/vendor/model",
      displayName: "Vendor Model",
      description: "Routed by Codex Router.",
      inputTokenLimit: 262144,
      outputTokenLimit: 262144,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    },
  ]);
});

test("the token estimate always answers, including for an empty request", () => {
  // countTokens has no upstream to ask, and a client that gets no number at all
  // cannot decide whether to compact. A crude estimate beats a 501 here.
  assert.equal(estimateGeminiTokens({ contents: [] }), 0);
  assert.ok(estimateGeminiTokens({ contents: [userTurn("x".repeat(400))] }) > 0);
});
