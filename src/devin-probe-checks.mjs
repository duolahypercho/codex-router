// The judgements the Devin CLI probe makes, with no I/O and no dependency on
// the provider's schemas, so every one of them is exercised in CI on a machine
// that has no Devin account.
//
// The probe itself only fetches bytes and hands the observations here. Keeping
// the reasoning separate is what lets the interesting cases -- an upstream that
// says it called a function while the decoder produced none, a model list that
// decoded to nothing, a tool call with no id -- be tested against fabricated
// observations instead of waiting on a volunteer.

import { describeCensusRow } from "./protobuf-audit.mjs";
import { truncateForReport } from "./probe-report.mjs";

export const DEFAULT_MAX_TOKENS = 64;
export const DEFAULT_TIMEOUT_MS = 90_000;

const KNOWN_FLAGS = new Set(["--live", "--tools", "--json", "--help", "-h", "--model", "--max-tokens", "--timeout"]);

// Unknown flags are reported rather than ignored. The published instructions
// ask for `--live --tools`; a tester who types `--tool` must not get a run that
// silently skips the only check that matters and then prints a pass.
export function parseProbeArgs(argv = []) {
  const args = [...argv];
  const parsed = {
    live: false,
    tools: false,
    json: false,
    help: false,
    model: undefined,
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    unknown: [],
    errors: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live") parsed.live = true;
    else if (arg === "--tools") parsed.tools = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--model" || arg === "--max-tokens" || arg === "--timeout") {
      const value = args[index + 1];
      index += 1;
      if (value === undefined || KNOWN_FLAGS.has(value)) {
        parsed.errors.push(`${arg} needs a value`);
        continue;
      }
      if (arg === "--model") parsed.model = value;
      else if (arg === "--max-tokens") {
        const tokens = Number(value);
        if (!Number.isFinite(tokens) || tokens <= 0) parsed.errors.push(`--max-tokens needs a positive number, got ${value}`);
        else parsed.maxTokens = Math.floor(tokens);
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) parsed.errors.push(`--timeout needs a positive number of seconds, got ${value}`);
        else parsed.timeoutMs = Math.floor(seconds * 1_000);
      }
    } else parsed.unknown.push(arg);
  }
  return parsed;
}

function censusList(rows, limit = 8) {
  if (!rows.length) return "none";
  const described = rows.slice(0, limit).map(describeCensusRow);
  return rows.length > limit ? `${described.join("; ")}; …and ${rows.length - limit} more` : described.join("; ");
}

// The encoded request is auditable before anything is sent, which turns the
// free run into a real check of the writer rather than a credential test.
export function requestShapeChecks({ audit, requiredFields = [] }) {
  const checks = [];
  if (!audit) {
    checks.push({ status: "skip", name: "request encoding", detail: "no request was built" });
    return checks;
  }
  if (audit.truncated) {
    checks.push({
      status: "fail",
      name: "request encoding",
      detail: "the request this build produced does not re-read as valid protobuf",
      observed: audit.error || "truncated",
      fix: "This is a defect in the router's own encoder, not in the account. Paste this line into the issue.",
    });
    return checks;
  }
  const present = new Set(audit.matched.map((entry) => entry.name));
  const missing = requiredFields.filter((name) => !present.has(name));
  checks.push(
    missing.length
      ? {
          status: "fail",
          name: "request encoding",
          detail: "the request omits fields the upstream is expected to require",
          expected: requiredFields.join(", "),
          observed: `missing ${missing.join(", ")}`,
        }
      : {
          status: "pass",
          name: "request encoding",
          detail: `${audit.matched.length} field(s) written, ${audit.size} bytes, all on their declared wire types`,
        },
  );
  if (audit.mismatched.length) {
    checks.push({
      status: "fail",
      name: "request wire types",
      detail: "a field was written on a wire type its own schema does not declare",
      observed: censusList(audit.mismatched),
    });
  }
  return checks;
}

