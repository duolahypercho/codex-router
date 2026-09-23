import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

const githubUrl = "https://github.com/duolahypercho/codex-router";

export default defineConfig({
  output: "static",
  site: "https://codex-router-nine.vercel.app",
  integrations: [
    starlight({
      title: "Codex Router",
      description:
        "Developer documentation for Codex Router: a local model router for Codex, DeepSeek Harness, Gemini CLI, Cursor, Claude Code, and OpenClaw.",
      logo: { src: "./public/router-mark.svg", alt: "Codex Router" },
      favicon: "/router-mark.svg",
      social: [{ icon: "github", label: "GitHub", href: githubUrl }],
      editLink: { baseUrl: `${githubUrl}/edit/main/docs-site/` },
      customCss: ["./src/styles/docs.css"],
      // The marketing page at `/` is a hand-built Astro page, so Starlight's
      // own splash route is deliberately not used.
      disable404Route: false,
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Installation", slug: "getting-started/installation" },
            { label: "What Codex Router does", slug: "getting-started/what-it-does" },
            { label: "Install with an agent", slug: "getting-started/agent-install" },
            { label: "Other installation methods", slug: "getting-started/install-methods" },
            { label: "How it works", slug: "getting-started/how-it-works" },
            { label: "Troubleshooting", slug: "getting-started/troubleshooting" },
          ],
        },
        {
          label: "Providers",
          items: [
            { label: "Providers and authentication", slug: "providers/overview" },
            { label: "GitHub Copilot", slug: "providers/github-copilot" },
            { label: "opencode (Go and Zen)", slug: "providers/opencode-go" },
            { label: "Anonymous gateways", slug: "providers/anonymous-gateways" },
            { label: "Custom endpoints", slug: "providers/custom-endpoints" },
            { label: "Command Code", slug: "providers/command-code" },
            { label: "Ox Alpha", slug: "providers/ox-alpha" },
            { label: "Meta Model API", slug: "providers/meta-model-api" },
            { label: "Catalog-only providers", slug: "providers/catalog-only" },
            { label: "Local models", slug: "providers/local-models" },
            { label: "Router-owned default", slug: "providers/default-model" },
          ],
        },
        {
          label: "Clients",
          items: [
            { label: "Codex", slug: "clients/codex" },
            { label: "Codex at 1M context", slug: "clients/codex-1m-context" },
            { label: "Codex on Windows and WSL", slug: "clients/codex-windows-wsl" },
            { label: "Codex and ChatGPT logins", slug: "clients/codex-chatgpt" },
            { label: "ChatGPT account switching", slug: "clients/codex-account-switching" },
            { label: "Local models in Codex", slug: "clients/codex-local-model" },
            { label: "ChatGPT account modes", slug: "clients/chatgpt-account-modes" },
            { label: "DeepSeek Harness", slug: "clients/deepseek-harness" },
            { label: "Gemini CLI", slug: "clients/gemini-cli" },
            { label: "Cursor", slug: "clients/cursor" },
            { label: "Claude Code", slug: "clients/claude-code" },
            { label: "OpenClaw", slug: "clients/openclaw" },
            { label: "opencode, pi, omp, and Hermes", slug: "clients/other-clients" },
            { label: "Compatible apps", slug: "clients/compatible-apps" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Images for text-only models", slug: "guides/vision" },
            { label: "Usage limits and failover", slug: "guides/failover" },
            { label: "Skills for custom models", slug: "guides/skills" },
            { label: "Desktop app and Control Center", slug: "guides/desktop-app" },
            { label: "Tray and prebuilt packages", slug: "guides/desktop-tray" },
            { label: "macOS menu-bar app", slug: "guides/macos-tray" },
            { label: "Updates and rollback", slug: "guides/updates" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "CLI commands", slug: "reference/cli" },
            { label: "How routing works", slug: "reference/routing" },
            { label: "Adding providers and models", slug: "reference/providers-and-models" },
            { label: "Installation reference", slug: "reference/install" },
            { label: "Development", slug: "reference/development" },
          ],
        },
      ],
    }),
  ],
});
