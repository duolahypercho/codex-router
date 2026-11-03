#!/usr/bin/env node
// Inspect a Codex rollout for turn-scoped evidence that the managed skill pack
// was injected by the app and then referenced by a completed model tool call.
// This is deliberately an evidence check, not a live execution probe: an
// arbitrary exec call cannot prove from the rollout alone that bytes were read.
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_SKILLS = [
  "codex-router",
  "codex-app-threads",
  "codex-in-app-browser",
  "codex-computer-use",
];

export function latestRollout(sessionsRoot) {
  let best;
  let bestMtime = -1;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(candidate);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const mtime = statSync(candidate).mtimeMs;
          if (mtime > bestMtime) {
            best = candidate;
            bestMtime = mtime;
          }
        } catch {
          // Unreadable rollout; keep looking.
        }
      }
    }
  };
  walk(sessionsRoot);
  return best;
}

function defaultSessionsRoot() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

function parseRollout(lines) {
  const events = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push({ index, event: JSON.parse(line) });
    } catch {
      // A damaged unrelated line does not become trusted evidence.
    }
  }
  return events;
}

function eventTurnId(event) {
  const payload = event?.payload;
  const candidates = [
    payload?.internal_chat_message_metadata_passthrough?.turn_id,
    payload?.item?.internal_chat_message_metadata_passthrough?.turn_id,
    event?.internal_chat_message_metadata_passthrough?.turn_id,
  ];
  return candidates.find((value) => typeof value === "string" && value.trim())?.trim();
}

function eventItem(event) {
  return event?.payload?.item || event?.payload || {};
}

function completeSkillsBlock(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return /^<skills_instructions>[\s\S]*<\/skills_instructions>$/.test(trimmed);
}

function listedPackSkills(block) {
  return PACK_SKILLS.filter((skill) => block.includes(`(file: r0/${skill}/SKILL.md)`));
}

