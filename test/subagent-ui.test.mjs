import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser panel subagent settings show native and unverified enabled models", () => {
  const source = readFileSync(path.join(root, "apps", "panel", "app.js"), "utf8");
  assert.match(source, /const subagentModels = enabledModels;/);
  assert.doesNotMatch(source, /!model\.native\s*&&\s*model\.visible/);
  assert.match(source, /selectedSubagents\.has\(model\.slug\)/);
  const activeCapability = source.slice(
    source.indexOf("const isSubagentOn = (model)"),
    source.indexOf("const subagentRow = (model)"),
  );
  assert.match(source, /const isCertifiedV2 = \(model\) => subagentCertification\(model\) === "v2"/);
  assert.match(activeCapability, /isCertifiedV2\(model\)/);
  assert.doesNotMatch(activeCapability, /selectedSubagents/);
  assert.match(source, /model\.multiAgentVersion === "v1" \? "v1" : "unknown"/);
  assert.match(source, /: certified\s*\? t\("models\.provenV2"\)/);
  assert.match(source, /\["candidate", "experimental", "proven"\]\.includes\(proof\?\.status\)/);
  assert.match(source, /const testActive = !certified && !knownV1 && !candidate &&\s*selectedSubagents\.has\(model\.slug\)/);
  assert.doesNotMatch(source, /knownV1 \|\| checking \|\| candidate \? " disabled"/);
});

