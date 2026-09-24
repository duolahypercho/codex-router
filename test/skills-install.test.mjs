import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CODEX_APP_TOOLS } from "../src/codex-app-tools.mjs";
import {
  approveExternalSkills,
  revokeExternalSkills,
  installedSkillsFresh,
  installSkills,
  managedSkillNames,
  packSkillNames,
  skillOwnershipPath,
  skillPackStatus,
  skillRequiredFields,
  uninstallSkills,
} from "../src/skills-install.mjs";

// The repo's skill pack, installed into a throwaway codex home.
const PACK = [
  "codex-router",
  "codex-router-media",
  "codex-app-threads",
  "codex-in-app-browser",
  "codex-computer-use",
];
const SKILL_FRONTMATTER = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---\r?\n/;
const SKILLS_MODULE_URL = new URL("../src/skills-install.mjs", import.meta.url).href;

function tempCodexHome() {
  return mkdtempSync(path.join(os.tmpdir(), "codex-skills-"));
}

function ownership(home) {
  return JSON.parse(readFileSync(skillOwnershipPath(home), "utf8"));
}

function marker(home, name) {
  return JSON.parse(
    readFileSync(path.join(home, "skills", name, ".codex-router-managed"), "utf8"),
  );
}

async function waitForPath(target, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("install copies every pack skill with its SKILL.md and the marker", () => {
  const home = tempCodexHome();
  try {
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 0);
    assert.equal(installed, PACK.length);
    for (const name of PACK) {
      const dir = path.join(home, "skills", name);
      assert.ok(existsSync(path.join(dir, "SKILL.md")), `${name}/SKILL.md installed`);
      const marker = path.join(dir, ".codex-router-managed");
      assert.ok(existsSync(marker), `${name} marker present`);
      const parsed = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(parsed.version, 1);
      assert.equal(parsed.name, name);
      assert.match(parsed.token, /^[a-f0-9]{64}$/);
      assert.equal(typeof parsed.source.packageVersion, "string");
      assert.equal(typeof parsed.source.commit, "string");
    }
    const state = ownership(home);
    assert.equal(state.version, 1);
    for (const name of PACK) assert.equal(state.skills[name].token, marker(home, name).token);
    if (process.platform !== "win32") {
      assert.equal(statSync(skillOwnershipPath(home)).mode & 0o777, 0o600);
    }
    assert.deepEqual(managedSkillNames(home).sort(), [...PACK].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install is idempotent and refreshes managed skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const first = readdirSync(path.join(home, "skills")).sort();
    const { installed } = installSkills(home, { quiet: true });
    assert.equal(installed, PACK.length);
    assert.deepEqual(readdirSync(path.join(home, "skills")).sort(), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent skill installs serialize ownership from recovery through publication", async () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const ready = path.join(home, "first-install-staged");
  try {
    for (const name of ["a-skill", "b-skill"]) {
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), `# ${name}\n`);
    }
    const environment = { ...process.env, CODEX_ROUTER_SKILLS_DIR: fakeSource };
    const first = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { writeFileSync } from "node:fs";\n` +
          `import { installSkills } from ${JSON.stringify(SKILLS_MODULE_URL)};\n` +
          `let held = false; installSkills(${JSON.stringify(home)}, { quiet: true, onStaged() { if (held) return; held = true; writeFileSync(${JSON.stringify(ready)}, "ready\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); } });\n`,
      ],
      { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForPath(ready);
    const second = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { installSkills } from ${JSON.stringify(SKILLS_MODULE_URL)}; installSkills(${JSON.stringify(home)}, { quiet: true });\n`,
      ],
      { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const [firstClose, secondClose] = await Promise.all([once(first, "close"), once(second, "close")]);
    assert.equal(firstClose[0], 0);
    assert.equal(secondClose[0], 0);
    assert.deepEqual(managedSkillNames(home), ["a-skill", "b-skill"]);
    assert.deepEqual(Object.keys(ownership(home).skills).sort(), ["a-skill", "b-skill"]);
    assert.ok(!existsSync(`${skillOwnershipPath(home)}.lock`));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("an approved external skill satisfies the pack without becoming router-owned", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    mkdirSync(path.join(home, "skills", name), { recursive: true });
    const target = path.join(home, "skills", name, "SKILL.md");
    writeFileSync(target, "# router contract\n\n# external catalog guidance\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;

    assert.deepEqual(approveExternalSkills(home, [name], { quiet: true }), [name]);
    const status = skillPackStatus(home);
    assert.deepEqual(status.managed, []);
    assert.deepEqual(status.external, [name]);
    assert.deepEqual(status.missing, []);
    assert.deepEqual(status.collisions, []);

    const before = readFileSync(target, "utf8");
    assert.deepEqual(installSkills(home, { quiet: true }), {
      installed: 0,
      skipped: 0,
      external: 1,
    });
    assert.equal(readFileSync(target, "utf8"), before);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.ok(existsSync(path.dirname(target)), "external skill survives uninstall");
    assert.deepEqual(revokeExternalSkills(home, [name], { quiet: true }), [name]);
    assert.deepEqual(skillPackStatus(home).external, []);
    assert.deepEqual(approveExternalSkills(home, [name], { quiet: true }), [name]);

    rmSync(path.dirname(target), { recursive: true, force: true });
    assert.equal(installSkills(home, { quiet: true }).installed, 1);
    const recovered = skillPackStatus(home);
    assert.deepEqual(recovered.managed, [name]);
    assert.deepEqual(recovered.external, []);
    assert.deepEqual(recovered.staleExternal, []);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("approving a former managed skill clears ownership and marker replay cannot delete it", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });
    const target = path.join(home, "skills", name);
    const oldMarker = readFileSync(path.join(target, ".codex-router-managed"), "utf8");

    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "SKILL.md"), "# independently managed\n");
    approveExternalSkills(home, [name], { quiet: true });
    const state = ownership(home);
    assert.equal(state.skills[name], undefined, "approval relinquishes stale managed ownership");
    assert.ok(state.external[name]);
    assert.deepEqual(skillPackStatus(home).staleOwnership, []);

    writeFileSync(path.join(target, ".codex-router-managed"), oldMarker);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.ok(existsSync(target), "a replayed old marker cannot authorize external deletion");
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("overlapping managed and external state fails closed", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    mkdirSync(path.join(home, "skills", name), { recursive: true });
    writeFileSync(path.join(home, "skills", name, "SKILL.md"), "# external\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    approveExternalSkills(home, [name], { quiet: true });
    const state = ownership(home);
    state.skills[name] = { token: "a".repeat(64) };
    writeFileSync(skillOwnershipPath(home), `${JSON.stringify(state, null, 2)}\n`);

    const status = skillPackStatus(home);
    assert.equal(status.ownershipStateValid, false);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.ok(existsSync(path.join(home, "skills", name)), "ambiguous state cannot delete content");
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("uninstall deletes only the quarantined managed tree when a new target appears", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const name = "codex-router";
    const target = path.join(home, "skills", name);
    const removed = uninstallSkills(home, {
      quiet: true,
      onQuarantined(event) {
        if (event.name !== name) return;
        mkdirSync(event.target, { recursive: true });
        writeFileSync(path.join(event.target, "SKILL.md"), "# concurrent external replacement\n");
      },
    });
    assert.equal(removed, PACK.length);
    assert.equal(
      readFileSync(path.join(target, "SKILL.md"), "utf8"),
      "# concurrent external replacement\n",
    );
    assert.ok(!existsSync(path.join(target, ".codex-router-managed")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a hard exit after quarantine is recovered before the next skill mutation", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# managed before crash\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { uninstallSkills } from ${JSON.stringify(SKILLS_MODULE_URL)};\n` +
          `uninstallSkills(${JSON.stringify(home)}, { quiet: true, onQuarantined() { process.exit(91); } });\n`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_SKILLS_DIR: fakeSource },
      },
    );
    assert.equal(child.status, 91, child.stderr);
    assert.ok(!existsSync(target), "the fixture exits inside the rename window");
    assert.ok(
      readdirSync(path.join(home, "skills")).some((entry) =>
        entry.startsWith(".codex-router-retire-"),
      ),
    );

    // The next install preserves the abandoned exact tree under a visible
    // random sibling, then publishes a fresh managed copy without overwrite.
    assert.deepEqual(installSkills(home, { quiet: true }), {
      installed: 1,
      skipped: 0,
      external: 0,
    });
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "# managed before crash\n");
    assert.deepEqual(managedSkillNames(home), [name]);
    const preserved = readdirSync(path.join(home, "skills")).find((entry) =>
      entry.startsWith(`${name}.codex-router-preserved-`),
    );
    assert.ok(preserved);
    assert.equal(
      readFileSync(path.join(home, "skills", preserved, "SKILL.md"), "utf8"),
      "# managed before crash\n",
    );
    assert.ok(
      !readdirSync(path.join(home, "skills")).some((entry) =>
        entry.startsWith(".codex-router-retire-"),
      ),
    );
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("a hard exit during publication rolls the partial target back to the old skill", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const source = path.join(fakeSource, name, "SKILL.md");
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "# working v1\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });
    writeFileSync(source, "# replacement v2\n");

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { installSkills } from ${JSON.stringify(SKILLS_MODULE_URL)};\n` +
          `installSkills(${JSON.stringify(home)}, { quiet: true, onPublicationClaimed() { process.exit(92); } });\n`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_SKILLS_DIR: fakeSource },
      },
    );
    assert.equal(child.status, 92, child.stderr);
    assert.ok(existsSync(path.join(target, ".codex-router-publishing")));
    assert.ok(!existsSync(path.join(target, "SKILL.md")));

    assert.deepEqual(installSkills(home, { quiet: true }), {
      installed: 1,
      skipped: 0,
      external: 0,
    });
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "# replacement v2\n");
    assert.ok(!existsSync(path.join(target, ".codex-router-publishing")));
    assert.deepEqual(managedSkillNames(home), [name]);
    const preserved = readdirSync(path.join(home, "skills")).find((entry) =>
      entry.startsWith(`${name}.codex-router-preserved-`),
    );
    assert.ok(preserved);
    assert.equal(
      readFileSync(path.join(home, "skills", preserved, "SKILL.md"), "utf8"),
      "# working v1\n",
    );
    assert.ok(
      !readdirSync(path.join(home, "skills")).some(
        (entry) => entry.startsWith(".codex-router-retire-"),
      ),
    );
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("a hard exit during first publication removes only its journal-owned partial target", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# first install\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { installSkills } from ${JSON.stringify(SKILLS_MODULE_URL)};\n` +
          `installSkills(${JSON.stringify(home)}, { quiet: true, onPublicationClaimed() { process.exit(93); } });\n`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CODEX_ROUTER_SKILLS_DIR: fakeSource },
      },
    );
    assert.equal(child.status, 93, child.stderr);
    assert.ok(existsSync(path.join(target, ".codex-router-publishing")));

    revokeExternalSkills(home, [name], { quiet: true });
    assert.ok(!existsSync(target), "the abandoned partial publication is rolled back");
    assert.ok(
      !readdirSync(path.join(home, "skills")).some((entry) =>
        entry.startsWith(".codex-router-retire-"),
      ),
    );
    assert.deepEqual(installSkills(home, { quiet: true }), {
      installed: 1,
      skipped: 0,
      external: 0,
    });
    assert.deepEqual(managedSkillNames(home), [name]);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("replacement is fully staged before the old managed skill is retired", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const source = path.join(fakeSource, name, "SKILL.md");
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "# working v1\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });
    const originalMarker = readFileSync(path.join(target, ".codex-router-managed"), "utf8");
    writeFileSync(source, "# replacement v2\n");

    assert.throws(
      () =>
        installSkills(home, {
          quiet: true,
          onStaged() {
            throw new Error("simulated staging failure");
          },
        }),
      /simulated staging failure/,
    );
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "# working v1\n");
    assert.equal(
      readFileSync(path.join(target, ".codex-router-managed"), "utf8"),
      originalMarker,
    );
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("replacement never overwrites a target created after quarantine", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const source = path.join(fakeSource, name, "SKILL.md");
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "# managed v1\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });
    writeFileSync(source, "# managed v2\n");

    const result = installSkills(home, {
      quiet: true,
      onQuarantined() {
        mkdirSync(target);
        writeFileSync(path.join(target, "SKILL.md"), "# concurrent external\n");
      },
    });
    assert.deepEqual(result, { installed: 0, skipped: 1, external: 0 });
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "# concurrent external\n");
    const preserved = readdirSync(path.join(home, "skills")).find((entry) =>
      entry.startsWith(`${name}.codex-router-preserved-`),
    );
    assert.ok(preserved, "the previous working managed tree remains visible");
    assert.equal(
      readFileSync(path.join(home, "skills", preserved, "SKILL.md"), "utf8"),
      "# managed v1\n",
    );
    assert.equal(ownership(home).skills[name], undefined);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("an invalid quarantined tree is restored or preserved, never deleted", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# managed\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });

    const removed = uninstallSkills(home, {
      quiet: true,
      onQuarantined({ staged }) {
        writeFileSync(path.join(staged, ".codex-router-managed"), "invalid\n");
        mkdirSync(target);
        writeFileSync(path.join(target, "SKILL.md"), "# external winner\n");
      },
    });
    assert.equal(removed, 0);
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "# external winner\n");
    const preserved = readdirSync(path.join(home, "skills")).find((entry) =>
      entry.startsWith(`${name}.codex-router-preserved-`),
    );
    assert.ok(preserved);
    assert.equal(
      readFileSync(path.join(home, "skills", preserved, "SKILL.md"), "utf8"),
      "# managed\n",
    );
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("restore never replaces an empty directory claimed at the no-replace boundary", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const target = path.join(home, "skills", name);
  try {
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# managed\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    installSkills(home, { quiet: true });

    assert.equal(
      uninstallSkills(home, {
        quiet: true,
        onQuarantined({ staged }) {
          writeFileSync(path.join(staged, ".codex-router-managed"), "invalid\n");
          mkdirSync(target);
        },
      }),
      0,
    );
    assert.deepEqual(readdirSync(target), [], "the competing empty claim remains untouched");
    const preserved = readdirSync(path.join(home, "skills")).find((entry) =>
      entry.startsWith(`${name}.codex-router-preserved-`),
    );
    assert.ok(preserved);
    assert.equal(
      readFileSync(path.join(home, "skills", preserved, "SKILL.md"), "utf8"),
      "# managed\n",
    );
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("install prunes approvals for skills the router no longer ships", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    mkdirSync(path.join(home, "skills", name), { recursive: true });
    writeFileSync(path.join(home, "skills", name, "SKILL.md"), "# external\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    approveExternalSkills(home, [name], { quiet: true });

    rmSync(path.join(fakeSource, name), { recursive: true, force: true });
    installSkills(home, { quiet: true });
    assert.equal(ownership(home).external?.[name], undefined);
    assert.ok(existsSync(path.join(home, "skills", name)), "obsolete external content is preserved");
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test(
  "an unreadable approved tree becomes stale instead of throwing",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
    const name = "codex-router";
    const target = path.join(home, "skills", name, "SKILL.md");
    try {
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "# external\n");
      process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
      approveExternalSkills(home, [name], { quiet: true });

      chmodSync(target, 0o000);
      const status = skillPackStatus(home);
      assert.deepEqual(status.external, []);
      assert.deepEqual(status.staleExternal, [name]);
      assert.deepEqual(status.collisions, [name]);
    } finally {
      delete process.env.CODEX_ROUTER_SKILLS_DIR;
      if (existsSync(target)) chmodSync(target, 0o600);
      rmSync(home, { recursive: true, force: true });
      rmSync(fakeSource, { recursive: true, force: true });
    }
  },
);

test(
  "external approval rejects a nested symlink",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
    try {
      const name = "codex-router";
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
      mkdirSync(path.join(home, "skills", name), { recursive: true });
      writeFileSync(path.join(home, "skills", name, "SKILL.md"), "# external\n");
      symlinkSync(path.join(fakeSource, name, "SKILL.md"), path.join(home, "skills", name, "link"));
      process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
      assert.throws(
        () => approveExternalSkills(home, [name], { quiet: true }),
        /unsupported entry/,
      );
      assert.ok(!existsSync(skillOwnershipPath(home)));
    } finally {
      delete process.env.CODEX_ROUTER_SKILLS_DIR;
      rmSync(home, { recursive: true, force: true });
      rmSync(fakeSource, { recursive: true, force: true });
    }
  },
);

test("external approval uses deterministic ordering and rejects over-deep trees", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  const name = "codex-router";
  const target = path.join(home, "skills", name);
  const originalLocaleCompare = String.prototype.localeCompare;
  try {
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "SKILL.md"), "# external\n");
    writeFileSync(path.join(target, "é"), "first\n");
    writeFileSync(path.join(target, "z"), "second\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    String.prototype.localeCompare = () => {
      throw new Error("digest ordering must not depend on the process locale");
    };
    assert.deepEqual(approveExternalSkills(home, [name], { quiet: true }), [name]);
    revokeExternalSkills(home, [name], { quiet: true });

    let nested = target;
    for (let index = 0; index < 65; index += 1) {
      nested = path.join(nested, "d");
      mkdirSync(nested);
    }
    assert.throws(
      () => approveExternalSkills(home, [name], { quiet: true }),
      /unsupported entry/,
    );
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("managed marker and freshness reads are bounded and fail closed", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const name = "codex-router";
    const target = path.join(home, "skills", name);
    const markerPath = path.join(target, ".codex-router-managed");
    truncateSync(markerPath, 64 * 1024 + 1);
    let status = skillPackStatus(home);
    assert.ok(status.staleOwnership.includes(name));
    assert.equal(uninstallSkills(home, { quiet: true }), PACK.length - 1);
    assert.ok(existsSync(target), "an oversized marker cannot authorize deletion");

    rmSync(home, { recursive: true, force: true });
    installSkills(home, { quiet: true });
    const managed = path.join(home, "skills", name);
    const large = path.join(managed, "large.bin");
    writeFileSync(large, "");
    truncateSync(large, 64 * 1024 * 1024 + 1);
    status = skillPackStatus(home);
    assert.ok(status.stale.includes(name), "oversized managed content is stale without allocation");
    rmSync(large);
    let nested = managed;
    for (let index = 0; index < 65; index += 1) {
      nested = path.join(nested, "d");
      mkdirSync(nested);
    }
    status = skillPackStatus(home);
    assert.ok(status.stale.includes(name), "over-deep managed content is stale without recursion");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ownership state has byte and entry ceilings", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const statePath = skillOwnershipPath(home);
    const original = readFileSync(statePath, "utf8");
    writeFileSync(statePath, `${original}${" ".repeat(1024 * 1024)}\n`);
    assert.equal(skillPackStatus(home).ownershipStateValid, false);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));

    const tooMany = { version: 1, skills: {} };
    for (let index = 0; index < 4_097; index += 1) {
      tooMany.skills[`skill-${index}`] = { token: "a".repeat(64) };
    }
    writeFileSync(statePath, `${JSON.stringify(tooMany)}\n`);
    assert.equal(skillPackStatus(home).ownershipStateValid, false);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("external approval fails closed when the external skill changes", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    mkdirSync(path.join(fakeSource, name), { recursive: true });
    writeFileSync(path.join(fakeSource, name, "SKILL.md"), "# router contract\n");
    mkdirSync(path.join(home, "skills", name), { recursive: true });
    const target = path.join(home, "skills", name, "SKILL.md");
    writeFileSync(target, "# router contract\n\n# reviewed extension\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    approveExternalSkills(home, [name], { quiet: true });

    writeFileSync(target, "# router contract\n\n# reviewed extension\nDO THE OPPOSITE\n");
    const status = skillPackStatus(home);
    assert.deepEqual(status.external, []);
    assert.deepEqual(status.staleExternal, [name]);
    assert.deepEqual(status.missing, [name]);
    assert.deepEqual(status.collisions, [name]);
    assert.equal(installSkills(home, { quiet: true }).skipped, 1);
    assert.match(readFileSync(target, "utf8"), /DO THE OPPOSITE/);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("external approval fails closed when the router skill contract changes", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const name = "codex-router";
    const source = path.join(fakeSource, name, "SKILL.md");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "# router contract v1\n");
    mkdirSync(path.join(home, "skills", name), { recursive: true });
    writeFileSync(path.join(home, "skills", name, "SKILL.md"), "# external reviewed v1\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    approveExternalSkills(home, [name], { quiet: true });

    writeFileSync(source, "# router contract v2\n");
    const status = skillPackStatus(home);
    assert.deepEqual(status.external, []);
    assert.deepEqual(status.staleExternal, [name]);
    assert.deepEqual(status.missing, [name]);
    assert.deepEqual(status.collisions, [name]);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});
test("install never clobbers a skill the user owns", () => {
  const home = tempCodexHome();
  try {
    mkdirSync(path.join(home, "skills", "codex-app-threads"), { recursive: true });
    writeFileSync(
      path.join(home, "skills", "codex-app-threads", "SKILL.md"),
      "# user's own skill\n",
    );
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(skipped, 1);
    assert.equal(installed, PACK.length - 1);
    // The user's file is untouched; no marker was added.
    assert.equal(
      readFileSync(path.join(home, "skills", "codex-app-threads", "SKILL.md"), "utf8"),
      "# user's own skill\n",
    );
    assert.ok(
      !existsSync(path.join(home, "skills", "codex-app-threads", ".codex-router-managed")),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an arbitrary or legacy marker never grants ownership", () => {
  const home = tempCodexHome();
  try {
    const dir = path.join(home, "skills", "codex-app-threads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# user's marked skill\n");
    writeFileSync(path.join(dir, ".codex-router-managed"), "x\n");
    const result = installSkills(home, { quiet: true });
    assert.equal(result.skipped, 1);
    assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# user's marked skill\n");
    assert.ok(!managedSkillNames(home).includes("codex-app-threads"));
    uninstallSkills(home, { quiet: true });
    assert.ok(existsSync(dir), "marker-only directory preserved by uninstall");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a valid-looking marker without matching private state is still user-owned", () => {
  const home = tempCodexHome();
  try {
    const dir = path.join(home, "skills", "codex-router");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# mine\n");
    writeFileSync(
      path.join(dir, ".codex-router-managed"),
      `${JSON.stringify({
        version: 1,
        name: "codex-router",
        token: "a".repeat(64),
        source: { packageVersion: "1.0.0", commit: "deadbeef" },
      })}\n`,
    );
    assert.equal(installSkills(home, { quiet: true }).skipped, 1);
    assert.equal(readFileSync(path.join(dir, "SKILL.md"), "utf8"), "# mine\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall removes exactly the managed skills, never user skills", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // A decoy user skill that happens to share the pack's naming space.
    mkdirSync(path.join(home, "skills", "user-custom-skill"), { recursive: true });
    writeFileSync(path.join(home, "skills", "user-custom-skill", "SKILL.md"), "# mine\n");
    const removed = uninstallSkills(home, { quiet: true });
    assert.equal(removed, PACK.length);
    assert.ok(!existsSync(path.join(home, "skills", "codex-router")));
    assert.ok(!existsSync(path.join(home, "skills", "codex-app-threads")));
    // The user's skill survives.
    assert.ok(existsSync(path.join(home, "skills", "user-custom-skill")));
    assert.deepEqual(managedSkillNames(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall on a clean home is a no-op", () => {
  const home = tempCodexHome();
  try {
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    assert.equal(installSkills(home, { quiet: true }).installed, PACK.length);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install prunes stale managed dirs the pack no longer ships", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    // Simulate a pack skill being removed in a later revision: plant a
    // managed dir that no longer exists in the source.
    const stale = path.join(home, "skills", "codex-obsolete");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "SKILL.md"), "# obsolete\n");
    const state = ownership(home);
    const token = "b".repeat(64);
    state.skills["codex-obsolete"] = { token };
    writeFileSync(skillOwnershipPath(home), `${JSON.stringify(state, null, 2)}\n`);
    const source = marker(home, "codex-router").source;
    writeFileSync(
      path.join(stale, ".codex-router-managed"),
      `${JSON.stringify({ version: 1, name: "codex-obsolete", token, source }, null, 2)}\n`,
    );
    installSkills(home, { quiet: true });
    assert.ok(!existsSync(stale), "stale managed dir removed");
    assert.ok(existsSync(path.join(home, "skills", "codex-router")), "current skills kept");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("state and marker mismatch preserves the directory and clears ownership", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const name = "codex-router";
    const dir = path.join(home, "skills", name);
    const parsed = marker(home, name);
    parsed.token = "c".repeat(64);
    writeFileSync(path.join(dir, ".codex-router-managed"), `${JSON.stringify(parsed)}\n`);
    assert.ok(skillPackStatus(home).staleOwnership.includes(name));
    assert.equal(uninstallSkills(home, { quiet: true }), PACK.length - 1);
    assert.ok(existsSync(dir), "mismatched target preserved");
    assert.deepEqual(managedSkillNames(home), []);
    assert.ok(!ownership(home).skills[name], "stale private record cleared");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a regular-file collision is preserved and status never throws", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const collision = path.join(home, "skills", "codex-router");
    rmSync(collision, { recursive: true, force: true });
    writeFileSync(collision, "user file\n");
    const { installed, skipped } = installSkills(home, { quiet: true });
    assert.equal(installed, PACK.length - 1);
    assert.equal(skipped, 1);
    assert.equal(readFileSync(collision, "utf8"), "user file\n");
    const status = skillPackStatus(home);
    assert.ok(status.collisions.includes("codex-router"));
    assert.ok(status.missing.includes("codex-router"));
    assert.ok(!ownership(home).skills["codex-router"], "stale state entry cleared");
    const freshness = installedSkillsFresh(home);
    assert.equal(freshness.fresh, false);
    assert.ok(freshness.stale.includes("codex-router"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "a symlink collision is preserved",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    const userDir = mkdtempSync(path.join(os.tmpdir(), "codex-user-skill-"));
    try {
      installSkills(home, { quiet: true });
      writeFileSync(path.join(userDir, "SKILL.md"), "# mine\n");
      const collision = path.join(home, "skills", "codex-router");
      rmSync(collision, { recursive: true, force: true });
      symlinkSync(userDir, collision, "dir");
      assert.equal(installSkills(home, { quiet: true }).skipped, 1);
      assert.equal(readFileSync(path.join(userDir, "SKILL.md"), "utf8"), "# mine\n");
      assert.ok(!ownership(home).skills["codex-router"], "stale state entry cleared");
      uninstallSkills(home, { quiet: true });
      assert.ok(existsSync(collision), "symlink remains after uninstall");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    }
  },
);

test("corrupt private ownership state fails closed", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    writeFileSync(skillOwnershipPath(home), "{not json\n");
    const status = skillPackStatus(home);
    assert.equal(status.ownershipStateValid, false);
    assert.deepEqual(status.managed, []);
    assert.deepEqual(status.collisions, [...PACK].sort());
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) {
      assert.ok(existsSync(path.join(home, "skills", name)), `${name} preserved`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("one malformed ownership record invalidates the whole state file", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const state = ownership(home);
    state.skills.invalid = { token: "short" };
    writeFileSync(skillOwnershipPath(home), `${JSON.stringify(state)}\n`);
    const status = skillPackStatus(home);
    assert.equal(status.ownershipStateValid, false);
    assert.deepEqual(status.managed, []);
    assert.equal(uninstallSkills(home, { quiet: true }), 0);
    for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "an ownership file with public permissions fails closed",
  { skip: process.platform === "win32" },
  () => {
    const home = tempCodexHome();
    try {
      installSkills(home, { quiet: true });
      chmodSync(skillOwnershipPath(home), 0o644);
      const status = skillPackStatus(home);
      assert.equal(status.ownershipStateValid, false);
      assert.deepEqual(status.managed, []);
      assert.deepEqual(status.missing, [...PACK].sort());
      assert.equal(uninstallSkills(home, { quiet: true }), 0);
      for (const name of PACK) assert.ok(existsSync(path.join(home, "skills", name)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test("install skips hidden directories and dirs without SKILL.md", () => {
  const home = tempCodexHome();
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    // A hidden dir and a non-skill dir in the source must never be copied.
    mkdirSync(path.join(fakeSource, ".hidden"), { recursive: true });
    mkdirSync(path.join(fakeSource, "no-skill-dir"), { recursive: true });
    for (const name of PACK) {
      mkdirSync(path.join(fakeSource, name), { recursive: true });
      writeFileSync(path.join(fakeSource, name, "SKILL.md"), `# ${name}\n`);
    }
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    try {
      const { installed } = installSkills(home, { quiet: true });
      assert.equal(installed, PACK.length);
      const installedNames = readdirSync(path.join(home, "skills")).sort();
      assert.ok(!installedNames.includes(".hidden"), "hidden dir not copied");
      assert.ok(!installedNames.includes("no-skill-dir"), "no-SKILL.md dir not copied");
    } finally {
      delete process.env.CODEX_ROUTER_SKILLS_DIR;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

test("packSkillNames lists exactly the shipped pack", () => {
  const names = packSkillNames();
  assert.deepEqual(names, [...PACK].sort());
});

test("installedSkillsFresh is true after install and false after a manual edit", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    assert.deepEqual(installedSkillsFresh(home), { fresh: true, stale: [] });
    // A user edits a managed skill: freshness must flag it.
    const target = path.join(home, "skills", "codex-app-threads", "SKILL.md");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n# local edit\n`);
    const { fresh, stale } = installedSkillsFresh(home);
    assert.equal(fresh, false);
    assert.ok(stale.includes("codex-app-threads"));
    // Re-install restores freshness.
    installSkills(home, { quiet: true });
    assert.equal(installedSkillsFresh(home).fresh, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("freshness includes unexpected hidden files but ignores only the ownership marker", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    const dir = path.join(home, "skills", "codex-router");
    writeFileSync(path.join(dir, ".unexpected"), "drift\n");
    assert.equal(installedSkillsFresh(home).fresh, false);
    rmSync(path.join(dir, ".unexpected"));
    writeFileSync(path.join(dir, ".codex-router-managed"), "changed marker only\n");
    assert.equal(installedSkillsFresh(home).fresh, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installedSkillsFresh flags a missing managed skill", () => {
  const home = tempCodexHome();
  try {
    installSkills(home, { quiet: true });
    rmSync(path.join(home, "skills", "codex-router"), { recursive: true, force: true });
    const { fresh, stale } = installedSkillsFresh(home);
    assert.equal(fresh, false);
    assert.ok(stale.includes("codex-router"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the skill's declared required fields match the app snapshot", () => {
  const codexApp = CODEX_APP_TOOLS.find((entry) => entry.name === "codex_app");
  assert.ok(codexApp, "codex_app namespace present in snapshot");
  const byName = new Map(codexApp.tools.map((fn) => [fn.name, fn]));
  const expected = skillRequiredFields();
  assert.deepEqual(expected, {
    create_thread: ["prompt", "target"],
    read_thread: ["threadId"],
    send_message_to_thread: ["threadId", "prompt"],
  });
  for (const [name, want] of Object.entries(expected)) {
    const fn = byName.get(name);
    assert.ok(fn, `snapshot carries ${name}`);
    assert.deepEqual(
      [...(fn.inputSchema?.required || [])].sort(),
      [...want].sort(),
      `${name} required fields match the skill pack`,
    );
  }
  // The skills text must actually say create_thread needs prompt AND target.
  const threadsSkill = readFileSync(
    path.join(skillsRoot(), "codex-app-threads", "SKILL.md"),
    "utf8",
  );
  assert.match(threadsSkill, /requires TWO fields: `prompt` \(string\) and `target`/);
  // The optional keys drift too, and the drift is not cosmetic: the skill is
  // what a routed model reads instead of guessing. Text that says create_thread
  // takes no key beyond `title` tells the model its own `model` argument is
  // illegal, which is exactly the cross-model delegation the relay preserves
  // (`injectSessionModelForSpawnCalls` rewrites only an omitted model). Assert
  // every optional property the snapshot carries is named in the skill.
  for (const [name, heading] of [
    ["create_thread", "## Create a thread"],
    ["send_message_to_thread", "## Send a message to a thread"],
  ]) {
    const fn = byName.get(name);
    const required = new Set(fn?.inputSchema?.required || []);
    const optional = Object.keys(fn?.inputSchema?.properties || {})
      .filter((key) => !required.has(key));
    assert.ok(optional.length > 0, `${name} has optional properties`);
    const start = threadsSkill.indexOf(heading);
    assert.ok(start >= 0, `skill documents ${name}`);
    const nextHeading = threadsSkill.indexOf("\n## ", start + heading.length);
    const section = threadsSkill.slice(start, nextHeading < 0 ? undefined : nextHeading);
    for (const key of optional) {
      assert.ok(
        section.includes(`\`${key}\``),
        `${name} section names its optional \`${key}\` argument`,
      );
    }
  }
  // And it must not tell a routed model that a routed model slug is invalid.
  assert.doesNotMatch(threadsSkill, /No other top-level keys are allowed/);
});

test("a missing or malformed skill contract is reported as unavailable", () => {
  const fakeSource = mkdtempSync(path.join(os.tmpdir(), "codex-skills-source-"));
  try {
    const dir = path.join(fakeSource, "codex-app-threads");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# no contract\n");
    process.env.CODEX_ROUTER_SKILLS_DIR = fakeSource;
    assert.equal(skillRequiredFields(), undefined);
    writeFileSync(
      path.join(dir, "SKILL.md"),
      '<!-- codex-router-required-fields: {"create_thread":"prompt"} -->\n',
    );
    assert.equal(skillRequiredFields(), undefined);
  } finally {
    delete process.env.CODEX_ROUTER_SKILLS_DIR;
    rmSync(fakeSource, { recursive: true, force: true });
  }
});

function skillsRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
}

test("skill frontmatter accepts LF and CRLF checkouts", () => {
  const lf = "---\nname: example\ndescription: Use when testing.\n---\n";
  assert.ok(SKILL_FRONTMATTER.exec(lf));
  assert.ok(SKILL_FRONTMATTER.exec(lf.replaceAll("\n", "\r\n")));
});

test("every pack skill has valid frontmatter, a trigger description, and stays short", () => {
  const skillsRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
  );
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(skillsRoot, e.name, "SKILL.md")))
    .map((e) => e.name);
  assert.ok(names.length >= 4, `pack has at least the 4 core skills, got ${names.length}`);
  for (const name of names) {
    const text = readFileSync(path.join(skillsRoot, name, "SKILL.md"), "utf8");
    // Frontmatter parses: name matches the directory, description present.
    const match = SKILL_FRONTMATTER.exec(text);
    assert.ok(match, `${name}: valid frontmatter`);
    assert.equal(match[1], name, `${name}: frontmatter name matches directory`);
    // The description is what the model matches on; it must carry triggers.
    assert.match(match[2], /Use when/, `${name}: description has "Use when" triggers`);
    // Every description is scoped to custom routed models so a native GPT
    // session never triggers a skill that teaches flattened names it lacks.
    assert.match(
      match[2],
      /custom \(non-OpenAI\) model/,
      `${name}: description scoped to custom models`,
    );
    assert.ok(match[2].length <= 1024, `${name}: description within 1024 chars`);
    // Keep the pack cheap to load: short file, no emoji, no time-sensitive data.
    assert.ok(text.split("\n").length <= 100, `${name}: SKILL.md under 100 lines`);
    assert.doesNotMatch(text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${name}: no emoji`);
    assert.doesNotMatch(text, /20\d\d-\d\d-\d\d/, `${name}: no hardcoded dates`);
  }
});
