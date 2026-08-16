// A conclusive check that the Devin CLI provider's Cascade transport is right.
//
// Every network-facing constant this provider uses -- field numbers, wire
// types, the service path, the authorization scheme, the framing -- was read
// out of a shipped binary rather than a published interface. None of it has
// ever met Cognition's backend. The point of this file is that one run by one
// person with an account settles each of those assumptions separately, and
// prints a line naming the one that broke, rather than a single boolean that
// says "something responded".
//
// It talks to the upstream directly instead of through the installed router,
// so it works before the provider is enabled, and it reads the raw bytes off
// the wire rather than trusting the transport it is supposed to be testing.
//
// Everything except the `--live` stage is free. `--live` spends one short turn
// of the account's ACU credits and is capped to a few dozen output tokens.

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import { ProbeReport, truncateForReport } from "./probe-report.mjs";
import { auditMessage, fieldCensus } from "./protobuf-audit.mjs";
import {
  connectStatusFor,
  createEnvelopeScanner,
  encodeEnvelope,
  isKnownConnectCode,
  isRetriableConnectCode,
  parseEndStreamPayload,
} from "./connect-stream-audit.mjs";
import {
  liveTurnChecks,
  modelListChecks,
  parseProbeArgs,
  requestShapeChecks,
  streamFrameChecks,
  toolCallChecks,
} from "./devin-probe-checks.mjs";

installStableFetchTransport();

const USAGE = `Usage: bin/devin-probe [--live] [--tools] [--model <uid>] [--max-tokens <n>] [--timeout <seconds>] [--json]

Checks the Devin CLI provider's Cascade transport against your own account and
prints one PASS/FAIL line per assumption.

Without --live nothing is spent: the probe reads the session the official Devin
CLI wrote, re-reads the request it would send, and asks the account which models
it may run.

--live       Run one short turn. This spends ACU credit on your account.
--tools      With --live, force a tool call. This is the check that decides
             whether Codex can drive the provider at all.
--model      Pick a model uid from the free run's list. Defaults to the first.
--max-tokens Cap the live turn's output. Default 64.
--timeout    Give up on the live stream after this many seconds. Default 90.
--json       Print the checklist as JSON instead of text.
`;

// The provider's own sources land with #271. Everything above is generic and
// ships without them, so say plainly which branch is missing rather than dying
// on a module resolution error a tester cannot act on.
const PROVIDER_MODULES = Object.freeze([
  "./devin-cli-status.mjs",
  "./devin-cli-session.mjs",
  "./devin-proto.mjs",
  "./devin-cli-turn.mjs",
  "./devin-connect.mjs",
  "./protobuf-wire.mjs",
]);

async function loadProvider() {
  const loaded = {};
  for (const specifier of PROVIDER_MODULES) {
    try {
      loaded[specifier] = await import(specifier);
    } catch (error) {
      return { missing: specifier, reason: error?.message || String(error) };
    }
  }
  return {
    status: loaded["./devin-cli-status.mjs"],
    session: loaded["./devin-cli-session.mjs"],
    proto: loaded["./devin-proto.mjs"],
    turn: loaded["./devin-cli-turn.mjs"],
    connect: loaded["./devin-connect.mjs"],
    wire: loaded["./protobuf-wire.mjs"],
  };
}

function devinCliVersion() {
  const binary = commandOnPath("devin");
  if (!binary) return "not on PATH";
  try {
    const { command, args } = spawnableCommand(binary, ["--version"]);
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
    const text = `${result.stdout || ""}${result.stderr || ""}`.trim();
    return text.split("\n")[0]?.slice(0, 120) || "unknown";
  } catch {
    return "unknown";
  }
}

// The output of this probe is written to be pasted into a public issue, so a
// home directory -- which usually carries the operator's name -- is folded back
// to `~` before it is ever printed.
function homeRelative(target) {
  const home = os.homedir();
  return home && String(target).startsWith(home) ? `~${String(target).slice(home.length)}` : String(target);
}

// Only the host. The stored URL is not itself a secret, but a probe's output is
// written to be pasted in public and an enterprise host names the employer.
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

