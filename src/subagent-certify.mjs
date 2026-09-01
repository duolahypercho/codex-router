// Runs the five live checks from v2_agent/README.md against one route.
//
// The router already refuses to promote a route on anything less than all five
// (see `verifiedForRoute`), so this module's only job is to produce an honest
// result for each one. Every check is evidence a reviewer would reproduce by
// hand: two cheap HTTP turns, then the delegation itself through a real Codex
// parent, then a same-thread follow-up to that same child.
//
// The decision logic is deliberately separated from the live calls so the part
// that decides whether a route is promotable can be tested without spending a
// provider's quota.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routedAgentDefinition } from "./codex-agent-catalog.mjs";
import { spawnableCommand } from "./codex-binary.mjs";
import { VERIFICATION_CHECKS } from "./subagent-proofs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHECK_LABELS = Object.freeze({
  streaming: "streamed reply",
  toolCall: "tool call",
  encryptedRelay: "subagent delegation",
  markerReturn: "subagent reply",
  sameThreadFollowUp: "second subagent turn",
});

function pending() {
  const checks = {};
  for (const name of VERIFICATION_CHECKS) checks[name] = { outcome: "pending" };
  return checks;
}

function pass(status, at = new Date().toISOString()) {
  return { outcome: "pass", ...(status ? { status } : {}), observedAt: at };
}

function fail(detail, at = new Date().toISOString()) {
  return { outcome: "fail", ...(detail ? { detail: String(detail).slice(0, 300) } : {}), observedAt: at };
}

// These answer about the account or the moment, never about the route: rate
// limits, exhausted quota and outages clear on their own, and a missing
// credential or plan entitlement clears when the operator fixes it. Recording
// them as a refusal tells the operator their model cannot host subagents when
// all that happened was a 429.
const STATUS_ABOUT_THE_ACCOUNT = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504]);

function deferred(status, detail, at = new Date().toISOString()) {
  return {
    outcome: "deferred",
    ...(status ? { status } : {}),
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    observedAt: at,
  };
}

function httpOutcome(status, detail) {
  return STATUS_ABOUT_THE_ACCOUNT.has(status) ? deferred(status, detail) : fail(detail);
}

export function runDeferred(checks) {
  return VERIFICATION_CHECKS.some((name) => checks?.[name]?.outcome === "deferred");
}

// The first check that did not pass, in reviewer order. A run stops there, so
// this is also the reason the route was not promoted.
export function firstFailure(checks) {
  const name = VERIFICATION_CHECKS.find((check) => checks?.[check]?.outcome !== "pass");
  if (!name) return undefined;
  return { check: name, label: CHECK_LABELS[name], detail: checks?.[name]?.detail };
}

export function checksComplete(checks) {
  return VERIFICATION_CHECKS.every((name) => checks?.[name]?.outcome === "pass");
}

// A marker is generated per run and never reused. A route that echoes a
// previous run's marker, or that a cached transcript happens to contain,
// must not be able to pass on that.
export function newMarker(prefix = "CRV") {
  return `${prefix}-${randomBytes(9).toString("hex").toUpperCase()}`;
}

// What the JSONL event stream has to show for the delegation checks to hold:
// a child actually started on the agent this route owns, and the marker came
// back. A marker in the parent's own text proves nothing -- the parent can
// read the marker out of its own prompt -- so it only counts inside a child
// event, or after a child on that agent has started.
export function readDelegation(events, { agentName, marker }) {
  let childStarted = false;
  let markerReturned = false;
  for (const event of Array.isArray(events) ? events : []) {
    const text = typeof event === "string" ? event : JSON.stringify(event ?? "");
    if (!text) continue;
    if (!childStarted && text.includes(agentName)) childStarted = true;
    if (childStarted && marker && text.includes(marker)) markerReturned = true;
  }
  return { childStarted, markerReturned };
}

// Codex refuses to spawn a non-OpenAI child while the parent is signed in with
// a ChatGPT account, and says so in the parent's own message. That is a
// property of the harness and the account, not of the route -- branding the
// route "cannot run subagents" for it is the same wrong verdict as a 429.
const ACCOUNT_REFUSES_ROUTE =
  /not supported when using Codex with a ChatGPT account|isn.t supported with the current ChatGPT account/i;

export function accountRefusal(events) {
  for (const event of Array.isArray(events) ? events : []) {
    const text = typeof event === "string" ? event : JSON.stringify(event ?? "");
    if (ACCOUNT_REFUSES_ROUTE.test(text)) {
      return "Codex will not spawn this route as a subagent while signed in with a ChatGPT account.";
    }
  }
  return undefined;
}

export function parseEventLines(stdout) {
  return String(stdout || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return line;
      }
    });
}

