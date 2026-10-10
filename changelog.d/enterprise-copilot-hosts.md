- **GitHub Copilot supports GitHub Enterprise Cloud data-residency hosts.** Use
  `control github-copilot host set TENANT.ghe.com` to select one host for all
  Copilot credentials. The router keeps account routing and model caches separate
  by host and rejects inference endpoints outside the selected tenant. GitHub.com
  remains the default. After a host change, curate the models again, reload the
  client, and start a new conversation.
