import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, RUNTIME_PROVIDERS, providerForModel } from "./model-registry.mjs";
import { readProviderSelection } from "./provider-selection.mjs";
import { createExecutionPlan } from "./route-execution-plan.mjs";
import { antigravityOAuthStartupState } from "./antigravity-oauth-status.mjs";

// Selection and descriptor enablement define what can be requested. Missing
// credentials or picker visibility must not hide a needed dependency here.
export function runtimeDependencyRequirements({ includePendingActivation = true } = {}) {
  if (typeof includePendingActivation !== "boolean") {
    throw new TypeError("includePendingActivation must be a boolean.");
  }
  const selected = new Set(readProviderSelection());
  // An explicit probe can leave a protected pending proof while the provider
  // is still unselected. Its temporary listener must confirm adoption before
  // enablement. Gateway-only install queries skip this Node-only exception.
  const antigravity = includePendingActivation ? antigravityOAuthStartupState() : {};
  return createExecutionPlan({
    models: MODELS,
    providerForModel,
    routeEnabled: (model) => selected.has(model.provider) ||
      RUNTIME_PROVIDERS.get(model.provider)?.generic === true,
    pendingAntigravity: Boolean(antigravity.pendingActivationGeneration),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--gateway-required")) {
    console.error("Usage: runtime-dependency-requirements.mjs [--gateway-required]");
    process.exitCode = 2;
  } else {
    const plan = runtimeDependencyRequirements({ includePendingActivation: args.length === 0 });
    process.stdout.write(args.length ? `${plan.needsGateway ? "required" : "unused"}\n` :
      `${JSON.stringify({ needsGateway: plan.needsGateway, services: plan.services })}\n`);
  }
}