function requestUrl(baseUrl, service, method) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${service}/${method}`;
}

async function describeHttpFailure(response) {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const code = typeof parsed?.code === "string" ? parsed.code : undefined;
  return {
    httpStatus: response.status,
    code,
    known: isKnownConnectCode(code),
    retriable: isRetriableConnectCode(code),
    mappedStatus: connectStatusFor(code, response.status),
    message: parsed?.message || body.slice(0, 300) || `HTTP ${response.status}`,
    contentType: response.headers?.get?.("content-type") || "(none)",
  };
}

function failureCheck(name, failure, fix) {
  return {
    status: "fail",
    name,
    detail: `the upstream refused the request: ${truncateForReport(failure.message, 240)}`,
    observed: `http=${failure.httpStatus} connect-code=${failure.code || "(none)"} known=${failure.known} retriable=${failure.retriable} content-type=${failure.contentType}`,
    fix,
  };
}

async function runFreeStage(report, provider, args, fetchImpl) {
  const { proto, wire, turn, connect } = provider;
  const status = provider.status.devinCliStatus();
  if (!status.configured) {
    report.fail("devin cli session", status.setup, { observed: homeRelative(status.authPath) });
    return undefined;
  }
  report.pass("devin cli session", `read from ${homeRelative(status.authPath)}`);

  let session;
  try {
    session = provider.session.readDevinSession();
  } catch (error) {
    report.fail("devin cli session", error.message, { observed: homeRelative(status.authPath) });
    return undefined;
  }
  const baseUrl = process.env.DEVIN_CASCADE_BASE_URL || session.apiServerUrl;
  report.info("cascade host", hostOf(baseUrl));

  // Free and decisive about our own writer: build the exact turn request and
  // read it back through an independent auditor.
  const sampleRequest = turn.buildChatMessageRequest(
    {
      model: args.model || "probe-model",
      messages: [{ role: "user", content: "probe" }],
      max_tokens: args.maxTokens,
    },
    { token: session.apiKey, modelUid: args.model || "probe-model" },
  );
  report.addAll(
    requestShapeChecks({
      audit: auditMessage(wire.encodeMessage(proto.GET_CHAT_MESSAGE_REQUEST, sampleRequest), proto.GET_CHAT_MESSAGE_REQUEST),
      requiredFields: ["metadata", "prompt", "requestType", "chatModelUid", "chatMessagePrompts", "configuration"],
    }),
  );

  let response;
  try {
    response = await fetchImpl(requestUrl(baseUrl, proto.SERVICE_PATH, proto.GET_CASCADE_MODEL_CONFIGS), {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        "connect-accept-encoding": "identity",
        authorization: connect.connectAuthorization(session.apiKey),
      },
      body: wire.encodeMessage(proto.GET_CASCADE_MODEL_CONFIGS_REQUEST, {
        metadata: { apiKey: session.apiKey, ideName: "windsurf", locale: "en" },
      }),
    });
  } catch (error) {
    report.fail("model list", `the request never reached the upstream: ${error.message}`, {
      observed: hostOf(baseUrl),
      fix: "A DNS or TLS failure here is a network problem, not a schema problem.",
    });
    return undefined;
  }

  if (!response.ok) {
    const failure = await describeHttpFailure(response);
    report.add(
      failureCheck(
        "model list",
        failure,
        failure.httpStatus === 401
          ? "Run `devin auth login` again, or the Basic `<token>-<token>` authorization scheme this build sends is wrong."
          : failure.code === "unimplemented"
            ? "`unimplemented` means the service path or method name is wrong, not that the account is at fault."
            : "Paste the observed line; the connect-code names which assumption broke.",
      ),
    );
    return undefined;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const audit = auditMessage(bytes, proto.GET_CASCADE_MODEL_CONFIGS_RESPONSE);
  const decoded = wire.decodeMessage(proto.GET_CASCADE_MODEL_CONFIGS_RESPONSE, bytes);
  const models = (decoded.clientModelConfigs || [])
    .filter((config) => !config.disabled)
    .map((config) => ({
      id: config.modelUid,
      label: config.label || config.modelUid,
      premium: Boolean(config.isPremium),
      beta: Boolean(config.isBeta),
    }))
    .filter((model) => model.id);

  report.addAll(modelListChecks({ models, census: fieldCensus(audit), httpStatus: response.status }));
  for (const model of models.slice(0, 40)) {
    const notes = [model.premium ? "premium" : undefined, model.beta ? "beta" : undefined].filter(Boolean).join(", ");
    report.info("model", `${model.id}${notes ? `  (${notes})` : ""}`);
  }
  if (models.length > 40) report.info("model", `…and ${models.length - 40} more`);
  return { session, baseUrl, models };
}

function liveChatRequest(args, model) {
  const chat = {
    model,
    max_tokens: args.maxTokens,
    messages: [
      { role: "system", content: "You are a test harness. Answer in one short sentence." },
      {
        role: "user",
        content: args.tools ? "Call the ping tool with value 1." : "Reply with the word: ready",
      },
    ],
  };
  if (args.tools) {
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
  return chat;
}

async function runLiveStage(report, provider, args, context, fetchImpl) {
  const { proto, wire, turn, connect } = provider;
  const model = args.model || context.models[0]?.id;
  if (!model) {
    report.fail("live turn", "no model to test", { fix: "Pass --model <uid> with a uid from the free run." });
    return;
  }
  if (args.model && context.models.length && !context.models.some((entry) => entry.id === args.model)) {
    report.warn("live turn", "the requested model is not in the list this account advertises", { observed: args.model });
  }

  const chat = liveChatRequest(args, model);
  const message = turn.buildChatMessageRequest(chat, { token: context.session.apiKey, modelUid: model });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let response;
  try {
    response = await fetchImpl(requestUrl(context.baseUrl, proto.SERVICE_PATH, proto.GET_CHAT_MESSAGE), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        "connect-accept-encoding": "identity",
        authorization: connect.connectAuthorization(context.session.apiKey),
      },
      body: encodeEnvelope(wire.encodeMessage(proto.GET_CHAT_MESSAGE_REQUEST, message)),
      duplex: "half",
    });
  } catch (error) {
    clearTimeout(timer);
    report.fail("live turn", `the request never reached the upstream: ${error.message}`, { observed: hostOf(context.baseUrl) });
    return;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const failure = await describeHttpFailure(response);
    report.add(
      failureCheck(
        "live turn",
        failure,
        failure.code === "invalid_argument"
          ? "`invalid_argument` is the request shape being wrong. The message text usually names the field; paste it verbatim."
          : failure.code === "permission_denied" || failure.code === "failed_precondition"
            ? "This is often a team setting: `disable_cascade` or an `allowed_model_uids` list. Say which plan you are on."
            : "Paste the observed line.",
      ),
    );
    return;
  }
  report.info("live response", `http=${response.status} content-type=${response.headers?.get?.("content-type") || "(none)"}`);

  const scanner = createEnvelopeScanner();
  const rawChunks = [];
  const frames = [];
  const audits = [];
  let terminator;
  let text = "";
  let thinking = "";
  const toolCalls = [];
  let stopReason;
  let usage;
  let actualModelUid;
  let requestId;

  try {
    for await (const chunk of response.body) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      rawChunks.push(bytes);
      for (const frame of scanner.push(bytes)) {
        frames.push(frame);
        if (frame.endOfStream) {
          terminator = parseEndStreamPayload(frame.payload);
          continue;
        }
        if (frame.compressed) continue;
        audits.push(auditMessage(frame.payload, proto.GET_CHAT_MESSAGE_RESPONSE));
        const decoded = wire.decodeMessage(proto.GET_CHAT_MESSAGE_RESPONSE, frame.payload);
        if (decoded.deltaText) text += decoded.deltaText;
        if (decoded.deltaThinking) thinking += decoded.deltaThinking;
        for (const call of decoded.deltaToolCalls || []) toolCalls.push(call);
        if (decoded.stopReason !== undefined) stopReason = decoded.stopReason;
        if (decoded.usage) usage = provider.turn.usageFrom(decoded.usage);
        if (decoded.actualModelUid) actualModelUid = decoded.actualModelUid;
        if (decoded.requestId) requestId = decoded.requestId;
      }
    }
  } catch (error) {
    report.fail("live turn", `the stream ended early: ${error.message}`, {
      observed: `${frames.length} frame(s) read, ${scanner.pending} byte(s) unframed`,
    });
  } finally {
    clearTimeout(timer);
  }

  const census = fieldCensus(audits);
  report.addAll(
    streamFrameChecks({ frames, pending: scanner.pending, sawEndOfStream: scanner.sawEndOfStream, terminator }),
  );
  report.addAll(
    liveTurnChecks({
      model,
      text,
      thinking,
      toolCalls,
      stopReason,
      usage,
      actualModelUid,
      requestId,
      census,
      wantsTools: args.tools,
    }),
  );
  report.addAll(
    toolCallChecks({
      wantsTools: args.tools,
      toolCalls,
      stopReason,
      functionCallStopReason: proto.STOP_REASON?.FUNCTION_CALL,
      census,
      text,
    }),
  );
  if (census.length) {
    report.info(
      "field census",
      census.map((row) => `${row.path.length ? `${row.path.join(".")}.` : ""}${row.no}:${row.name ?? "UNKNOWN"}`).join(" "),
    );
  }
  if (text.trim()) report.info("model said", truncateForReport(text.trim(), 200));

  await replayThroughTransport(report, provider, rawChunks, {
    messages: frames.filter((frame) => !frame.endOfStream).length,
    text,
    // A stream that ended in an error must make the transport throw. Replaying
    // it and calling that throw a transport fault would send a tester chasing a
    // defect that is not there.
    expectThrow: Boolean(terminator?.error),
  });
}

// The stages above read the wire directly, on purpose: a probe must not test a
// transport with the transport. Replaying the captured bytes through the
// shipped client afterwards is free, spends nothing, and is the only way to
// show that the code a routed turn will actually run agrees with what arrived.
async function replayThroughTransport(report, provider, rawChunks, expected) {
  if (!rawChunks.length) {
    report.skip("transport replay", "no bytes were captured to replay");
    return;
  }
  const { proto, connect } = provider;
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    body: (async function* body() {
      for (const chunk of rawChunks) yield chunk;
    })(),
  });
  let replayed = 0;
  let replayedText = "";
  try {
    for await (const message of connect.connectServerStream({
      baseUrl: "https://replay.invalid",
      service: proto.SERVICE_PATH,
      method: proto.GET_CHAT_MESSAGE,
      token: "replay",
      requestSchema: proto.GET_CHAT_MESSAGE_REQUEST,
      responseSchema: proto.GET_CHAT_MESSAGE_RESPONSE,
      message: {},
      fetchImpl: fakeFetch,
    })) {
      replayed += 1;
      if (message.deltaText) replayedText += message.deltaText;
    }
  } catch (error) {
    report.add(
      expected.expectThrow
        ? {
            status: "pass",
            name: "transport replay",
            detail: "the shipped transport raised the error the stream terminator carried, as it must",
            observed: truncateForReport(error.message, 160),
          }
        : {
            status: "fail",
            name: "transport replay",
            detail: `the shipped transport rejected bytes the upstream actually sent: ${error.message}`,
            observed: `${replayed} of ${expected.messages} message(s) before the failure`,
          },
    );
    return;
  }
  if (expected.expectThrow) {
    report.fail("transport replay", "the stream carried an error the shipped transport did not raise", {
      expected: "the terminator's error to surface as a thrown failure",
      observed: `${replayed} message(s) yielded, no error`,
    });
    return;
  }
  report.add(
    replayed === expected.messages && replayedText === expected.text
      ? { status: "pass", name: "transport replay", detail: `the shipped transport reproduced all ${replayed} message(s) from the captured bytes` }
      : {
          status: "fail",
          name: "transport replay",
          detail: "the shipped transport read the captured bytes differently than a direct read of the same bytes",
          expected: `${expected.messages} message(s), ${expected.text.length} char(s)`,
          observed: `${replayed} message(s), ${replayedText.length} char(s)`,
        },
  );
}

// Every outside edge is injectable so the probe's own wiring -- which stage
// runs, which check fires on which observation -- is exercised in CI against a
// fabricated upstream, on a machine with neither an account nor the provider.
export async function runProbe(argv = [], { provider: injected, fetchImpl = fetch, stdout = process.stdout, cliVersion = devinCliVersion } = {}) {
  const args = parseProbeArgs(argv);
  if (args.help) {
    stdout.write(USAGE);
    return { code: 0, report: undefined };
  }
  const report = new ProbeReport({
    title: "codex-router devin-cli probe",
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      os: `${os.type()} ${os.release()}`,
      "devin cli": cliVersion(),
      mode: args.live ? (args.tools ? "--live --tools" : "--live") : "free",
    },
  });

  for (const problem of args.errors) report.fail("arguments", problem);
  if (args.unknown.length) {
    report.fail("arguments", "unrecognised argument; the run below is not the one you asked for", {
      observed: args.unknown.join(" "),
      fix: `Did you mean --tools? ${USAGE.split("\n")[0]}`,
    });
  }

  const provider = injected || (await loadProvider());
  if (provider.missing) {
    report.fail("devin provider sources", `${provider.missing} is not present in this checkout`, {
      observed: truncateForReport(provider.reason, 160),
      fix: "The provider lands with PR #271: `git fetch origin feat/devin-cli-provider && git checkout feat/devin-cli-provider`, then merge this branch on top. See docs/DEVIN-CLI-PROBE.md.",
    });
  } else if (!report.failed) {
    const context = await runFreeStage(report, provider, args, fetchImpl);
    if (context && args.live) await runLiveStage(report, provider, args, context, fetchImpl);
    else if (context) {
      report.skip("live turn", "not attempted; re-run with --live to spend one short turn of ACU credit");
    }
  }

  if (args.json) {
    stdout.write(`${JSON.stringify(report.toJson(), null, 2)}\n`);
  } else {
    stdout.write(report.render());
    stdout.write("\nPaste everything between the fences into the issue:\n\n");
    stdout.write(report.pasteBlock());
  }
  return { code: report.exitCode(), report };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runProbe(process.argv.slice(2))
    .then(({ code }) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`FAIL  probe crashed: ${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
