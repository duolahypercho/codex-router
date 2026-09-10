# Coding client logo sources

These local assets identify supported coding clients in the Codex Router control
center. They are bundled with the app and are never hotlinked at runtime.
Research was refreshed on 2026-08-30.

| Local asset | Used for | Official brand or product page | Asset source |
| --- | --- | --- | --- |
| `cursor.svg`, `cursor-dark.svg` | Cursor | https://cursor.com/brand | `General Logos/Cube/SVG/CUBE_2D_LIGHT.svg` and `CUBE_2D_DARK.svg` from Cursor's official downloadable brand asset archive |
| `deepseek-harness.svg` | DeepSeek Harness | https://github.com/deepseek-ai/deepseek-harness | `packages/client/ui-primitives/src/FishLogo.tsx` from the official DeepSeek Harness repository |
| `codex-light.svg`, `codex-dark.svg` | Codex | https://developers.openai.com/ | Dedicated `icon-codex-light.png` and `icon-codex-dark-color.png` product assets bundled in the installed official OpenAI desktop app, mechanically downsampled for this 23px surface |
| `claude.svg` | Claude Code | https://claude.com/product/claude-code | Exact orange Claude mark bundled in the installed official Anthropic Claude app (`ion-dist/assets/v1/cd02a42d9-Vq_H3mgS.svg`) |
| `openclaw.svg` | OpenClaw | https://github.com/openclaw/openclaw | Official `docs/assets/pixel-lobster.svg` from the OpenClaw repository |
| `pi.svg` | pi | https://pi.dev/ | The official `favicon.svg` served by pi.dev, reflowed onto one line and otherwise unchanged |
| `omp.svg` | omp (oh-my-pi) | https://github.com/open-horizon-labs/oh-omp | Official `assets/icon.svg` from the oh-omp repository, with its fills replaced by `currentColor` for the mask below |

Three client rows reuse a mark this app already bundles for the same
organization as a *provider*, rather than committing a second copy of it:
opencode uses `../providers/opencode.png`, Command Code uses
`../providers/commandcode.svg`, and Hermes Agent uses
`../providers/nousresearch.png`. Their provenance is recorded in
`../providers/SOURCES.md`.

DeepSeek Harness's and omp's official components are rendered as current-colour
masks. omp's mark is drawn for a dark ground, so painting it in the surrounding
text colour is what keeps it legible in both themes.
Cursor and Codex retain their official light/dark artwork. All names, logos, and trademarks remain
the property of their respective owners. Their use here identifies compatible
clients and does not imply endorsement or affiliation.