export function modelListChecks({ models = [], census = [], httpStatus } = {}) {
  const checks = [];
  const unknown = census.filter((row) => row.status === "unknown");
  const mismatched = census.filter((row) => row.status === "mismatched");

  if (!models.length) {
    // The old probe printed "OK: account advertises 0 model(s)" here. Zero is
    // the exact symptom of a renumbered `modelUid`, an entitlement of nothing,
    // or a response this build cannot read -- never a success.
    checks.push({
      status: "fail",
      name: "model list",
      detail: "the account advertised no usable model",
      expected: "at least one enabled model with a model_uid",
      observed: census.length
        ? `response carried ${census.length} field group(s): ${censusList(census)}`
        : `response decoded to nothing (HTTP ${httpStatus ?? "?"})`,
      fix: "If the response carried fields this build calls UNKNOWN, the ClientModelConfig field numbers have moved. If it carried nothing, the account or plan entitles no Cascade model.",
    });
  } else {
    checks.push({
      status: "pass",
      name: "model list",
      detail: `${models.length} enabled model(s) decoded, each with a model_uid`,
    });
  }

  const unnamed = models.filter((model) => !model.id);
  if (unnamed.length) {
    checks.push({
      status: "fail",
      name: "model uid field",
      detail: "an advertised model decoded without a uid, so nothing can be routed to it",
      observed: `${unnamed.length} of ${models.length} entries`,
    });
  }

  if (models.length) {
    const premium = models.filter((model) => model.premium).length;
    const beta = models.filter((model) => model.beta).length;
    checks.push({
      status: "info",
      name: "entitlement flags",
      detail: `${premium} premium, ${beta} beta, ${models.length - premium - beta} standard`,
    });
  }

  if (mismatched.length) {
    checks.push({
      status: "fail",
      name: "model list wire types",
      detail: "a field arrived on a wire type this build does not expect for it",
      observed: censusList(mismatched),
    });
  }
  if (unknown.length) {
    checks.push({
      status: "warn",
      name: "model list unknown fields",
      detail: "the upstream sent fields this build does not know; harmless unless something is missing above",
      observed: censusList(unknown),
    });
  }
  return checks;
}

export function streamFrameChecks({ frames = [], pending = 0, sawEndOfStream = false, terminator } = {}) {
  const checks = [];
  const dataFrames = frames.filter((frame) => !frame.endOfStream);

  checks.push(
    dataFrames.length
      ? { status: "pass", name: "stream framing", detail: `${dataFrames.length} message frame(s) read from the response body` }
      : {
          status: "fail",
          name: "stream framing",
          detail: "the upstream accepted the request but sent no message frame",
          observed: `${frames.length} frame(s) total, ${pending} byte(s) left unframed`,
        },
  );

  const compressed = frames.filter((frame) => frame.compressed);
  checks.push(
    compressed.length
      ? {
          // The shipped client asks for `connect-accept-encoding: identity`, so
          // this should never fire. If it does, the upstream compressed anyway
          // and every turn ends in the transport's `devin_compressed_frame`
          // refusal -- loud, but no answer.
          status: "fail",
          name: "frame compression",
          detail: "the upstream compressed frames despite connect-accept-encoding: identity; this transport cannot decompress and refuses them",
          observed: `${compressed.length} of ${frames.length} frames carry the compressed flag`,
          fix: "Report this, with the encoding the upstream used. The transport would have to learn to decompress.",
        }
      : { status: "pass", name: "frame compression", detail: "no frame carried the compressed flag" },
  );

  if (pending > 0) {
    checks.push({
      status: "fail",
      name: "stream completeness",
      detail: "the response body ended part-way through a frame",
      observed: `${pending} trailing byte(s) that never formed a frame`,
    });
  }

  if (!sawEndOfStream) {
    checks.push({
      status: "fail",
      name: "end-of-stream terminator",
      detail: "the stream stopped without the terminator Connect requires",
      fix: "A turn that ends this way is indistinguishable from a truncated answer.",
    });
  } else if (terminator?.malformed) {
    checks.push({
      status: "fail",
      name: "end-of-stream terminator",
      detail: "the terminator was not the JSON object Connect specifies",
      observed: truncateForReport(terminator.text),
    });
  } else if (terminator?.error) {
    checks.push({
      status: "fail",
      name: "end-of-stream terminator",
      detail: `the upstream ended the stream with an error after sending HTTP 200: ${terminator.error.message || "(no message)"}`,
      observed: `code=${terminator.error.code || "(none)"} known=${terminator.error.known} retriable=${terminator.error.retriable} mapped-status=${terminator.error.status}`,
    });
  } else {
    checks.push({ status: "pass", name: "end-of-stream terminator", detail: "clean terminator, no error carried" });
  }
  return checks;
}

