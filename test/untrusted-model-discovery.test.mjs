import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  fetchUntrustedModelCatalog,
  validateDiscoveryUrl,
  validateModelCatalogPayload,
  isPrivateAddress,
} from "../src/untrusted-model-discovery.mjs";

const PUBLIC_IP = "93.184.216.34";

test("unspecified addresses are private and cannot be used as discovery targets", () => {
  assert.equal(isPrivateAddress("0.0.0.0"), true);
});

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

test("discovery refuses DNS names that resolve to private addresses", async () => {
  await assert.rejects(
    validateDiscoveryUrl("https://provider.example.test/models", {
      resolveHost: async () => ["127.0.0.1"],
    }),
    /private or loopback/,
  );
});

test("redirects are same-origin, bounded, and revalidated at every hop", async () => {
  let calls = 0;
  const resolved = [];
  await assert.rejects(
    fetchUntrustedModelCatalog("https://provider.example.test/models", {
      resolveHost: async (host) => {
        resolved.push(host);
        return resolved.length === 1 ? [PUBLIC_IP] : ["169.254.169.254"];
      },
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "/next" } });
      },
    }),
    /private or loopback/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(resolved, ["provider.example.test", "provider.example.test"]);
});

test("cross-origin redirects cannot carry discovery credentials", async () => {
  let calls = 0;
  const secret = "Bearer redirect-secret";
  await assert.rejects(
    fetchUntrustedModelCatalog("https://provider.example.test/models", {
      headers: { Authorization: secret },
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://other.example.test/models" } });
      },
    }),
    (error) => {
      assert.match(error.message, /cross-origin redirect/);
      assert.doesNotMatch(error.message, /redirect-secret/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("credential-bearing public discovery requires HTTPS before sending a request", async () => {
  let calls = 0;
  await assert.rejects(
    fetchUntrustedModelCatalog("http://provider.example.test/models", {
      headers: { Authorization: "Bearer plaintext-secret" },
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ data: [] });
      },
    }),
    (error) => {
      assert.match(error.message, /requires HTTPS/);
      assert.doesNotMatch(error.message, /plaintext-secret/);
      return true;
    },
  );
  assert.equal(calls, 0);

  const publicResult = await fetchUntrustedModelCatalog("http://provider.example.test/models", {
    resolveHost: async () => [PUBLIC_IP],
    fetchImpl: async () => jsonResponse({ data: [{ id: "public/no-credential" }] }),
  });
  assert.deepEqual(publicResult.data, [{ id: "public/no-credential" }]);
});

test("proxy transports that independently resolve the provider fail before credentials leave", async () => {
  let calls = 0;
  await assert.rejects(
    fetchUntrustedModelCatalog("https://provider.example.test/models", {
      headers: { Authorization: "Bearer proxy-secret" },
      resolveHost: async () => [PUBLIC_IP],
      proxyResolvesDestination: true,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ data: [] });
      },
    }),
    (error) => {
      assert.match(error.message, /proxy transport.*independently resolves/);
      assert.doesNotMatch(error.message, /proxy-secret/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("catalog bodies are bounded before JSON parsing and provider errors do not echo credentials", async () => {
  const secret = "Bearer super-secret-catalog-key";
  await assert.rejects(
    fetchUntrustedModelCatalog("https://provider.example.test/models", {
      headers: { Authorization: secret },
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async () => new Response(secret, {
        status: 502,
        headers: { "content-length": String(secret.length) },
      }),
    }),
    (error) => {
      assert.match(error.message, /HTTP 502/);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );

  await assert.rejects(
    fetchUntrustedModelCatalog("https://provider.example.test/models", {
      maxBytes: 8,
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async () => new Response("0123456789", {
        status: 200,
        headers: { "content-length": "10" },
      }),
    }),
    /size limit/,
  );
});

test("the response schema has bounded records and safe model identities", async () => {
  assert.throws(
    () => validateModelCatalogPayload({ data: [{ id: "valid" }, { id: "bad\u0000id" }] }),
    /invalid model id/,
  );
  assert.throws(
    () => validateModelCatalogPayload({ data: [{ id: "valid" }] }, { maxModels: 0 }),
    /oversized model catalog/,
  );
  const result = await fetchUntrustedModelCatalog("https://provider.example.test/models", {
    resolveHost: async () => [PUBLIC_IP],
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return jsonResponse({ data: [{ id: "provider/model" }] });
    },
  });
  assert.deepEqual(result.data, [{ id: "provider/model" }]);
});

test("explicitly configured private providers remain available", async () => {
  const result = await fetchUntrustedModelCatalog("http://127.0.0.1:8000/models", {
    allowPrivate: true,
    headers: { Authorization: "Bearer local-only-secret" },
    fetchImpl: async () => jsonResponse({ data: [{ id: "local/model" }] }),
  });
  assert.deepEqual(result.data, [{ id: "local/model" }]);
});

test("the real discovery request pins the validated DNS answer", async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "local/pinned" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    let resolutions = 0;
    const result = await fetchUntrustedModelCatalog(`http://discovery.test:${port}/models`, {
      allowPrivate: true,
      proxyResolvesDestination: false,
      resolveHost: async () => {
        resolutions += 1;
        return resolutions === 1 ? ["127.0.0.1"] : ["169.254.169.254"];
      },
    });
    assert.deepEqual(result.data, [{ id: "local/pinned" }]);
    assert.equal(resolutions, 1, "the transport performed an unpinned second DNS lookup");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