function runCodex(args, { codexBin, codexHome, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const target = spawnableCommand(codexBin, args);
    // CodeQL conflates spawnableCommand's direct-exec and escaped Windows-batch
    // return shapes across unrelated callers. The helper rejects illegal batch
    // paths and escapes every cmd.exe metacharacter before this spawn.
    // codeql[js/shell-command-injection-from-environment]
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd,
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHome, MODEL_ROUTER_TARGET: "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

// `--ignore-user-config` means the run starts with no providers at all, so the
// child's `model_provider = "codex-router"` has to be declared here or no child
// can ever start -- which is what "no child ran on this route" was really
// reporting, for every route, regardless of the route.
function routerConfigArgs({ baseUrl, catalogPath }) {
  const args = [
    "--config",
    'model_providers.codex-router.name="Codex Router"',
    "--config",
    `model_providers.codex-router.base_url=${JSON.stringify(baseUrl)}`,
    "--config",
    'model_providers.codex-router.wire_api="responses"',
    "--config",
    "model_providers.codex-router.requires_openai_auth=true",
    "--config",
    "model_providers.codex-router.supports_websockets=false",
  ];
  if (catalogPath) args.push("--config", `model_catalog_json=${JSON.stringify(catalogPath)}`);
  return args;
}

function execArgs({ model, prompt, cwd, extra = [] }) {
  return [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "--model",
    model,
    "--config",
    "disable_response_storage=true",
    ...extra,
    "--cd",
    cwd,
    prompt,
  ];
}

// Checks 1-2. These run against the router's own authenticated endpoint rather
// than through Codex: a forced tool call with asserted arguments is the point
// of the check, and driving that through an agent turn would test the agent's
// judgement instead of the route's tool handling.
async function runHttpChecks({ slug, baseUrl, secret, timeoutMs }) {
  const results = {};
  // The caller endpoint speaks the Responses API and takes the caller key as a
  // bearer. `chat/completions` is not served here at all, so calling it
  // reported a 404 as though the route had failed the check.
  const url = `${baseUrl}/responses`;
  const headers = {
    "content-type": "application/json",
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: "Reply with the single word: ready",
        stream: true,
        max_output_tokens: 64,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    results.streaming = response.ok && text.includes("data:")
      ? pass(response.status)
      : httpOutcome(response.status, `streamed turn returned HTTP ${response.status}`);
  } catch (error) {
    // A request that never got an answer -- an abort, a timeout, a socket the
    // router closed while restarting -- proved nothing about the route. Only a
    // reply the provider actually sent can refuse one.
    results.streaming = deferred(undefined, error?.message || "the streamed turn got no answer");
  }
  if (results.streaming.outcome !== "pass") return results;

  // Forced first, because a forced call is the strongest evidence and what the
  // application asks for. But a reasoning route can reject the forcing mode
  // itself -- "Thinking mode does not support this tool_choice" -- while
  // calling the tool perfectly well when simply offered it. Codex does not
  // force tool_choice in ordinary use, so refusing the route over the forcing
  // mode would fail it for something it is never asked to do.
  const toolProbe = async (choice) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: slug,
        input: 'Call codex_router_probe with token "ok". Use the tool; do not answer in prose.',
        max_output_tokens: 512,
        tools: [
          {
            type: "function",
            name: "codex_router_probe",
            description: "Return the supplied token.",
            parameters: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          },
        ],
        tool_choice: choice,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => undefined);
    const call = (payload?.output || []).find((item) => item?.type === "function_call");
    let argumentsValid = false;
    try {
      argumentsValid = typeof JSON.parse(call?.arguments ?? "").token === "string";
    } catch {
      argumentsValid = false;
    }
    return {
      status: response.status,
      ok: response.ok && call?.name === "codex_router_probe" && argumentsValid,
      sawCall: Boolean(call),
      detail: String(payload?.error?.message || "").slice(0, 300),
    };
  };

  try {
    const forced = await toolProbe({ type: "function", name: "codex_router_probe" });
    if (forced.ok) {
      results.toolCall = pass(forced.status);
    } else if (STATUS_ABOUT_THE_ACCOUNT.has(forced.status)) {
      results.toolCall = deferred(forced.status, forced.detail || `forced tool call returned HTTP ${forced.status}`);
    } else {
      const offered = await toolProbe("auto");
      if (offered.ok) {
        results.toolCall = { ...pass(offered.status), mode: "auto" };
      } else if (STATUS_ABOUT_THE_ACCOUNT.has(offered.status)) {
        results.toolCall = deferred(offered.status, offered.detail || `tool call returned HTTP ${offered.status}`);
      } else {
        results.toolCall = fail(
          offered.sawCall
            ? "the tool call did not return valid JSON arguments"
            : offered.detail || `no tool call in the reply (HTTP ${offered.status})`,
        );
      }
    }
  } catch (error) {
    results.toolCall = deferred(undefined, error?.message || "the forced tool call got no answer");
  }
  return results;
}