export function liveTurnChecks({
  model,
  text = "",
  thinking = "",
  toolCalls = [],
  stopReason,
  usage,
  actualModelUid,
  requestId,
  census = [],
  wantsTools = false,
} = {}) {
  const checks = [];
  const produced = text.length + thinking.length + toolCalls.length;

  checks.push(
    produced
      ? {
          status: "pass",
          name: "turn produced output",
          detail: `${text.length} content char(s), ${thinking.length} reasoning char(s), ${toolCalls.length} tool call(s)`,
        }
      : {
          // The old probe printed "OK: streamed 0 character(s)" for this.
          status: "fail",
          name: "turn produced output",
          detail: "frames arrived but decoded to no content, no reasoning and no tool call",
          expected: "at least one of deltaText, deltaThinking or deltaToolCalls",
          observed: census.length ? `fields seen: ${censusList(census)}` : "the frames carried no readable field at all",
          fix: "Any UNKNOWN field above is the likely renumbering. Paste the whole census line.",
        },
  );

  if (stopReason === undefined) {
    checks.push({
      status: "warn",
      name: "stop reason",
      detail: "no stop reason arrived, so the finish_reason the router reports is a guess",
    });
  } else {
    checks.push({
      status: "info",
      name: "stop reason",
      detail: `upstream stop reason ${stopReason}`,
      observed: String(stopReason),
    });
  }

  const promptTokens = Number(usage?.prompt_tokens || 0);
  const completionTokens = Number(usage?.completion_tokens || 0);
  checks.push(
    promptTokens || completionTokens
      ? {
          status: "pass",
          name: "usage accounting",
          detail: `prompt ${promptTokens}, completion ${completionTokens}`,
        }
      : {
          status: "warn",
          name: "usage accounting",
          detail: "no token counts decoded; the router will report a turn with no usage",
          observed: usage ? truncateForReport(usage) : "no usage message on the stream",
        },
  );

  if (actualModelUid && model && actualModelUid !== model) {
    checks.push({
      status: "warn",
      name: "served model",
      detail: "the upstream served a different model than the one requested",
      expected: model,
      observed: actualModelUid,
    });
  } else if (actualModelUid) {
    checks.push({ status: "pass", name: "served model", detail: `upstream confirmed ${actualModelUid}` });
  } else {
    checks.push({
      status: "warn",
      name: "served model",
      detail: "the upstream did not name the model that served the turn",
    });
  }

  if (requestId) checks.push({ status: "info", name: "upstream request id", detail: requestId });
  if (!wantsTools) {
    checks.push({
      status: "skip",
      name: "tool calls",
      detail: "not attempted; re-run with --live --tools, which is the check that decides whether Codex can use this provider",
    });
  }
  return checks;
}

