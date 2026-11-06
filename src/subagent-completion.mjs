// Tool availability constrains failover; it does not authorize lifecycle calls.
const NATIVE_SUBAGENT_NAMESPACES = new Set(["collaboration", "agents"]);

export function subagentToolAvailable(namespaces) {
  if (!(namespaces instanceof Map)) return false;
  for (const [namespace, names] of namespaces) {
    if (NATIVE_SUBAGENT_NAMESPACES.has(namespace) && names instanceof Set && names.has("interrupt_agent")) return true;
  }
  return false;
}