test("Control Center keeps legacy local proofs as candidates, not active v2 routes", () => {
  const source = readFileSync(
    path.join(root, "apps", "control-center", "src", "pages", "ModelsPage.tsx"),
    "utf8",
  );
  assert.match(source, /if \(!model \|\| model\.visible === false\) return false/);
  assert.match(source, /if \(subagentCertification\(model\) === "v2"\)/);
  assert.match(source, /model\.multiAgentVersion === "v1" \? "v1" : "unknown"/);
  assert.match(source, /settings\.mode === "selected" && settings\.enabled\.includes\(slug\)/);

  // The switch adds the route to the subagent selection, which the router
  // publishes as v2. It never asks a local probe to decide that.
  const control = source.slice(
    source.indexOf("function subagentControl("),
    source.indexOf("function ModelRouteRow("),
  );
  assert.ok(control, "subagentControl is the single source of subagent wording");
  assert.match(control, /checked: selectedInSettings/);
  // It may read the registry certification to word its hint; what it must not
  // do is consult a local proof record to decide anything.
  assert.doesNotMatch(control, /proofs|candidate|experimental/i);

  // No local-proof vocabulary reaches the page at all.
  assert.doesNotMatch(source, /subagentSettings\?\.proofs|\.proofs\[|proofs\?\./);
  assert.doesNotMatch(source, /"candidate"|"experimental"|"proven"/);
  assert.doesNotMatch(source, /Test subagents|Untested|Awaiting certification|Test failed|Checking compatibility/);
  assert.match(source, /disabled=\{!apiAvailable\}/);
});

test("the macOS tray lists every model and varies only the switch", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  // The tray and the Models page describe the same models, so they must not
  // use two vocabularies -- and must not disagree about which models exist.
  // The page lists every model and varies only the Subagents column; hiding
  // the rest here made the operator's own models look missing.
  assert.match(source, /private var subagentModels: \[RouterModel\]/);
  assert.match(source, /\.filter\(\\\.enabled\)/);
  assert.match(source, /ForEach\(providerGroups\(filteredSubagentModels\)\)/);

  // The switch reflects the effective router selection. Registry v2 routes
  // are on by default, while selected/all mode deliberately promotes unknown
  // routes and an explicit off still wins.
  assert.match(source, /let subagentCertification: String\?/);
  assert.match(source, /private func isCertifiedV2\(_ model: RouterModel\) -> Bool/);
  const activeCapability = source.slice(
    source.indexOf("private func isSubagent(_ model: RouterModel)"),
    source.indexOf("private func subagentToggleOn(_ model: RouterModel)"),
  );
  assert.match(activeCapability, /TraySubagentSelectionPolicy\.isOn/);
  assert.match(source, /mode == "all" \|\| \(mode == "selected" && explicitlyEnabled\)/);
  assert.match(source, /guard !explicitlyDisabled, certification != "v1"/);

  // No local-proof vocabulary survives on this surface either.
  assert.doesNotMatch(source, /isKnownV1|isCertificationCandidate|selectedSubagentSet/);
  assert.doesNotMatch(source, /"candidate", "experimental", "proven"/);
  assert.doesNotMatch(source, /Proven v2|Certification candidate|v1 only/);
  assert.doesNotMatch(source, /subagents\.proofs/);

  // Every row's switch means one thing, so it needs no state to decode.
  assert.match(source, /private func subagentToggleOn\(_ model: RouterModel\) -> Bool \{\s*isSubagent\(model\)\s*\}/);
  assert.match(source, /TraySubagentTogglePolicy\.isDisabled/);
  assert.match(source, /certification == "v1"/);
  assert.doesNotMatch(source, /TraySubagentTogglePolicy\.isDisabled\([\s\S]{0,120}pickerVisible:/);
  assert.doesNotMatch(source, /!isPickerVisible\(model\) \|\| !isCertifiedV2\(model\)/);
  assert.match(source, /routerLocalized\("Cannot run subagents"\)/);
  assert.match(source, /get: \{ subagentToggleOn\(model\) \}/);
  assert.match(source, /disabled: subagentToggleDisabled\(model\)/);
  assert.match(source, /title: model\.displayName/);
  assert.match(source, /subagentStatusTags\(for: model\)/);
  assert.match(source, /Text\(routerLocalized\("Subagent"\)\)/);
  assert.match(source, /settings\?\.subagents\.efforts\?\[model\.slug\]/);
  assert.match(source, /subagentEffortRow\(for: model\)/);
});

test("the browser and macOS tray accordions can search providers and enabled models", () => {
  const panel = readFileSync(path.join(root, "apps", "panel", "app.js"), "utf8");
  const html = readFileSync(path.join(root, "apps", "panel", "index.html"), "utf8");
  const macos = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(html, /id="picker-model-search"/);
  assert.match(panel, /modelMatchesQuery\(model, state\.pickerModelFilter/);
  assert.match(macos, /private var filteredProviderVendorGroups: \[ProviderGroup\]/);
  assert.match(macos, /let groups = filteredProviderVendorGroups/);
  assert.match(macos, /placeholder: routerLocalized\("Search providers"\)/);
  assert.match(macos, /private var filteredSubagentModels: \[RouterModel\]/);
  assert.match(macos, /ForEach\(providerGroups\(filteredSubagentModels\)\)/);
  assert.match(macos, /placeholder: routerLocalized\("Search subagent models"\)/);
  assert.match(macos, /private var filteredPickerModels: \[RouterModel\]/);
  assert.match(macos, /ForEach\(providerGroups\(filteredPickerModels\)\)/);
  assert.match(macos, /private struct AccordionSearchField: View/);
});

test("the macOS tray OAuth reconnect action opens a visible browser-sign-in state", () => {
  const macos = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const login = macos.slice(
    macos.indexOf("func loginProvider(_ provider: String) async"),
    macos.indexOf("func saveProviderKey(_ provider: String, key: String) async"),
  );
  assert.match(login, /Opening \\\(displayName\) sign-in in your browser/);
  assert.match(login, /runControl\(arguments: \["login", provider\]\)/);
  assert.match(macos, /Image\(systemName: "arrow\.clockwise"\)[\s\S]*Text\(routerLocalized\("Reconnect"\)\)/);
  assert.match(macos, /\.fixedSize\(horizontal: true, vertical: false\)/);
  assert.match(macos, /routerLocalized\("Finish sign-in in browser"\)/);
});
