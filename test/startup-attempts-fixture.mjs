import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const staticImport = /^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];\s*\n/gm;

// Model the payload's platform independently of the host running the test.
// State paths and module URLs must share those semantics: a slash-only record
// can look foreign on a Windows drive before the ownership probe even runs.
export function startupFixturePaths(platform, directory) {
  const windows = platform === "win32";
  return {
    path: windows ? path.win32 : path.posix,
    root: windows ? `C:\\${directory}` : `/${directory}`,
    fileURLToPath: (url) => fileURLToPath(url, { windows }),
    pathToFileURL: (file) => pathToFileURL(file, { windows }),
  };
}

// Match the import-stripping fixtures used by service-stop.test.mjs. Keep each
// actual module's private scope and inject every imported binding explicitly.
// Unsupported imports fail the fixture instead of reaching a host dependency.
export async function executeStartupFixture(source, { dependency, globals, url }) {
  const imports = [];
  let code = source.replace(staticImport, (_statement, clause, specifier) => {
    imports.push({ clause: clause.trim(), specifier });
    return "";
  });
  const bindings = { ...globals };
  for (const { clause, specifier } of imports) {
    const namespace = await dependency(specifier);
    const entries = /^[\w$]+$/.test(clause)
      ? [["default", clause]]
      : clause.startsWith("{") && clause.endsWith("}")
        ? clause.slice(1, -1).split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
          const match = entry.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
          assert.ok(match, `Unsupported fixture binding ${entry}`);
          return [match[1], match[2] || match[1]];
        })
        : undefined;
    assert.ok(entries, `Unsupported fixture import ${clause}`);
    for (const [exported, local] of entries) {
      assert.ok(Object.hasOwn(namespace, exported), `Missing fixture export ${specifier}:${exported}`);
      assert.ok(!Object.hasOwn(bindings, local), `Duplicate fixture binding ${local}`);
      bindings[local] = namespace[exported];
    }
  }
  const exported = [...code.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)].map((match) => match[1]);
  code = code.replace(/^export /gm, "")
    .replace(/\bimport\.meta\b/g, "__fixtureImportMeta")
    .replace(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g, (_call, _quote, specifier) => `__importFixtureModule(${JSON.stringify(specifier)})`);
  assert.doesNotMatch(code, /^\s*(?:import|export)\b/gm, "Unsupported fixture module syntax");
  assert.doesNotMatch(code, /\bimport\s*\(/, "Unsupported fixture dynamic import");
  bindings.__fixtureImportMeta = { url };
  bindings.__importFixtureModule = async (specifier) => dependency(specifier);
  return new AsyncFunction("fixture", `const { ${Object.keys(bindings).join(", ")} } = fixture;\n${code}\nreturn { ${exported.join(", ")} };`)(bindings);
}
