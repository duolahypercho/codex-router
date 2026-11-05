import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inheritedProxyEnvironment,
  proxyEnvironmentDeclared,
  recordedProxyEnvironment,
  redactProxyCredentials,
  serviceProxyOptInProblem,
  serviceProxyEnvironment,
} from "../src/proxy-environment.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function manifestWith(current) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-proxy-"));
  const file = path.join(directory, "install-manifest.json");
  writeFileSync(file, JSON.stringify({ version: 1, current, history: [] }));
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const PROXIED = Object.freeze({
  HTTP_PROXY: "http://127.0.0.1:3213",
  HTTPS_PROXY: "http://127.0.0.1:3213",
  NO_PROXY: "localhost,127.0.0.1,::1",
  NODE_USE_ENV_PROXY: "1",
});

test("an environment naming no proxy variable is silent, not a decision", () => {
  assert.equal(proxyEnvironmentDeclared({ PATH: "/usr/bin" }, []), false);
  assert.equal(proxyEnvironmentDeclared({ HTTP_PROXY: "http://p:1" }, []), true);
  // A bypass list is not a proxy declaration, and neither is an empty value.
  assert.equal(proxyEnvironmentDeclared({ no_proxy: "localhost" }, []), false);
  assert.equal(proxyEnvironmentDeclared({ HTTP_PROXY: "" }, []), false);
  // Turning the proxy off is still the operator speaking.
  assert.equal(proxyEnvironmentDeclared({ NODE_USE_ENV_PROXY: "0" }, []), true);
  // A command-line opt-in counts even when nothing is exported.
  assert.equal(proxyEnvironmentDeclared({}, ["--use-env-proxy"]), true);
});

test("a repair with no proxy environment restores what the last install recorded", () => {
  // This is the desktop case: an app launched from the Dock inherits no shell
  // environment, so without the recorded fallback the regenerated service
  // loses the proxy and every upstream call starts timing out.
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    assert.deepEqual(
      serviceProxyEnvironment({ PATH: "/usr/bin" }, { manifestPath: file }),
      { ...PROXIED },
    );
  } finally {
    cleanup();
  }
});

test("a proxy named in the environment outranks the recorded one", () => {
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    const values = serviceProxyEnvironment(
      { HTTPS_PROXY: "http://10.0.0.9:8080", NODE_USE_ENV_PROXY: "1" },
      { manifestPath: file },
    );
    assert.equal(values.HTTPS_PROXY, "http://10.0.0.9:8080");
    assert.equal(values.HTTP_PROXY, undefined);
  } finally {
    cleanup();
  }
});

test("an explicit opt-out clears a recorded proxy instead of restoring it", () => {
  // Without this, a proxy could never be removed by reinstalling: preservation
  // would silently reinstate it on every repair.
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    const values = serviceProxyEnvironment(
      { NODE_USE_ENV_PROXY: "0" },
      { manifestPath: file },
    );
    assert.deepEqual(values, { NODE_USE_ENV_PROXY: "0" });
  } finally {
    cleanup();
  }
});

test("a first install with nothing recorded behaves exactly as before", () => {
  const { file, cleanup } = manifestWith({ packageVersion: "0.0.0" });
  try {
    assert.deepEqual(serviceProxyEnvironment({ PATH: "/usr/bin" }, { manifestPath: file }), {});
    assert.deepEqual(
      serviceProxyEnvironment({ PATH: "/usr/bin" }, { manifestPath: path.join(path.dirname(file), "absent.json") }),
      {},
    );
  } finally {
    cleanup();
  }
});

test("a command-line opt-in is persisted as the environment form", () => {
  // launchd re-invokes the service without the original argv, so the decision
  // only survives as NODE_USE_ENV_PROXY.
  const values = serviceProxyEnvironment(
    { HTTPS_PROXY: "http://127.0.0.1:3213", NODE_OPTIONS: "--use-env-proxy" },
    { recorded: null },
  );
  assert.equal(values.NODE_USE_ENV_PROXY, "1");
});

