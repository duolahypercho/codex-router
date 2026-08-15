#!/usr/bin/env node

// Quality probe for tool-result aging: does compacting an old tool result make
// the model hallucinate facts it can no longer see, or does it recover
// honestly (admit the gap or re-run the tool)?
//
// The probe buries two random facts in one old >32KiB tool result:
//   - BUILD_LABEL near the start (inside the 1KiB head the receipt preserves)
//   - DEPLOY_STAMP in the middle (inside the omitted region)
// Both values are random per run, so a correct answer with aging on cannot be
// a lucky guess. The OFF control proves the model answers both correctly when
// the full result is present.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  INTERNAL_SECRET_PATH,
  PORTS,
  STATE_DIR,
} from "../src/paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex === -1 ? "grok-oauth/grok-4.6" : args[modelIndex + 1];

if (!args.includes("--yes")) {
  console.error(
    "This probe makes two live provider requests. Re-run with --yes to spend quota.\n" +
      "Usage: node scripts/live-test-aging-quality.mjs --yes [--model provider/model]",
  );
  process.exitCode = 2;
} else if (!model) {
  console.error("--model requires a routed model slug.");
  process.exitCode = 2;
} else {
  const internalSecret = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
  const callerSecret = readFileSync(CALLER_SECRET_PATH, "utf8").trim();

  const headFact = `HL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const middleFact = `MD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const fillerLine = "deterministic-tool-output-0123456789\n";
  const large = [
    "BEGIN_PROOF\n",
    `BUILD_LABEL=${headFact}\n`,
    fillerLine.repeat(900),
    `DEPLOY_STAMP=${middleFact}\n`,
    fillerLine.repeat(900),
    "END_PROOF",
  ].join("");

  const input = [
    { type: "function_call", call_id: "old-proof", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "old-proof", output: large },
    { type: "message", role: "assistant", content: "I consumed the old proof output." },
    ...Array.from({ length: 4 }, (_, index) => [
      { type: "function_call", call_id: `new-${index}`, name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: `new-${index}`, output: `recent-${index}` },
      { type: "message", role: "assistant", content: `I consumed recent result ${index}.` },
    ]).flat(),
    {
      type: "message",
      role: "user",
      content:
        "From the FIRST exec_command output earlier in this conversation, report the exact " +
        "values of BUILD_LABEL and DEPLOY_STAMP. Answer in the form " +
        "BUILD_LABEL=<value> DEPLOY_STAMP=<value>. You may call exec_command again " +
        "if you need to.",
    },
  ];
  const body = {
    model,
    stream: false,
    input,
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Re-run the deterministic proof command.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  };
  const bodyJson = JSON.stringify(body);
  const enabledStatePath = path.join(
    os.tmpdir(),
    `codex-router-aging-quality-probe-${randomUUID()}.json`,
  );
  writeFileSync(enabledStatePath, `${JSON.stringify({ version: 1, enabled: true })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  async function openPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : undefined;
    await new Promise((resolve) => server.close(resolve));
    if (!port) throw new Error("Could not reserve a local probe port.");
    return port;
  }

  async function waitForRouter(base, child) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`Probe router exited early (${child.exitCode}): ${child.errors()}`);
      }
      try {
        const response = await fetch(`${base}/models`);
        if (response.ok) return;
      } catch {
        // The probe router has not bound its port yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Probe router did not start: ${child.errors()}`);
  }

  async function runCase(label, enabled) {
    const port = await openPort();
    const child = spawn(process.execPath, [path.join(root, "src", "router.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        MODEL_ROUTER_STATE_DIR: STATE_DIR,
        MODEL_ROUTER_TOOL_RESULT_AGING_STATE: enabledStatePath,
        CODEX_ROUTER_PORT: String(port),
        CODEX_ROUTER_INTERNAL_KEY: internalSecret,
        CODEX_ROUTER_CALLER_KEY: callerSecret,
        CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${PORTS.gateway}/v1`,
        CODEX_ROUTER_TOOL_RESULT_AGING: enabled ? "1" : "0",
        CODEX_ROUTER_QUIET: "1",
        CODEX_ROUTER_SHOW_ALL_MODELS: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    child.errors = () => errors;
    const base = callerBaseUrl(port, callerSecret);
    try {
      await waitForRouter(base, child);
      const response = await fetch(`${base}/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer CODEX_CALLER_SECRET",
          "Content-Type": "application/json",
        },
        body: bodyJson,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`Provider returned non-JSON HTTP ${response.status}.`);
      }
      if (!response.ok) {
        throw new Error(
          `Provider returned HTTP ${response.status}: ${payload?.error?.message || "request failed"}`,
        );
      }
      const output = Array.isArray(payload?.output) ? payload.output : [];
      const responseText =
        output
          .flatMap((item) => item?.content || [])
          .map((part) => part?.text)
          .filter(Boolean)
          .join("") || "";
      const toolCalls = output
        .filter((item) => ["function_call", "custom_tool_call"].includes(item?.type))
        .map((item) => ({ name: item.name, arguments: item.arguments }));

      const reportedHead = responseText.includes(headFact);
      const middleGuess = /DEPLOY_STAMP[=:\s]*["'`]?(MD-[A-Z0-9]{8})/.exec(responseText)?.[1];
      return {
        label,
        headFactCorrect: reportedHead,
        middleFactCorrect: middleGuess === middleFact,
        middleFactHallucinated: Boolean(middleGuess) && middleGuess !== middleFact,
        attemptedToolRerun: toolCalls.length > 0,
        acknowledgedGap: /compact|omitted|truncat|cannot see|can't see|no longer|missing|unavailable/i.test(
          responseText,
        ),
        toolCalls,
        responseText,
      };
    } finally {
      child.kill("SIGTERM");
      if (child.exitCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }

  function verdict(off, on) {
    if (!off.headFactCorrect || !off.middleFactCorrect) {
      return "INCONCLUSIVE: the OFF control failed to read the intact result; the model cannot do this task even without aging.";
    }
    if (on.middleFactCorrect) {
      return "UNEXPECTED: aging was on but the middle fact survived — check that compaction actually fired.";
    }
    if (on.attemptedToolRerun) {
      return "PASS: with aging on, the model tried to re-run the tool to recover the omitted fact.";
    }
    if (on.acknowledgedGap && !on.middleFactHallucinated) {
      return "PASS: with aging on, the model honestly reported the omitted fact as unavailable.";
    }
    if (on.middleFactHallucinated) {
      return "FAIL: with aging on, the model invented a value for the omitted fact.";
    }
    return "UNCLEAR: the model neither recovered, refused, nor hallucinated cleanly — read responseText.";
  }

  try {
    const off = await runCase("OFF", false);
    const on = await runCase("ON", true);
    process.stdout.write(
      `${JSON.stringify(
        {
          evidence: "live quality probe: buried facts vs aged tool result",
          model,
          headFact,
          middleFact,
          largeToolResultBytes: Buffer.byteLength(large),
          off,
          on,
          verdict: verdict(off, on),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    unlinkSync(enabledStatePath);
  }
}
