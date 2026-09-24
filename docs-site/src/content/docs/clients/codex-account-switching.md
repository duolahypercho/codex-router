---
title: "Native ChatGPT account switching"
description: "Switch ChatGPT accounts without disturbing routed models."
---
## Native ChatGPT account switching

Codex Router can keep multiple ChatGPT subscription logins in isolated
profiles. Select an account in Control Center; the selection is
applied to native Codex after Codex is closed and restarted. The previous
login remains saved, and switching never removes another account's session.

Each account keeps its own native model catalog and routed overlay. Usage is
read from up to eight saved, usable accounts' isolated `CODEX_HOME`
directories, prioritizing the selected account and using the weekly
window when available and the monthly window otherwise. This is an explicit
switch-only feature: it does not perform automatic quota or round-robin
routing. See [the account switching guide](/clients/chatgpt-account-modes/) for
the safety and token-refresh details.
