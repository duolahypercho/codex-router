import { createHash } from "node:crypto";
import { grokToolSchema, canExpandGrokToolSchema, grokLiteralDomain, equalJsonSchemaValue } from "./grok-tool-schema.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const ROOT_KEYS = new Set(["oneOf", "anyOf", "type", "$defs", "definitions", "$schema", "title", "description"]);
const DIALECT = /^https?:\/\/json-schema\.org\/(?:draft-0[67]\/schema|draft\/(?:2019-09|2020-12)\/schema)#?$/;

function alternatives(schema) {
  if (!object(schema) || Object.keys(schema).some((key) => !ROOT_KEYS.has(key)) ||
      (schema.type !== undefined && schema.type !== "object") ||
      (schema.$schema !== undefined && !DIALECT.test(schema.$schema)) ||
      !canExpandGrokToolSchema(schema)) return undefined;
  const unions = [schema.oneOf, schema.anyOf].filter(Array.isArray);
  if (unions.length !== 1) return undefined;
  const branches = unions[0];
  if (branches.length < 2 || branches.length > 32) return undefined;
  const candidates = [];
  for (const branch of branches) {
    if (!object(branch) || branch.type !== "object" ||
        ["$ref", "oneOf", "anyOf", "allOf", "$defs", "definitions"].some((key) => Object.hasOwn(branch, key)) ||
        !Array.isArray(branch.required)) return undefined;
    const literals = new Map();
    for (const key of branch.required) {
      const domain = grokLiteralDomain(branch.properties?.[key], schema);
      if (domain?.length) literals.set(key, domain);
    }
    if (!literals.size) return undefined;
    candidates.push({ branch, literals });
  }
  const discriminators = new Set();
  for (let index = 0; index < candidates.length; index++) {
    const left = candidates[index];
    for (const right of candidates.slice(index + 1)) {
      const proof = [...left.literals].find(([key, domain]) => right.literals.has(key) &&
        domain.every((value) => right.literals.get(key).every((other) => !equalJsonSchemaValue(value, other))));
      if (!proof) return undefined;
      discriminators.add(proof[0]);
    }
  }
  // Unrelated enums retain their validation constraints but do not become
  // operation names or requirements for selecting a historical call's alias.
  return candidates.map(({ branch, literals }) => ({ branch,
    literals: new Map([...literals].filter(([key]) => discriminators.has(key))) }));
}

const literalText = (value) => typeof value === "string" ? value : JSON.stringify(value);
const safeName = (value) => value.replace(/[^a-zA-Z0-9_-]+/g, "_");

/** Lower disjoint operation variants at the provider boundary, without changing
 * the client's function contract. The reverse maps are request-local so aliases
 * never escape to the client or become persistent tool identities. */
export function createGrokToolAlternatives(tools, { toolChoice, maxTools = 350 } = {}) {
  const originals = new Map();
  const calls = new Map();
  const unchanged = { tools, originalName: (name) => name, nameForCall: (name) => name };
  if (!Array.isArray(tools) || !Number.isInteger(maxTools) || maxTools < tools.length || toolChoice === "none" ||
      (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "required")) return unchanged;
  const used = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"));
  const counts = new Map();
  for (const tool of tools) counts.set(tool?.name, (counts.get(tool?.name) || 0) + 1);
  let count = tools.length;
  const lowered = tools.flatMap((tool) => {
    if (tool?.type !== "function" || typeof tool.name !== "string" || counts.get(tool.name) !== 1) return [tool];
    const schema = grokToolSchema(tool.parameters);
    const variants = alternatives(schema);
    if (!variants || count + variants.length - 1 > maxTools) return [tool];
    count += variants.length - 1;
    const mapped = [];
    const definitions = Object.fromEntries(["$defs", "definitions", "$schema"].filter((key) =>
      Object.hasOwn(schema, key)).map((key) => [key, schema[key]]));
    const generated = variants.map(({ branch, literals }, index) => {
      const label = [...literals].map(([key, domain]) => `${key}=${domain.map(literalText).join("|")}`).join(", ");
      const stem = `${safeName(tool.name).slice(0, 32)}__${safeName([...literals.values()].flat().map(literalText).join("_"))}`;
      const seed = JSON.stringify([tool.name, index, branch]);
      let name;
      for (let collision = 0; ; collision++) {
        const suffix = createHash("sha256").update(`${seed}:${collision}`).digest("hex").slice(0, 12);
        name = `${stem.slice(0, 51)}_${suffix}`;
        if (!used.has(name)) break;
      }
      used.add(name);
      originals.set(name, tool.name);
      mapped.push({ name, literals });
      return { ...tool, name,
        description: [tool.description, `Operation variant of ${tool.name}: ${label}.`].filter(Boolean).join("\n"),
        parameters: { ...branch, ...definitions } };
    });
    calls.set(tool.name, mapped);
    return generated;
  });
  return {
    tools: lowered,
    originalName: (name) => originals.get(name) ?? name,
    nameForCall(name, argumentsJson) {
      const variants = calls.get(name);
      if (!variants || typeof argumentsJson !== "string") return name;
      let args;
      try { args = JSON.parse(argumentsJson); } catch { return name; }
      if (!object(args)) return name;
      const matches = variants.filter(({ literals }) => [...literals].every(([key, domain]) =>
        Object.hasOwn(args, key) && domain.some((value) => equalJsonSchemaValue(args[key], value))));
      return matches.length === 1 ? matches[0].name : name;
    },
  };
}
