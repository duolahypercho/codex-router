export function routerNodeBinary(environment = process.env, fallback = process.execPath) {
  return environment.CODEX_ROUTER_NODE_BIN || fallback;
}
