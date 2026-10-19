# Native generation retries

The router defaults to `CODEX_ROUTER_NATIVE_RETRY_POLICY=at-most-once`.
Before automatically repeating a native generation POST, it requires both:

- No response bytes have reached the caller.
- A transport error positively identifies a failure before submission, such as
  DNS resolution, a refused connection or the dispatcher's connect timeout.

A connection reset, missing response headers or an edge 5xx can occur after
the origin executed the complete POST. The default policy relays these
uncertain failures instead of automatically submitting another generation.
Native generation redirects are refused; configure the final API endpoint.
The name describes this router's automatic replay policy for one request.
It does not prevent a client or another intermediary from independently retrying.

An operator may explicitly set `CODEX_ROUTER_NATIVE_RETRY_POLICY=availability`
to allow bounded retries of uncertain transient failures before client output.
This may repeat an already executed generation. Safe methods such as GET retain
bounded retries regardless of the generation policy. Neither policy retries
rate limits (429), other 4xx or origin 500 responses. Image generation retains
its separate zero-retry rule.

The existing limits remain:

- `CODEX_ROUTER_NATIVE_RETRIES`: at most two extra attempts by default; `0` disables retries.
- `CODEX_ROUTER_NATIVE_RETRY_BACKOFF_MS`: 250 ms initially, multiplied by three per retry.
- `CODEX_ROUTER_NATIVE_RETRY_BUDGET_MS`: the total retry allowance, derived from the bounded connect timeout by default.

Changing a limit never overrides delivery permission. The router rechecks
caller cancellation, relayed output and the total budget after asynchronous
backoff and response-body cancellation. Attempt records contain only bounded
attempt numbers, delivery state, duration, status, approved error codes and
whether a retry was scheduled. They contain no input, response text, URL or credential.
