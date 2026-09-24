// The effort ladder shared by the catalog and the forwarder.
//
// Why this lives in its own module: `api-forwarder.mjs` starts a server at import
// time, so a unit test cannot import a helper from it without starting one. The
// clamp below is pure and decides whether a user's chosen depth survives, so it
// belongs somewhere a test can reach it directly.
//
// The two-stage design it serves, both halves measured:
//
//   * the catalog advertises only the rungs the installed Codex build can parse
//     (`catalog.mjs` clamps `max` down to `xhigh` on 0.141, which has no `max`),
//   * the forwarder maps the requested rung onto the ladder the model's registry
//     entry declares, so a route whose entry lists low/high/max receives the
//     upstream's own `max` even though Codex sent `xhigh`.
//
// The defect this pins (2026-09-22): the opencode deepseek entries declared a
// single rung (`high`), so `xhigh`/`max`/`ultra` had nowhere to land and every
// "max" silently ran at "high". The provider advertises low/high/max for that
// model, and the router's own usage ledger shows it serving ~830k-token turns.

export const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function declaredEffort(value, levels) {
  const declared = levels
    .filter((effort) => EFFORT_LADDER.includes(effort))
    .sort((left, right) => EFFORT_LADDER.indexOf(left) - EFFORT_LADDER.indexOf(right));
  if (!declared.length) return undefined;
  if (["xhigh", "max", "ultra"].includes(value)) return declared.at(-1);
  const requested = EFFORT_LADDER.indexOf(value);
  const ceiling = requested === -1 ? EFFORT_LADDER.indexOf("high") : requested;
  const atOrBelow = declared.filter((effort) => EFFORT_LADDER.indexOf(effort) <= ceiling);
  return atOrBelow.at(-1) || declared[0];
}