test("a damaged or foreign manifest is ignored rather than trusted", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-router-proxy-"));
  try {
    const broken = path.join(directory, "broken.json");
    writeFileSync(broken, "{ not json");
    assert.equal(recordedProxyEnvironment(broken), undefined);

    const future = path.join(directory, "future.json");
    writeFileSync(future, JSON.stringify({ version: 2, current: { proxyEnvironment: PROXIED } }));
    assert.equal(recordedProxyEnvironment(future), undefined);

    // Only the known variables are restored, and only as strings, so a
    // tampered manifest cannot inject arbitrary service environment.
    const noisy = path.join(directory, "noisy.json");
    writeFileSync(noisy, JSON.stringify({
      version: 1,
      current: { proxyEnvironment: { HTTP_PROXY: "http://p:1", EVIL: "x", NO_PROXY: 7 } },
    }));
    assert.deepEqual(recordedProxyEnvironment(noisy), { HTTP_PROXY: "http://p:1" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a proxy credential is stripped for sharing while the endpoint survives", () => {
  // support-bundle.mjs sends this field to somebody else. The host and port
  // are the diagnostic value and must stay; the password must not.
  assert.deepEqual(
    redactProxyCredentials({
      HTTPS_PROXY: "http://user:secret@proxy.example:8443",
      HTTP_PROXY: "http://127.0.0.1:3213",
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    }),
    {
      HTTPS_PROXY: "http://[REDACTED]@proxy.example:8443",
      HTTP_PROXY: "http://127.0.0.1:3213",
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    },
  );
  // A schemeless `user:pass@host:port` is a form curl and Node both accept.
  assert.deepEqual(
    redactProxyCredentials({ ALL_PROXY: "user:secret@proxy.example:8443" }),
    { ALL_PROXY: "[REDACTED]@proxy.example:8443" },
  );
  // An `@` after the first `/` belongs to the path, not to userinfo.
  assert.deepEqual(
    redactProxyCredentials({ HTTP_PROXY: "http://proxy.example/a@b" }),
    { HTTP_PROXY: "http://proxy.example/a@b" },
  );
  assert.deepEqual(redactProxyCredentials(undefined), undefined);
});

test("the shared bundle carries no proxy password, from any install in history", async () => {
  const source = await import("node:fs").then(({ readFileSync: read }) =>
    read(new URL("../src/support-bundle.mjs", import.meta.url), "utf8"));
  // The raw manifest must not reach the bundle: it is the copy that leaves the
  // machine, and history entries record their own proxyEnvironment too.
  assert.match(source, /install: sharableInstallManifest\(\)/);
  assert.doesNotMatch(source, /install: readInstallManifest\(\)/);
  assert.match(source, /history\.map\(scrub\)/);
});

test("a service rendered with no proxy in the environment still carries the recorded one", () => {
  // The end-to-end shape of the desktop-repair bug: render the real macOS
  // service with every proxy variable removed, and the plist must still name
  // the proxy and the opt-in. Without both, the router dials direct and every
  // upstream call on a proxied network times out.
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-proxy-render-"));
  const stateDir = path.join(testRoot, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "install-manifest.json"),
    JSON.stringify({ version: 1, current: { proxyEnvironment: { ...PROXIED } }, history: [] }),
  );
  const stripped = { ...process.env };
  for (const name of [
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "NODE_USE_ENV_PROXY", "NODE_OPTIONS",
  ]) delete stripped[name];

  try {
    const plist = execFileSync(
      process.execPath,
      [path.join(root, "src", "service-macos.mjs"), "render"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...stripped,
          CODEX_HOME: path.join(testRoot, "codex home"),
          MODEL_ROUTER_STATE_DIR: stateDir,
          CODEX_ROUTER_STATE_DIR: stateDir,
          MODEL_ROUTER_TARGET: "codex",
          CODEX_ROUTER_SERVICE_PLATFORM: "darwin",
          MODEL_ROUTER_LAUNCH_AGENTS_DIR: path.join(testRoot, "LaunchAgents"),
        },
      },
    );
    assert.match(plist, /<key>NODE_USE_ENV_PROXY<\/key>\s*<string>1<\/string>/);
    assert.match(plist, /<key>HTTPS_PROXY<\/key>\s*<string>http:\/\/127\.0\.0\.1:3213<\/string>/);
    assert.match(plist, /<key>NO_PROXY<\/key>/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("proxy variables the router will silently ignore are reported", () => {
  // The exact misconfiguration that produced a router 502 naming a connect
  // timeout: the service definition holds the proxy and Node never uses it.
  const problem = serviceProxyOptInProblem({
    HTTP_PROXY: "http://127.0.0.1:3213",
    HTTPS_PROXY: "http://127.0.0.1:3213",
    NO_PROXY: "localhost,127.0.0.1,::1",
  });
  assert.ok(problem, "a proxy without the opt-in should be reported");
  assert.match(problem.remedy, /NODE_USE_ENV_PROXY=1/);

  // Opted in, so the proxy is actually used: nothing to report.
  assert.equal(serviceProxyOptInProblem({ ...PROXIED }), undefined);
  // A NODE_OPTIONS opt-in counts the same as the variable.
  assert.equal(
    serviceProxyOptInProblem({ HTTPS_PROXY: "http://p:1", NODE_OPTIONS: "--use-env-proxy" }),
    undefined,
  );
  // No proxy at all is not a misconfiguration, and neither is a bare bypass
  // list, which says nothing about whether a proxy is in play.
  assert.equal(serviceProxyOptInProblem({ NO_PROXY: "localhost" }), undefined);
  assert.equal(serviceProxyOptInProblem(undefined), undefined);
  // An install recorded before this field existed is unknown, not broken.
  assert.equal(serviceProxyOptInProblem({}), undefined);
});

test("a shell that exports a proxy but never mentions the opt-in keeps it", () => {
  // The gap that reinstated the bug from a terminal: an ordinary shell exports
  // HTTP_PROXY and says nothing about NODE_USE_ENV_PROXY. That silence is not
  // a decision to stop using the proxy, and reading it as one leaves the
  // variables in the service where the router quietly ignores them.
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    const values = serviceProxyEnvironment(
      {
        HTTP_PROXY: "http://127.0.0.1:3213",
        HTTPS_PROXY: "http://127.0.0.1:3213",
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
      { manifestPath: file },
    );
    assert.equal(values.NODE_USE_ENV_PROXY, "1");
    assert.equal(values.HTTPS_PROXY, "http://127.0.0.1:3213");

    // A changed address still inherits the opt-in: the operator moved the
    // proxy, they did not decide to stop using one.
    assert.equal(
      serviceProxyEnvironment({ HTTPS_PROXY: "http://10.0.0.9:8080" }, { manifestPath: file })
        .NODE_USE_ENV_PROXY,
      "1",
    );
  } finally {
    cleanup();
  }
});

test("naming the opt-in still decides it, and nothing recorded means nothing inherited", () => {
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    // Explicit 0 wins over the recorded 1 -- the escape hatch must survive.
    assert.equal(
      serviceProxyEnvironment(
        { HTTPS_PROXY: "http://127.0.0.1:3213", NODE_USE_ENV_PROXY: "0" },
        { manifestPath: file },
      ).NODE_USE_ENV_PROXY,
      "0",
    );
    // A bypass list alone leaves the environment silent, so the whole recorded
    // set comes back rather than the bypass list replacing it.
    assert.deepEqual(
      serviceProxyEnvironment({ NO_PROXY: "localhost" }, { manifestPath: file }),
      { ...PROXIED },
    );
  } finally {
    cleanup();
  }
  // A first install that never recorded an opt-in does not invent one.
  const fresh = manifestWith({ packageVersion: "0.0.0" });
  try {
    assert.equal(
      serviceProxyEnvironment({ HTTPS_PROXY: "http://p:1" }, { manifestPath: fresh.file })
        .NODE_USE_ENV_PROXY,
      undefined,
    );
  } finally {
    fresh.cleanup();
  }
});

test("a login session's bypass list does not wipe the recorded proxy", () => {
  // The exact environment a Dock-launched desktop app gets: launchd exports
  // no_proxy and nothing else. Model curation in that app re-runs bin/install,
  // so counting this as a decision rewrote the service with the bypass list
  // alone -- and the install then recorded that back over the proxy, losing it
  // for good. Nothing here names a proxy, so nothing here overrides one.
  const { file, cleanup } = manifestWith({ proxyEnvironment: { ...PROXIED } });
  try {
    assert.deepEqual(
      serviceProxyEnvironment(
        { no_proxy: "localhost,127.0.0.1,::1", NO_PROXY: "localhost,127.0.0.1,::1" },
        { manifestPath: file },
      ),
      { ...PROXIED },
    );
  } finally {
    cleanup();
  }
});

test("a router started with a silent environment adopts the recorded proxy", () => {
  const manifest = manifestWith({ proxyEnvironment: PROXIED });
  try {
    // The case that cost a live installation: a shell a desktop app spawned
    // carries no proxy variables at all, so the router it starts would dial
    // every upstream directly.
    assert.deepEqual(
      inheritedProxyEnvironment({ PATH: "/usr/bin" }, { manifestPath: manifest.file, execArgv: [] }),
      PROXIED,
    );
    // A bypass list on its own is still silence -- it names no proxy and gives
    // no permission to use one.
    assert.deepEqual(
      inheritedProxyEnvironment(
        { no_proxy: "localhost" },
        { manifestPath: manifest.file, execArgv: [] },
      ),
      PROXIED,
    );
  } finally {
    manifest.cleanup();
  }
});

test("an environment that speaks about the proxy is never overridden", () => {
  const manifest = manifestWith({ proxyEnvironment: PROXIED });
  try {
    // Turning the proxy off is a decision, and the recorded values must not
    // reinstate it behind the operator's back.
    assert.deepEqual(
      inheritedProxyEnvironment(
        { NODE_USE_ENV_PROXY: "0" },
        { manifestPath: manifest.file, execArgv: [] },
      ),
      {},
    );
    // So is naming a different proxy.
    assert.deepEqual(
      inheritedProxyEnvironment(
        { HTTP_PROXY: "http://other:8080" },
        { manifestPath: manifest.file, execArgv: [] },
      ),
      {},
    );
    // And so is the command-line form of the opt-in.
    assert.deepEqual(
      inheritedProxyEnvironment(
        { PATH: "/usr/bin" },
        { manifestPath: manifest.file, execArgv: ["--use-env-proxy"] },
      ),
      {},
    );
  } finally {
    manifest.cleanup();
  }
});

test("an install that recorded no proxy leaves a silent environment alone", () => {
  const manifest = manifestWith({});
  try {
    assert.deepEqual(
      inheritedProxyEnvironment({ PATH: "/usr/bin" }, { manifestPath: manifest.file, execArgv: [] }),
      {},
    );
  } finally {
    manifest.cleanup();
  }
});
