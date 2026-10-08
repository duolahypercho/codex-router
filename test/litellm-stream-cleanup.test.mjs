import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PYTHON_REQUIREMENTS, requirementParts } from "../src/install-plan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.MODEL_ROUTER_TEST_LITELLM_PYTHON;
const litellmVersion = PYTHON_REQUIREMENTS.map(requirementParts)
  .find(({ name }) => name === "litellm")?.version;
assert.ok(litellmVersion, "the installer must pin LiteLLM");

// Ordinary Node tests need no Python install. The protocol workflow always
// supplies its freshly hash-locked interpreter and runs this test explicitly.
test("locked gateway bridge closes actual SDK streams and preserves upstream cleanup ownership", {
  skip: python ? false : "the protocol workflow supplies MODEL_ROUTER_TEST_LITELLM_PYTHON",
  timeout: 120_000,
}, () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "litellm-stream-cleanup-"));
  try {
    const script = String.raw`
import asyncio
import importlib.metadata
import importlib.util
import sys
import unittest
from unittest.mock import patch

import anyio
import httpx
from openai import AsyncOpenAI, AsyncStream
from openai.types.chat import ChatCompletionChunk
from litellm.integrations.custom_logger import CustomLogger
from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
from litellm.responses.litellm_completion_transformation.streaming_iterator import LiteLLMCompletionStreamingIterator as Iterator

assert importlib.metadata.version("litellm") == sys.argv[2]
assert importlib.metadata.version("openai") == "2.53.0"
assert not hasattr(Iterator, "aclose"), "reassess this compatibility when upstream implements cleanup"
spec = importlib.util.spec_from_file_location("router_cleanup_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AcquiredBody(httpx.AsyncByteStream):
    def __init__(self, failure=None, release=None):
        self.calls = 0
        self.failure = failure
        self.release = release
        self.started = asyncio.Event()

    async def __aiter__(self):
        yield b"data: [DONE]\n\n"

    async def aclose(self):
        self.calls += 1
        self.started.set()
        await anyio.sleep(0)
        if self.release is not None:
            await self.release.wait()
        if self.failure is not None:
            raise self.failure


class Cleanup(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clients = []

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()

    def acquired(self, failure=None, release=None):
        async def forbidden_request(request):
            raise AssertionError("this stream-close fixture must never issue an HTTP request")
        client = AsyncOpenAI(api_key="offline-fixture-key", http_client=httpx.AsyncClient(transport=httpx.MockTransport(forbidden_request)))
        self.clients.append(client)
        body = AcquiredBody(failure=failure, release=release)
        response = httpx.Response(200, request=httpx.Request("POST", "http://127.0.0.1/offline"), stream=body)
        sdk_stream = AsyncStream(cast_to=ChatCompletionChunk, response=response, client=client)
        wrapper = CustomStreamWrapper.__new__(CustomStreamWrapper)
        wrapper.completion_stream = sdk_stream
        iterator = Iterator.__new__(Iterator)
        iterator.litellm_custom_stream_wrapper = wrapper
        return iterator, wrapper, response, body

    async def test_actual_sdk_close_is_idempotent(self):
        iterator, wrapper, response, body = self.acquired()
        await iterator.aclose()
        await iterator.aclose()
        self.assertEqual(body.calls, 1)
        self.assertTrue(response.is_closed)
        self.assertIsNone(wrapper.completion_stream)

    async def test_active_anyio_cancellation_cannot_interrupt_close(self):
        iterator, wrapper, response, body = self.acquired()
        with anyio.CancelScope() as scope:
            scope.cancel()
            await iterator.aclose()
        self.assertEqual(body.calls, 1)
        self.assertTrue(response.is_closed)
        self.assertIsNone(wrapper.completion_stream)

    async def test_direct_task_cancel_preserves_cancel_and_closes_in_finally(self):
        iterator, wrapper, response, body = self.acquired()
        ready = asyncio.Event()
        async def worker():
            try:
                ready.set()
                await asyncio.Event().wait()
            finally:
                await iterator.aclose()
        task = asyncio.create_task(worker())
        await ready.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(body.calls, 1)
        self.assertTrue(response.is_closed)

    async def test_concurrent_close_clears_ownership_before_awaiting(self):
        release = asyncio.Event()
        iterator, wrapper, response, body = self.acquired(release=release)
        first = asyncio.create_task(iterator.aclose())
        await body.started.wait()
        self.assertIsNone(wrapper.completion_stream)
        await iterator.aclose()
        release.set()
        await first
        self.assertEqual(body.calls, 1)
        self.assertTrue(response.is_closed)

    async def test_existing_wrapper_owns_close_exception_semantics(self):
        for failure in [RuntimeError("controlled close failure"), asyncio.CancelledError()]:
            with self.subTest(failure=type(failure).__name__):
                iterator, wrapper, response, body = self.acquired(failure=failure)
                await iterator.aclose()
                await iterator.aclose()
                self.assertEqual(body.calls, 1)
                self.assertIsNone(wrapper.completion_stream)
                self.assertTrue(response.is_closed)

    async def test_future_native_method_is_never_overridden(self):
        saved = Iterator.aclose
        async def native_close(self):
            return "upstream-owned"
        try:
            Iterator.aclose = native_close
            with patch.object(module, "version", return_value="99.0.0"):
                self.assertFalse(module.install_stream_cleanup())
            self.assertIs(Iterator.aclose, native_close)
            self.assertEqual(await Iterator.__new__(Iterator).aclose(), "upstream-owned")
        finally:
            Iterator.aclose = saved

    async def test_install_is_idempotent_and_has_no_callback_hooks(self):
        saved = Iterator.aclose
        self.assertFalse(module.install_stream_cleanup())
        self.assertIs(Iterator.aclose, saved)
        self.assertIs(type(module.stream_cleanup_callback), CustomLogger)

    async def test_unreviewed_missing_method_version_refuses_install(self):
        saved = Iterator.aclose
        try:
            del Iterator.aclose
            for unreviewed in ["1.96.1", "99.0.0"]:
                with self.subTest(version=unreviewed):
                    with patch.object(module, "version", return_value=unreviewed):
                        with self.assertRaisesRegex(RuntimeError, "Review stream cleanup compatibility"):
                            module.install_stream_cleanup()
                    self.assertFalse(hasattr(Iterator, "aclose"))
        finally:
            Iterator.aclose = saved


unittest.main(argv=[sys.argv[0]], verbosity=2)
`;
    const environment = {
      HOME: scratch,
      USERPROFILE: scratch,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      PATH: process.env.PATH || "",
      LITELLM_LOCAL_MODEL_COST_MAP: "True",
      LITELLM_TELEMETRY: "False",
      LITELLM_LOG: "ERROR",
      PYTHONUTF8: "1",
    };
    for (const key of ["SYSTEMROOT", "SystemRoot", "WINDIR"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const result = spawnSync(path.resolve(python), ["-I", "-B", "-c", script, path.join(root, "src", "litellm_stream_cleanup_callback.py"), litellmVersion], {
      cwd: scratch,
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 128 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /Ran 8 tests/);
    assert.match(result.stderr, /\nOK\s*$/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
