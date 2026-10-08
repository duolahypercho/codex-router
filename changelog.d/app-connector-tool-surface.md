- **App connector functions can be withheld from routed chat prompts.** Set
  `CODEX_ROUTER_APP_CONNECTORS` in the router service's environment to `none`
  or a comma-separated list of connectors to keep eager. Stored calls and
  forced or allowed tool choices restore their definitions, including with
  string input. Custom tools and Codex's native app tools remain available.
