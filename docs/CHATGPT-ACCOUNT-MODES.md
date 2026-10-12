# ChatGPT native account switching

Codex Router keeps each ChatGPT login in its own isolated profile. Manual selection changes the native Codex login for the next restart. Optional automatic routing uses those saved profiles per conversation without replacing the main Codex login.

## Select an account

Choose a saved account from the account list in Control Center. The selected login remains saved under its own account profile. If Codex is open, the change is queued and applied after Codex closes; the previous login is never deleted or overwritten as another account.

## Account data and catalog

Each account keeps its own native model catalog and routed model overlay. Switching restores that account's catalog, so models unavailable to one ChatGPT plan are not shown as available under another plan. External provider credentials and subagent routes are preserved.

## Usage

Control Center reads usage from up to eight saved, usable accounts' isolated `CODEX_HOME` directories, prioritizing the selected account. It shows the weekly window when OpenAI reports one, otherwise the monthly window. Returning to another account reloads that account's quota and reset time.

## Token refresh

Authenticated account profiles are checked for near-expiry access tokens. When a token is close to expiry, Codex Router runs the official Codex login-status refresh against that account's isolated `CODEX_HOME`, with a retry interval and no credential output. Refreshing one account does not replace another account's profile.

## Safety

The switch waits for the desktop Codex process to close and fails closed when process detection is unavailable. Profile copies reject symlinks, bind a saved account to the verified ChatGPT identity, use atomic private-file replacement, and restore the previous profile and catalog if a refresh fails. Concurrent switches are serialized.

## Automatic account routing (opt in)

In Control Center, open **Settings → ChatGPT accounts → Automatic account routing**. The default is **Off**. Choose **Round robin for new conversations** to spread independent conversations, or **Use one account until quota refusal** to prefer one eligible account. The equivalent commands are:

```sh
codex-router chatgpt-account-pool routing round-robin
codex-router chatgpt-account-pool routing fill-first
codex-router chatgpt-account-pool routing off
codex-router chatgpt-account-pool routing status
```

This opt-in authorizes the shared router to use registered ChatGPT profiles for native Responses requests, including callers carrying their own native credentials. It does not change `CODEX_HOME/auth.json`, the selected desktop login, external-provider credentials, or image/search routing. Add and sign in to accounts using the existing account controls; expired, paused, unfinalized, identity-mismatched, or unsafe profiles are unavailable. The request path never refreshes tokens or runs login. Existing account management continues to refresh profiles with the official Codex CLI.

Independent conversations receive an account and retain it. Account-pool routing currently refuses requests that advertise collaboration tools, carry parent/subagent metadata, or contain collaboration messages. It also refuses pooled native encrypted agent-message relay before reading profile credentials or accessing the relay cache. Live marker-return verification through every installed routed agent has not been completed, so this path is withheld in code. Ordinary encrypted reasoning and compaction history within an independent conversation remain supported. Use routing **Off** and new conversations for native collaboration; an existing pooled collaboration tree remains refused even after routing is disabled. Thread identifiers take precedence over session identifiers; callers without either share one affinity. Affinity is scoped to the private routing state of the shared local installation, independently of authentication credentials. Rotating the caller capability or changing the desktop login does not reassign an existing conversation; requests still require a valid current caller capability.

A structured HTTP 429/402 quota refusal can cool down that account and try each remaining eligible profile once, only before any output is relayed and only for portable history. Ordinary rate limits, 401s, network failures, and arbitrary error-message wording do not trigger account switching. The recovery time comes from the upstream reset time or `Retry-After`, with a 15-minute fallback when neither is usable. Cooldown is shown next to the saved account. If every account is unavailable, the final upstream refusal is preserved.

Encrypted reasoning, compaction, stored response/item references, uploaded files, vector stores, existing execution containers, and conversation handles belong to an account. They are never silently dropped to permit switching. If their owner is unavailable, start a new conversation or wait for that account to recover. A quota error inside an HTTP 200 stream records cooldown for later requests but never replays that stream, including when it has already produced partial output. Pooled requests use upstream HTTP; client WebSocket requests still work through the shared Responses adapter.

The displayed weekly/monthly usage percentage is informational, not routing evidence: another quota window may already be exhausted. Account routing does not promise that every saved plan supports the model selected under the primary account's catalog. A model-access error stays with the selected account and is not reinterpreted as quota exhaustion.

Policy, opaque account affinities, and cooldowns are saved owner-only in `chatgpt-account-routing.json`; no tokens or conversation content are stored there. Full turns are serialized per conversation, while independent threads can run concurrently. A queued turn waits until the previous stream finishes or its own request is canceled or times out; there is no separate 30-second lease wait limit. Windows request-path private-file checks use fresh asynchronous batch ACL verification, without caching verdicts or changing credential permissions. At most 4096 conversation affinities are retained. To recover capacity, close the old pooled conversations, then explicitly run:

```sh
codex-router chatgpt-account-pool routing reset
```

Reset refuses active turns and can reclaim crashed leases after their ten-minute stale interval. It removes affinities and retains quota cooldowns and policy. Afterwards, untracked account-bound history is refused rather than guessed; start new conversations to establish fresh ownership. Older pre-release capability-scoped affinity files with existing sessions require this explicit reset instead of silently rebinding their history. Disabling routing also refuses previously pooled opaque history when it cannot safely use the current login. `--no-discovery` prevents profile reads and automatic routing.
