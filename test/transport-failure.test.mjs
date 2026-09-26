import assert from "node:assert/strict";
import test from "node:test";

import {
  describeTransportFailure,
  hasProviderTransportError,
  localTransportHost,
  providerTransportError,
  transportFailureHost,
} from "../src/transport-failure.mjs";

// The exact chain Undici produces for an unreachable origin, reproduced from
// this router's own log: `TypeError: fetch failed` on top, the code and the
// address only on the cause.
function connectTimeout(host = "chatgpt.com") {
  const cause = new Error(
    `Connect Timeout Error (attempted address: ${host}:443, timeout: 10000ms)`,
  );
  cause.name = "ConnectTimeoutError";
  cause.code = "UND_ERR_CONNECT_TIMEOUT";
  return new TypeError("fetch failed", { cause });
}

// A refused socket is the other shape: Node sets `address` and `port`, never
// `hostname`. A fixture that added `hostname` here once hid a live bug where a
// stopped LiteLLM gateway on 127.0.0.1:4200 was reported as "the upstream"
// with proxy advice instead of the local-process hint.
function connectRefused(address, port) {
  const cause = new Error(`connect ECONNREFUSED ${address}:${port}`);
  cause.code = "ECONNREFUSED";
  cause.syscall = "connect";
  cause.address = address;
  cause.port = port;
  return cause;
}

test("a connect timeout names the host and the condition", () => {
  const failure = describeTransportFailure(connectTimeout(), {
    proxyConfigured: true,
  });
  assert.equal(failure.code, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(failure.cause, "timed out connecting to chatgpt.com");
  assert.equal(failure.hint, "");
});

test("an unreachable host advises the proxy opt-in only when none is configured", () => {
  const withoutProxy = describeTransportFailure(connectTimeout(), {
    proxyConfigured: false,
  });
  assert.match(withoutProxy.hint, /NODE_USE_ENV_PROXY=1/);

  const withProxy = describeTransportFailure(connectTimeout(), {
    proxyConfigured: true,
  });
  assert.equal(withProxy.hint, "");
});

// A reachable origin that misbehaved is not a routing problem, so the proxy
// advice would send the operator to reconfigure a network that is working.
test("a reset connection never advises a proxy", () => {
  const cause = new Error("socket hang up");
  cause.code = "ECONNRESET";
  cause.hostname = "api.moonshot.cn";
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause }), {
    proxyConfigured: false,
  });
  assert.equal(failure.cause, "api.moonshot.cn reset the connection");
  assert.equal(failure.hint, "");
});

test("a DNS failure reads its host off the error field", () => {
  const cause = new Error("getaddrinfo ENOTFOUND chatgpt.com");
  cause.code = "ENOTFOUND";
  cause.hostname = "chatgpt.com";
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause }), {
    proxyConfigured: true,
  });
  assert.equal(failure.cause, "could not resolve chatgpt.com");
});

// The failure that proved the network was intercepting rather than broken:
// a certificate for the ISP's own gateway served in place of the origin's.
test("a certificate for another host is reported as interception", () => {
  const cause = new Error(
    "Hostname/IP does not match certificate's altnames: Host: chatgpt.com. is not in the cert's altnames: DNS:gateway.pacwisp.net",
  );
  cause.code = "ERR_TLS_CERT_ALTNAME_INVALID";
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause }), {
    proxyConfigured: true,
  });
  assert.match(failure.cause, /chatgpt\.com/);
  assert.match(failure.cause, /intercepting the connection/);
});

test("an AggregateError chain is followed through its members", () => {
  const member = connectRefused("127.0.0.1", 4200);
  const aggregate = new AggregateError([member], "all connection attempts failed");
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause: aggregate }), {
    proxyConfigured: true,
  });
  assert.equal(failure.cause, "127.0.0.1 refused the connection");
});

// The gateway and the three forwarders are on loopback, so the codes that mean
// "this network is broken" for a remote host mean "a process this install owns
// died" here. Advising a proxy would send the operator to reconfigure a network
// that is working.
test("a loopback failure blames this install, never the network", () => {
  const cause = connectRefused("127.0.0.1", 4200);
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause }), {
    proxyConfigured: false,
  });
  assert.equal(failure.cause, "127.0.0.1 refused the connection");
  assert.match(failure.hint, /this install's own processes/);
  assert.match(failure.hint, /doctor --fix/);
  assert.doesNotMatch(failure.hint, /NODE_USE_ENV_PROXY/);
});

test("loopback is recognized by name, by address and inside brackets", () => {
  for (const host of ["localhost", "127.0.0.1", "127.5.0.9", "::1", "[::1]", "LocalHost"]) {
    assert.equal(localTransportHost(host), true, host);
  }
  for (const host of ["chatgpt.com", "10.0.0.4", "", undefined]) {
    assert.equal(localTransportHost(host), false, String(host));
  }
});

// A router bug must keep the honest generic wording rather than borrow a
// network cause it has no evidence for.
test("a non-transport error is not diagnosed", () => {
  assert.equal(describeTransportFailure(new Error("boom")), undefined);
  assert.equal(describeTransportFailure(undefined), undefined);
  const unknown = new Error("nope");
  unknown.code = "ERR_SOMETHING_ELSE";
  assert.equal(describeTransportFailure(unknown), undefined);
});

test("provider transport markers carry only a safe type and code", () => {
  const error = connectTimeout();
  assert.deepEqual(providerTransportError(error), {
    type: "provider_transport_error",
    code: "UND_ERR_CONNECT_TIMEOUT",
    message: "The provider connection failed before a response was available.",
  });
  assert.equal(
    hasProviderTransportError(JSON.stringify({ error: providerTransportError(error) })),
    true,
  );
  assert.equal(providerTransportError(new Error("application failure")), undefined);
  assert.equal(hasProviderTransportError("provider unavailable"), false);
});

test("a host is found with no hostname field and no known pattern falls back", () => {
  assert.equal(transportFailureHost(new Error("nothing here")), undefined);
  const cause = new Error("Connect Timeout Error (attempted address: 1.2.3.4:443)");
  cause.code = "UND_ERR_CONNECT_TIMEOUT";
  assert.equal(transportFailureHost(cause), "1.2.3.4");
});

test("a diagnosed failure with no recoverable host still names something", () => {
  const cause = new Error("Connect Timeout Error");
  cause.code = "UND_ERR_CONNECT_TIMEOUT";
  const failure = describeTransportFailure(new TypeError("fetch failed", { cause }), {
    proxyConfigured: true,
  });
  assert.equal(failure.cause, "timed out connecting to the upstream");
});

test("a refused socket names its host from the message when fields are gone", () => {
  assert.equal(transportFailureHost(new Error("connect ECONNREFUSED 127.0.0.1:4200")), "127.0.0.1");
  assert.equal(transportFailureHost(new Error("connect ECONNREFUSED ::1:4200")), "::1");
});

// Pins the fixture above to what this Node actually produces, so the two
// cannot drift apart again.
test("a real refused loopback fetch gets the local hint", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const error = await fetch(`http://127.0.0.1:${port}/`).then(
    () => assert.fail("expected the closed port to refuse"),
    (caught) => caught,
  );
  const failure = describeTransportFailure(error, { proxyConfigured: false });
  assert.equal(failure.code, "ECONNREFUSED");
  assert.equal(failure.cause, "127.0.0.1 refused the connection");
  assert.match(failure.hint, /doctor --fix/);
  assert.doesNotMatch(failure.hint, /NODE_USE_ENV_PROXY/);
});
