// A self-contained check that the Devin CLI provider can reach Cognition's
// backend with the operator's own session. It talks to the upstream directly
// rather than through the installed router, so it works before the provider is
// enabled and tells a tester which of the three layers failed:
//
//   1. the credential the Devin CLI wrote
//   2. the Connect transport and protobuf schemas
//   3. a real streamed turn, optionally with a forced tool call
//
// Everything except step 3 is free. Step 3 spends the account's ACU credits,
// so it only runs with --live.

import { devinCliStatus } from "./devin-cli-status.mjs";
import { readDevinSession } from "./devin-cli-session.mjs";
import { connectServerStream } from "./devin-connect.mjs";
import {
  GET_CHAT_MESSAGE,
  GET_CHAT_MESSAGE_REQUEST,
  GET_CHAT_MESSAGE_RESPONSE,
  SERVICE_PATH,
} from "./devin-proto.mjs";
import { buildChatMessageRequest } from "./devin-cli-turn.mjs";
import { listCascadeModels } from "./devin-cli-forwarder.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

installStableFetchTransport();

const args = process.argv.slice(2);
const live = args.includes("--live");
const wantsTools = args.includes("--tools");
const modelFlag = args.indexOf("--model");
const requestedModel = modelFlag >= 0 ? args[modelFlag + 1] : undefined;

function line(status, message) {
  console.log(`${status.padEnd(5)} ${message}`);
}

function fail(message) {
  line("FAIL", message);
  process.exitCode = 1;
}

async function main() {
  const status = devinCliStatus();
  if (!status.configured) {
    fail(`Devin CLI session: ${status.setup}`);
    console.log(`      looked in ${status.authPath}`);
    return;
  }
  line("OK", `Devin CLI session found (${status.authPath})`);

  const session = readDevinSession();
  let models;
  try {
    models = await listCascadeModels({ session });
  } catch (error) {
    fail(`Model list refused: ${error.message}`);
    return;
  }
  line("OK", `Account advertises ${models.length} model(s)`);
  for (const model of models.slice(0, 40)) {
    const notes = [model.premium ? "premium" : undefined, model.beta ? "beta" : undefined]
      .filter(Boolean)
      .join(", ");
    console.log(`      ${model.id}${notes ? `  (${notes})` : ""}`);
  }
  if (models.length > 40) console.log(`      ... and ${models.length - 40} more`);

  if (!live) {
    line("SKIP", "Live turn not attempted. Re-run with --live to spend one turn of ACU credit.");
    return;
  }

  const model = requestedModel || models[0]?.id;
  if (!model) {
    fail("No model to test; pass --model <uid>.");
    return;
  }

  const chat = {
    model,
    messages: [
      { role: "system", content: "You are a test harness. Answer in one short sentence." },
      { role: "user", content: wantsTools ? "Call the ping tool with value 1." : "Reply with the word: ready" },
    ],
  };
  if (wantsTools) {
    chat.tools = [
      {
        type: "function",
        function: {
          name: "ping",
          description: "Record a numeric value.",
          parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
        },
      },
    ];
    chat.tool_choice = "required";
  }

  let text = "";
  let thinking = "";
  const toolCalls = [];
  try {
    for await (const message of connectServerStream({
      baseUrl: process.env.DEVIN_CASCADE_BASE_URL || session.apiServerUrl,
      service: SERVICE_PATH,
      method: GET_CHAT_MESSAGE,
      token: session.apiKey,
      requestSchema: GET_CHAT_MESSAGE_REQUEST,
      responseSchema: GET_CHAT_MESSAGE_RESPONSE,
      message: buildChatMessageRequest(chat, { token: session.apiKey, modelUid: model }),
    })) {
      if (message.deltaText) text += message.deltaText;
      if (message.deltaThinking) thinking += message.deltaThinking;
      for (const call of message.deltaToolCalls || []) toolCalls.push(call);
    }
  } catch (error) {
    fail(`Live turn on ${model} failed: ${error.message}`);
    return;
  }

  line("OK", `Live turn on ${model} streamed ${text.length} character(s)`);
  if (thinking) line("OK", `Reasoning channel produced ${thinking.length} character(s)`);
  if (text.trim()) console.log(`      ${text.trim().slice(0, 300)}`);
  if (wantsTools) {
    if (toolCalls.length) {
      line("OK", `Forced tool call returned: ${toolCalls.map((call) => call.name).join(", ")}`);
      console.log(`      arguments: ${toolCalls[0].argumentsJson}`);
    } else {
      fail("Forced tool call produced no tool call; this model cannot drive a Codex turn.");
    }
  }
}

main().catch((error) => {
  fail(error.message);
});
