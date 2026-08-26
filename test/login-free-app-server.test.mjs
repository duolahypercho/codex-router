import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codexCandidatePaths, findCodexBinary } from "../src/codex-binary.mjs";
import { spawnableCommand } from "../src/spawnable-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "src", "config-manager.mjs");
const CALLER_KEY = "test-login-free-app-server-caller-capability";
const MARKER = "SIGNED_OUT_LOGIN_FREE_OK";

function cleanCredentialEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT_ID",
  ]) {
    delete env[name];
  }
  return env;
}

function codexSync(binary, args, env) {
  const target = spawnableCommand(binary, args);
  return execFileSync(target.command, target.args, {
    ...target.options,
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 15_000,
    windowsHide: true,
  });
}

function managerSync(command, args, env) {
  return JSON.parse(
    execFileSync(process.execPath, [manager, command, ...args], {
      cwd: root,
      encoding: "utf8",
      env,
      timeout: 15_000,
    }),
  );
}

function responseStream(model) {
  return [
    `data: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_login_free", status: "in_progress", model, output: [] },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        id: "msg_login_free",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.content_part.added",
      sequence_number: 2,
      output_index: 0,
      content_index: 0,
      item_id: "msg_login_free",
      part: { type: "output_text", text: "", annotations: [] },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      sequence_number: 3,
      output_index: 0,
      content_index: 0,
      item_id: "msg_login_free",
      delta: MARKER,
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_text.done",
      sequence_number: 4,
      output_index: 0,
      content_index: 0,
      item_id: "msg_login_free",
      text: MARKER,
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.content_part.done",
      sequence_number: 5,
      output_index: 0,
      content_index: 0,
      item_id: "msg_login_free",
      part: { type: "output_text", text: MARKER, annotations: [] },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      sequence_number: 6,
      output_index: 0,
      item: {
        id: "msg_login_free",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: MARKER, annotations: [] }],
      },
    })}`,
    "",
    `data: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 7,
      response: {
        id: "resp_login_free",
        status: "completed",
        model,
        output: [{
          id: "msg_login_free",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: MARKER, annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

function runAppServerTurn(binary, env, model, modelProvider) {
  return new Promise((resolve, reject) => {
    const target = spawnableCommand(binary, ["app-server"]);
    const child = spawn(target.command, target.args, {
      ...target.options,
      cwd: root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const notifications = [];

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish(new Error(`Codex app-server turn timed out. ${stderr}`)),
      15_000,
    );

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited ${code}. ${stderr}`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.error) {
        finish(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)} ${stderr}`));
        return;
      }
      if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({
          id: 2,
          method: "thread/start",
          params: {
            approvalPolicy: "never",
            cwd: root,
            ephemeral: true,
            model,
            modelProvider,
            sandbox: "read-only",
          },
        });
        return;
      }
      if (message.id === 2) {
        send({
          id: 3,
          method: "turn/start",
          params: {
            threadId: message.result.thread.id,
            input: [{ type: "text", text: "Return the marker." }],
          },
        });
        return;
      }
      if (message.method) notifications.push(message);
      if (message.method === "turn/completed") finish(undefined, notifications);
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_router_login_free_test",
          title: "Codex Router login-free test",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

async function verifySignedOutTurn(binary, { initialProvider = "openai" } = {}) {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-router-login-free-app-server-"));
  const stateDir = path.join(codexHome, "router-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`, { mode: 0o600 });
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ body: JSON.parse(body), headers: request.headers, url: request.url });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(responseStream(requests.at(-1).body.model));
    });
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const env = cleanCredentialEnvironment({
      CODEX_BIN: binary,
      CODEX_HOME: codexHome,
      CODEX_ROUTER_PORT: String(port),
      CODEX_ROUTER_STATE_DIR: stateDir,
      MODEL_ROUTER_TARGET: "codex",
    });
    const bundled = JSON.parse(codexSync(binary, ["debug", "models", "--bundled"], env));
    const model = bundled.models[0]?.slug;
    assert.ok(model, "the installed Codex build exposes a bundled model");
    writeFileSync(
      path.join(stateDir, "merged-models.json"),
      `${JSON.stringify(bundled)}\n`,
      { mode: 0o600 },
    );
    if (initialProvider !== "openai") {
      writeFileSync(
        path.join(codexHome, "config.toml"),
        `model_provider = ${JSON.stringify(initialProvider)}\n\n` +
          `[model_providers.${initialProvider}]\n` +
          `name = "Direct test provider"\n` +
          `base_url = "https://direct.invalid/v1"\n` +
          `wire_api = "responses"\n`,
        { mode: 0o600 },
      );
    }

    managerSync("enable", [], env);
    const enabled = managerSync("login-free-enable", [model], env);
    const expectedProvider = initialProvider === "openai" ? "codex-router" : initialProvider;
    assert.equal(enabled.model_provider, expectedProvider);
    assert.equal(enabled.login_free, true);
    assert.equal(existsSync(path.join(codexHome, "auth.json")), false);
    const config = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(config, new RegExp(`^model_provider = ${JSON.stringify(expectedProvider)}$`, "m"));
    assert.match(config, new RegExp(`\\[model_providers\\.${expectedProvider}\\]`));
    assert.doesNotMatch(config, /\[model_providers\.openai\]/);
    if (initialProvider !== "openai") {
      assert.match(config, /requires_openai_auth = false/);
      assert.doesNotMatch(config, /direct\.invalid/);
    }

    const notifications = await runAppServerTurn(binary, env, model, expectedProvider);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/_codex-router\/[^/]+\/v1\/responses$/);
    assert.equal(requests[0].headers.authorization, undefined);
    assert.equal(requests[0].body.model, model);
    assert.match(JSON.stringify(notifications), new RegExp(MARKER));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(codexHome, { recursive: true, force: true });
  }
}

test("real Codex app-server completes signed-out turns through fallback and preserved providers", async (t) => {
  const candidates = [...new Set(
    [findCodexBinary(), ...codexCandidatePaths()]
      .filter((candidate) => candidate && existsSync(candidate))
      .map((candidate) => realpathSync(candidate)),
  )];
  const binaries = candidates.flatMap((binary) => {
    try {
      return [{
        binary,
        version: codexSync(binary, ["--version"], cleanCredentialEnvironment()).trim(),
      }];
    } catch {
      return [];
    }
  });
  if (binaries.length === 0) {
    t.skip("a real Codex binary is not installed");
    return;
  }
  for (const { binary, version } of binaries) {
    await t.test(`${version} root-openai fallback`, () => verifySignedOutTurn(binary));
    await t.test(`${version} preserved custom provider`, () =>
      verifySignedOutTurn(binary, { initialProvider: "custom" }));
  }
});
