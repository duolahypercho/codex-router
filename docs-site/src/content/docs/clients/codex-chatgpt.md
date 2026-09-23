---
title: "Codex with and without a ChatGPT login"
description: "Use external models beside a ChatGPT session, or with no OpenAI login at all."
---
## Use external models while signed in to ChatGPT

The Control Center's **Use Router with ChatGPT** switch keeps ChatGPT
authentication available while external provider models remain selectable. On
current Codex builds, an explicit switch from the built-in OpenAI provider
selects the managed `codex-router-signed` transport so Codex validates prefixed
model ids against the router before sending them. The prior provider is stored
in protected state and restored when the switch is turned off. Normal updates
and catalog refreshes do not silently opt an existing installation into this
provider switch.

The optional native redirect is independent of this switch and of model
failover. If native redirect is set, every unmatched native GPT turn that
reaches the router continues to use its configured external route until
`./bin/control native-redirect clear` is run.

If **Approve for me** stops working once the ChatGPT plan is exhausted, that is
a separate quota from the session's. Codex runs automatic approval reviews on
its own hidden native model, so a session answered by an external provider can
keep reasoning and proposing commands while every review still costs ChatGPT
quota. Name a routed model to take those reviews over when that happens:

```
./bin/control auto-review-fallback set kimi-oauth/k3
./bin/control auto-review-fallback status
./bin/control auto-review-fallback clear
```

The fallback engages only after Codex's own reviewer has refused a review *for
quota*, and only for the window that refusal named. A denial, a policy
rejection, a malformed answer, and any other failure all stay with the native
reviewer -- a `deny` is a decision, and it is never retried through another
model. The first answer the native reviewer gives afterwards ends the window,
so reviews return to it on their own. It changes nothing about which model runs
the session.

## Use Codex without an OpenAI login

The tray's **Use without OpenAI login** switch selects the managed custom
provider for new Codex sessions. In that mode, enabled external models use the
OAuth session or API key configured for their provider and do not require a
ChatGPT or OpenAI API login. Connect and enable at least one external provider
before turning it on. On macOS, the tray gracefully quits and reopens the
registered Codex desktop app after the mode changes; if that restart fails, the
tray reports that Codex must be restarted manually. The switch keeps the current
model when it already belongs to a connected external provider; otherwise it
selects the first enabled model from one of those providers.

While the switch is on, model selection happens in Codex's own picker: the
catalog republishes external models with their real names, so switching models
needs no extra tray UI. `./bin/control model-set <model-slug>` switches the
active model from the command line; it accepts canonical external slugs and
writes the aliased native slug so pickers highlight the selection.

Login-free catalogs republish external models under the native GPT slugs
(with the external model's own name and reasoning levels), because some Codex
surfaces — notably the ChatGPT desktop app's model menu — only display models
whose slugs pass a server-delivered allowlist of native slugs. The router
records the mapping in `native-aliases.json` and dispatches those slugs to the
mapped external provider. Models beyond the available native slots stay listed
under their own slugs, and signing back in restores the native catalog
untouched.

For custom providers, the switch preserves the root `model_provider`,
temporarily owns that provider's complete table, and restores the exact table
plus the prior root `model`. Codex reserves the built-in `openai` provider id,
so root-OpenAI configurations use the compatible `codex-router` provider while
login-free mode is active and restore the prior provider afterward. The router
does not modify or delete ChatGPT credentials. Native GPT models, ChatGPT usage, cloud
tasks, and other account-backed features still require OpenAI authentication
and are not available while signed out. The equivalent local control command is
`./bin/control auth-mode on` or `./bin/control auth-mode off`; when using the
command directly, restart Codex yourself.