// Checks 3-5. A native parent is asked to delegate to the agent this route
// owns; the child has to return a marker only this run knows, and then a
// second marker on a follow-up in the same session.
async function runDelegationChecks({
  slug,
  parentModel,
  codexBin,
  codexHome,
  baseUrl,
  catalogPath,
  workDir,
  timeoutMs,
}) {
  const results = {};
  const definition = routedAgentDefinition({ slug, displayName: slug });
  // The parent is a native model signing in with this machine's ChatGPT
  // session, so the run has to use the real CODEX_HOME. A throwaway home has
  // no credentials, and an unauthenticated parent cannot delegate anything.
  const agentsDir = path.join(codexHome, "agents");
  const agentFile = path.join(agentsDir, definition.fileName);
  const preExisting = existsSync(agentFile);
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  if (!preExisting) {
    // The route is not v2 yet, so the catalog has not written its definition.
    // The check needs the child spawnable without promoting anything first,
    // and the file goes away again below unless it was already there.
    writeFileSync(agentFile, definition.contents, { encoding: "utf8", mode: 0o600 });
  }

  // Codex only offers a subagent for a route its catalog marks v2, which is
  // the very thing this run exists to establish. Give the run a private copy
  // of the catalog with just this candidate marked, so the delegation can be
  // attempted without the real catalog ever claiming anything.
  let runCatalog = catalogPath;
  if (catalogPath && existsSync(catalogPath)) {
    try {
      const data = JSON.parse(readFileSync(catalogPath, "utf8"));
      const entries = Array.isArray(data) ? data : data?.models || [];
      let marked = 0;
      for (const entry of entries) {
        if (String(entry?.slug || entry?.id || "") === String(slug)) {
          entry.multi_agent_version = "v2";
          marked += 1;
        }
      }
      if (marked) {
        runCatalog = path.join(workDir, "candidate-catalog.json");
        writeFileSync(runCatalog, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
      }
    } catch {
      // An unreadable catalog leaves the run on the published one; the
      // delegation will simply report that no child ran.
    }
  }
  const config = routerConfigArgs({ baseUrl, catalogPath: runCatalog });
  try {
    const marker = newMarker();
    const first = await runCodex(
      execArgs({
        model: parentModel,
        cwd: workDir,
        extra: config,
        prompt:
          `Delegate to the agent named ${definition.agentName}. Instruct that agent to reply with exactly ${marker}. ` +
          "Do not answer yourself and do not repeat the token in your own message; report only what the agent returned.",
      }),
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const firstEvents = parseEventLines(first.stdout);
    const firstDelegation = readDelegation(firstEvents, {
      agentName: definition.agentName,
      marker,
    });
    const refusal = accountRefusal(firstEvents);
    results.encryptedRelay = firstDelegation.childStarted
      ? pass(200)
      : refusal
        ? deferred(undefined, refusal)
        // A parent killed at the ceiling never finished asking. That is the run
        // running out of time, not the route refusing to host a child.
        : first.timedOut
          ? deferred(undefined, "the parent did not finish delegating before the timeout")
          : fail("no child ran on this route");
    if (!firstDelegation.childStarted) return { results, agentName: definition.agentName };

    results.markerReturn = firstDelegation.markerReturned
      ? pass(200)
      : fail("the child ran but did not return the marker");
    if (!firstDelegation.markerReturned) return { results, agentName: definition.agentName };

    const followUpMarker = newMarker("CRV2");
    const second = await runCodex(
      [
        "exec",
        "resume",
        "--last",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--json",
        "--config",
        "disable_response_storage=true",
        ...config,
        "--cd",
        workDir,
        `Ask the same ${definition.agentName} agent, in this same thread, to reply with exactly ${followUpMarker}.`,
      ],
      { codexBin, codexHome, timeoutMs, cwd: workDir },
    );
    const secondDelegation = readDelegation(parseEventLines(second.stdout), {
      agentName: definition.agentName,
      marker: followUpMarker,
    });
    results.sameThreadFollowUp = secondDelegation.markerReturned
      ? pass(200)
      : fail("the child did not answer a second turn in the same thread");
    return { results, agentName: definition.agentName };
  } finally {
    // Leave the agents directory exactly as it was found. A definition left
    // behind would keep an uncertified route spawnable by name.
    if (!preExisting) rmSync(agentFile, { force: true });
  }
}

// One route, all five checks, stopping at the first failure so a route that
// cannot stream never spends quota on a delegation.
export async function verifySubagentRoute(
  slug,
  {
    baseUrl,
    secret,
    codexBin,
    codexHome,
    parentModel = "gpt-5.6-sol",
    catalogPath,
    routerVersion,
    timeoutMs = 120_000,
  } = {},
) {
  const checks = pending();
  const started = Date.now();
  const http = await runHttpChecks({ slug, baseUrl, secret, timeoutMs });
  Object.assign(checks, http);
  if (checks.streaming.outcome !== "pass" || checks.toolCall.outcome !== "pass") {
    return { slug, checks, ok: false, routerVersion, durationMs: Date.now() - started };
  }

  // Only the working directory is disposable. The Codex home stays real so the
  // parent can authenticate.
  const workDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-certify-"));
  try {
    const { results } = await runDelegationChecks({
      slug,
      parentModel,
      codexBin,
      codexHome,
      baseUrl,
      catalogPath,
      workDir,
      timeoutMs,
    });
    Object.assign(checks, results);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return {
    slug,
    checks,
    ok: checksComplete(checks),
    routerVersion,
    durationMs: Date.now() - started,
  };
}
