# ChatGPT account modes

Codex Router keeps each ChatGPT login in its own isolated profile. Selecting an account never deletes or merges another account's profile.

## Switch account

Switch mode activates the selected login in the native Codex profile. If Codex is open, the change is queued and applied after Codex closes. The previous login stays saved in its own account profile and can be selected again later.

## Pool (automatic)

Pool mode keeps the selected login active in Codex while native requests may use the other authenticated profiles. The configured strategy chooses those alternate accounts by quota, round-robin, or fill-first. The router does not replace the native login on every request.

## Token refresh

Authenticated account profiles are checked for near-expiry access tokens. When a token is close to expiry, Codex Router runs the official Codex login-status refresh against that account's isolated `CODEX_HOME`, with a retry interval and no credential output. Refreshing one account does not replace another account's profile.
