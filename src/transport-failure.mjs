import { environmentProxyOptedIn } from "./proxy-environment.mjs";

// The router reaches every upstream through Undici's `fetch`, which reports a
// socket failure as a bare `TypeError: fetch failed` and buries the code that
// names it on `cause`. Both places the router turns such a failure into a
// response body used to say only "the local router could not complete the
// request", so a Codex user saw no cause at all: a poisoned DNS answer, a
// captive portal, a stopped gateway and a missing proxy were one message.
//
// This module answers the two questions that message left open -- which host
// could not be reached, and what went wrong reaching it -- in the same shape
// `error-translation.mjs` uses for upstream *bodies*. The two are deliberately
// separate: that module reads what an origin said, this one runs when nothing
// was ever said.

const MAX_CAUSE_DEPTH = 8;

export const PROVIDER_TRANSPORT_ERROR_TYPE = "provider_transport_error";

// `hostname` is set by Node's DNS and TLS errors but not by a refused or
// unreachable socket, which carries `address` (and `port`) instead -- a
// stopped loopback gateway fails that way, and missing it sent the operator a
// proxy hint for a process this install owns. Undici's own connect errors
// name the address only in their message. Read the fields first and fall back
// to the wordings actually observed in this router's log.
const HOST_FIELDS = ["hostname", "address"];

const HOST_PATTERNS = [
  /connect\s+E[A-Z]+\s+([^\s,)]+):\d+/,
  /attempted address:\s*([^\s:,)]+)/i,
  /attempted addresses:\s*([^\s:,)]+)/i,
  /getaddrinfo\s+\w+\s+([^\s,)]+)/i,
  /Host:\s*([^\s:,]+?)\.?\s/i,
];

function causeChain(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object") break;
    chain.push(current);
    current =
      current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
  }
  return chain;
}

export function transportFailureHost(error) {
  for (const link of causeChain(error)) {
    for (const field of HOST_FIELDS) {
      if (typeof link[field] === "string" && link[field]) return link[field];
    }
    const message = typeof link.message === "string" ? link.message : "";
    for (const pattern of HOST_PATTERNS) {
      const match = message.match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

function transportFailureCode(error) {
  for (const link of causeChain(error)) {
    if (typeof link.code === "string" && link.code) return link.code;
  }
  return undefined;
}

// Every branch names the host, because "connection timed out" without it does
// not tell an operator whether their own gateway or the public internet is the
// broken hop. `reachable: false` marks the failures a proxy can plausibly fix,
// which is the only condition under which advising one is not noise.
const DIAGNOSES = new Map([
  ["UND_ERR_CONNECT_TIMEOUT", { reachable: false, describe: (host) => `timed out connecting to ${host}` }],
  ["ETIMEDOUT", { reachable: false, describe: (host) => `timed out connecting to ${host}` }],
  ["ENOTFOUND", { reachable: false, describe: (host) => `could not resolve ${host}` }],
  ["EAI_AGAIN", { reachable: false, describe: (host) => `could not resolve ${host} (DNS lookup failed)` }],
  ["ECONNREFUSED", { reachable: false, describe: (host) => `${host} refused the connection` }],
  ["EHOSTUNREACH", { reachable: false, describe: (host) => `no route to ${host}` }],
  ["ENETUNREACH", { reachable: false, describe: (host) => `no route to ${host}` }],
  ["ECONNRESET", { reachable: true, describe: (host) => `${host} reset the connection` }],
  ["UND_ERR_SOCKET", { reachable: true, describe: (host) => `the connection to ${host} closed early` }],
  ["UND_ERR_HEADERS_TIMEOUT", { reachable: true, describe: (host) => `${host} sent no response headers in time` }],
  ["UND_ERR_BODY_TIMEOUT", { reachable: true, describe: (host) => `${host} stopped sending the response body` }],
  // A certificate that does not match the host is not a broken origin: some
  // box in the path answered for it. Say so, because the remedies for an
  // intercepted connection share nothing with the remedies for a down origin.
  ["ERR_TLS_CERT_ALTNAME_INVALID", {
    reachable: false,
    describe: (host) =>
      `the TLS certificate served for ${host} belongs to a different host, so something on this network is intercepting the connection`,
  }],
  ["SELF_SIGNED_CERT_IN_CHAIN", {
    reachable: false,
    describe: (host) => `the TLS chain for ${host} is self-signed, so something on this network is intercepting the connection`,
  }],
  ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", {
    reachable: false,
    describe: (host) => `the TLS certificate for ${host} could not be verified`,
  }],
  ["CERT_HAS_EXPIRED", { reachable: true, describe: (host) => `the TLS certificate for ${host} has expired` }],
]);

const PROXY_HINT =
  " If this network needs an outbound proxy, set NODE_USE_ENV_PROXY=1 with http_proxy/https_proxy/no_proxy and rerun install.";

// The router's own gateway and forwarders live on loopback, so the same codes
// that mean "this network cannot reach the internet" mean "a process this
// install owns is not running" when the host is local. Advising a proxy there
// sends the operator to reconfigure a network that is working perfectly.
const LOCAL_HINT = " That is one of this install's own processes, not the network: run ./bin/doctor --fix.";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function localTransportHost(host) {
  if (typeof host !== "string" || !host) return false;
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOCAL_HOSTS.has(bare) || bare.startsWith("127.");
}

// Returns a `cause` fragment rather than a finished sentence, because the two
// callers have already committed to different openings: one failed before a
// head existed ("could not complete the request"), the other after it
// ("lost the upstream response stream"). Only the second half -- which host,
// what went wrong -- is common to both, and a diagnosis that overwrote the
// opening would have claimed a stream that died halfway was never reached.
//
// Undefined for anything that is not a recognized transport failure, so a
// router bug keeps its honest generic wording instead of borrowing a network
// cause there is no evidence for.
function hintFor(host, diagnosis, proxyConfigured) {
  if (localTransportHost(host)) return LOCAL_HINT;
  if (diagnosis.reachable || proxyConfigured) return "";
  return PROXY_HINT;
}

export function describeTransportFailure(
  error,
  { proxyConfigured = environmentProxyOptedIn() } = {},
) {
  const code = transportFailureCode(error);
  const diagnosis = code ? DIAGNOSES.get(code) : undefined;
  if (!diagnosis) return undefined;
  const host = transportFailureHost(error) || "the upstream";
  return {
    code,
    cause: diagnosis.describe(host),
    hint: hintFor(host, diagnosis, proxyConfigured),
  };
}

// The provider forwarder is separated from the router by LiteLLM, so a thrown
// socket error has to cross that HTTP boundary as data before the router can
// make a pre-response failover decision. Keep the marker machine-readable and
// omit the host and error text: custom endpoints and upstream bodies do not
// belong in an intermediary response.
export function providerTransportError(error) {
  const failure = describeTransportFailure(error);
  if (!failure) return undefined;
  return {
    type: PROVIDER_TRANSPORT_ERROR_TYPE,
    code: failure.code,
    message: "The provider connection failed before a response was available.",
  };
}

// LiteLLM may wrap the forwarder's JSON inside its own error envelope. The
// stable type string survives either representation, whereas parsing only the
// outer object would miss the wrapped form.
export function hasProviderTransportError(bodyText) {
  return typeof bodyText === "string" && bodyText.includes(PROVIDER_TRANSPORT_ERROR_TYPE);
}