function r0Root(block) {
  const match = block.match(/^r0\s*=\s*(.+?)\s*$/m);
  return match?.[1]?.replace(/^['"]|['"]$/g, "");
}

function trustedInjections(events) {
  const candidates = [];
  for (const { index, event } of events) {
    const payload = event?.payload;
    if (event?.type !== "response_item") continue;
    if (payload?.type !== "message" || payload.role !== "developer") continue;
    if (!Array.isArray(payload.content)) continue;
    const turnId = eventTurnId(event);
    if (!turnId) continue;
    for (const part of payload.content) {
      if (part?.type !== "input_text" || !completeSkillsBlock(part.text)) continue;
      candidates.push({
        index,
        turnId,
        block: part.text.trim(),
        listed: listedPackSkills(part.text),
      });
    }
  }
  return candidates;
}

function sourceForToolCall(item) {
  if (item?.type === "custom_tool_call" && item.name === "exec") {
    return typeof item.input === "string" ? item.input : JSON.stringify(item.input || {});
  }
  if (item?.type === "function_call" && item.name === "exec_command") {
    return typeof item.arguments === "string"
      ? item.arguments
      : JSON.stringify(item.arguments || {});
  }
  return undefined;
}

function exactSkillForSource(source, block) {
  if (!source) return undefined;
  const root = r0Root(block);
  return PACK_SKILLS.find((skill) => {
    const aliases = [`r0/${skill}/SKILL.md`];
    if (root) {
      const base = root.replace(/[\\/]+$/, "");
      aliases.push(`${base}/${skill}/SKILL.md`, `${base}\\${skill}\\SKILL.md`);
    }
    return aliases.some((candidate) => source.includes(candidate));
  });
}

function matchingOutput(events, call, turnId) {
  if (typeof call.callId !== "string" || !call.callId) return false;
  return events.some(({ index, event }) => {
    if (index <= call.index || eventTurnId(event) !== turnId) return false;
    const item = eventItem(event);
    return (
      ["custom_tool_call_output", "function_call_output"].includes(item?.type) &&
      item.call_id === call.callId
    );
  });
}

function modelPackReads(events, injection) {
  if (!injection) return { issued: [], completed: [], issuedWithoutOutput: [] };
  const issued = [];
  for (const { index, event } of events) {
    if (index <= injection.index || eventTurnId(event) !== injection.turnId) continue;
    const item = eventItem(event);
    const skill = exactSkillForSource(sourceForToolCall(item), injection.block);
    if (!skill) continue;
    issued.push({ skill, callId: item.call_id, index });
  }
  const completedCalls = issued.filter((call) => matchingOutput(events, call, injection.turnId));
  return {
    issued,
    completed: [...new Set(completedCalls.map((call) => call.skill))],
    issuedWithoutOutput: issued.filter(
      (call) => !completedCalls.some((completed) => completed === call),
    ),
  };
}

function sessionModel(events) {
  const parsed = events.map(({ event }) => event);
  const meta = parsed.find((event) => event?.type === "session_meta");
  const settings = parsed
    .map((event) => event?.payload?.thread_settings || event?.payload)
    .find((payload) => payload?.model);
  return meta?.payload?.model || settings?.model || undefined;
}

export function analyzeRollout(lines, { expect = "routed" } = {}) {
  if (!["routed", "native"].includes(expect)) {
    throw new Error(`invalid expectation: ${expect}`);
  }
  const events = parseRollout(lines);
  const injection = trustedInjections(events).at(-1);
  const listed = injection?.listed || [];
  const readEvidence = modelPackReads(events, injection);
  const reads = readEvidence.completed;
  const model = sessionModel(events);
  const packComplete = listed.length === PACK_SKILLS.length;

  const assertions = [
    {
      name: "(a) app developer injection lists the managed pack under r0",
      pass: Boolean(injection) && packComplete,
      detail: !injection
        ? "no standalone developer <skills_instructions> block with a turn_id"
        : packComplete
          ? `turn ${injection.turnId}; listed: ${listed.join(", ")}`
          : `turn ${injection.turnId}; missing: ${PACK_SKILLS.filter((skill) => !listed.includes(skill)).join(", ")}`,
    },
    {
      name: "(b) routed model completed a same-turn tool call referencing pack SKILL.md",
      pass: expect === "native" ? true : reads.length > 0,
      detail:
        expect === "native"
          ? "skipped for native expectation"
          : reads.length > 0
            ? `referenced: ${reads.join(", ")}`
            : readEvidence.issuedWithoutOutput.length > 0
              ? "skill read issued, output not observed"
              : "no same-turn completed tool call referenced pack SKILL.md after injection",
    },
    {
      name: "(c) native sessions do not complete a same-turn pack-path tool call",
      pass: expect === "native" ? reads.length === 0 : true,
      detail:
        expect === "native"
          ? reads.length === 0
            ? "no completed pack-path tool call after the trusted injection"
            : `pack skill path(s) referenced on a native session: ${reads.join(", ")}`
          : "skipped for routed expectation",
    },
    {
      name: "(d) browser and computer-use bootstraps execute (live-only)",
      pass: undefined,
      detail: "not provable from a rollout; exercise them in a live routed session",
    },
  ];

  const failed = assertions.filter((assertion) => assertion.pass === false);
  return {
    model,
    turnId: injection?.turnId,
    listed,
    reads,
    readCalls: readEvidence.issued,
    issuedWithoutOutput: readEvidence.issuedWithoutOutput,
    assertions,
    failed,
    ok: failed.length === 0,
  };
}

export function parseCliArgs(args) {
  let expect = "routed";
  let latest = false;
  let source;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--expect") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--expect requires routed or native");
      if (!["routed", "native"].includes(value)) throw new Error(`invalid --expect value: ${value}`);
      expect = value;
      index += 1;
    } else if (arg === "--latest") {
      if (latest) throw new Error("--latest may be supplied only once");
      latest = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (source) {
      throw new Error("only one rollout path may be supplied");
    } else {
      source = arg;
    }
  }
  if (latest && source) throw new Error("choose either a rollout path or --latest");
  if (!latest && !source) throw new Error("a rollout path or --latest is required");
  return { expect, latest, source };
}

function report(result, source) {
  console.log(`verify-skill-injection: ${path.basename(source)} (model ${result.model || "unknown"})`);
  for (const assertion of result.assertions) {
    const verdict = assertion.pass === undefined ? "LIVE" : assertion.pass ? "PASS" : "FAIL";
    console.log(`  ${verdict.padEnd(5)} ${assertion.name}: ${assertion.detail}`);
  }
  console.log(
    result.failed.length > 0
      ? `FAILED: ${result.failed.length} assertion(s)`
      : "OK: all rollout-checkable assertions passed",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-skill-injection: ${error.message}`);
    console.error(
      "Usage: verify-skill-injection.mjs <rollout.jsonl> [--expect routed|native] | --latest [--expect routed|native]",
    );
    process.exit(2);
  }
  const source = parsed.latest ? latestRollout(defaultSessionsRoot()) : parsed.source;
  if (!source) {
    console.error("verify-skill-injection: no session rollout found under ~/.codex/sessions");
    process.exit(2);
  }
  const result = analyzeRollout(readFileSync(source, "utf8").split("\n"), {
    expect: parsed.expect,
  });
  report(result, source);
  process.exit(result.ok ? 0 : 1);
}