// The failure this exists for: a tool call that never decodes looks exactly
// like a model that declined to call one, and the old probe reported both the
// same way. Three signals separate them, and each gets its own line.
export function toolCallChecks({
  wantsTools = false,
  toolCalls = [],
  stopReason,
  functionCallStopReason,
  census = [],
  text = "",
} = {}) {
  if (!wantsTools) return [];
  const checks = [];
  const unknown = census.filter((row) => row.status === "unknown");
  const claimedFunctionCall =
    functionCallStopReason !== undefined && stopReason !== undefined && stopReason === functionCallStopReason;

  if (!toolCalls.length) {
    if (claimedFunctionCall) {
      checks.push({
        status: "fail",
        name: "tool calls decoded",
        detail:
          "the upstream reported a function-call stop reason and this build decoded no tool call — calls are being dropped on the wire, not declined by the model",
        expected: "at least one deltaToolCalls entry",
        observed: `stopReason=${stopReason}; undecoded fields: ${censusList(unknown)}`,
        fix: "This is the decisive failure. Paste this line: it means deltaToolCalls has moved off field 6 or ChatToolCall has been renumbered.",
      });
    } else if (unknown.length) {
      checks.push({
        status: "fail",
        name: "tool calls decoded",
        detail:
          "no tool call decoded, and the stream carried fields this build does not know — the call may have arrived under a field number that was skipped",
        expected: "at least one deltaToolCalls entry",
        observed: censusList(unknown),
        fix: "Paste the observed line. An UNKNOWN length-delimited field on a tool-forced turn is a renumbered deltaToolCalls until proven otherwise.",
      });
    } else {
      checks.push({
        status: "fail",
        name: "tool calls decoded",
        detail:
          "no tool call decoded, and every field on the stream was one this build knows — the model declined a forced tool choice",
        expected: "at least one deltaToolCalls entry",
        observed: text ? `the model answered in prose instead: ${truncateForReport(text, 160)}` : "the turn produced nothing",
        fix: "Either the tool_choice option name this build sends is not the one Cascade accepts, or this model cannot be forced. Try another --model before concluding the transport is wrong.",
      });
    }
    return checks;
  }

  checks.push({
    status: "pass",
    name: "tool calls decoded",
    detail: `${toolCalls.length} tool call(s): ${toolCalls.map((call) => call.name || "(unnamed)").join(", ")}`,
  });

  const unnamed = toolCalls.filter((call) => !call.name);
  if (unnamed.length) {
    checks.push({
      status: "fail",
      name: "tool call names",
      detail: "a decoded tool call carried no name, so nothing can be dispatched for it",
      observed: `${unnamed.length} of ${toolCalls.length}`,
    });
  }

  // Without ids the forwarder mints a fresh one per delta, so a restated call
  // becomes a second call and the client dispatches the same tool twice.
  const unkeyed = toolCalls.filter((call) => !call.id);
  checks.push(
    unkeyed.length
      ? {
          status: "fail",
          name: "tool call ids",
          detail: "tool calls arrived without ids; every restatement would be dispatched as an additional call",
          observed: `${unkeyed.length} of ${toolCalls.length} unkeyed`,
          fix: "Paste this. The forwarder keys restatements by id and has nothing to key on.",
        }
      : { status: "pass", name: "tool call ids", detail: "every tool call carried an id the forwarder can key on" },
  );

  const invalid = toolCalls.filter((call) => {
    if (typeof call.argumentsJson !== "string" || !call.argumentsJson.trim()) return true;
    try {
      JSON.parse(call.argumentsJson);
      return false;
    } catch {
      return true;
    }
  });
  checks.push(
    invalid.length
      ? {
          status: "fail",
          name: "tool call arguments",
          detail: "a tool call's arguments are not JSON the client could parse",
          observed: truncateForReport(invalid[0].argumentsJson ?? "(empty)"),
        }
      : { status: "pass", name: "tool call arguments", detail: "every tool call carried parseable JSON arguments" },
  );

  const seen = new Map();
  let restated = 0;
  for (const call of toolCalls) {
    if (!call.id) continue;
    if (seen.has(call.id)) restated += 1;
    seen.set(call.id, call);
  }
  if (restated) {
    checks.push({
      status: "info",
      name: "tool call restatement",
      detail: `the upstream restated ${restated} call(s); keying by id is required and is what this build does`,
    });
  }
  return checks;
}
