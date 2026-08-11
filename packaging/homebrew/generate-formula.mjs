import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// LiteLLM imports this only when LITELLM_ENABLE_PYROSCOPE is explicitly set.
// PyPI publishes platform wheels but no source distribution, while Homebrew
// formula resources are source-built for every supported architecture. The
// router never enables that optional profiler, so omitting it is safer than
// smuggling architecture-specific wheels into an otherwise portable formula.
//
// hf-xet is huggingface-hub's optional Xet download accelerator, reached only
// through litellm; nothing here imports huggingface_hub, and the hub falls back
// to plain HTTP transfers without it. It cannot be source-built under Homebrew
// at all: its aws-lc-sys dependency vendors jitterentropy, whose
// jitterentropy-base.c refuses to compile unless optimization is off, and
// Homebrew's superenv shim appends -Os after the crate's own -O0.
export const EXCLUDED_OPTIONAL_RESOURCES = new Set(["pyroscope-io", "hf-xet"]);

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) throw new Error(`Invalid Python version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function markerApplies(marker, pythonVersion) {
  if (!marker) return true;
  const normalized = marker.trim().replace(/\s+/g, " ");
  if (normalized === "implementation_name != 'PyPy'") return true;
  if (normalized === "sys_platform != 'win32'") return true;
  if (normalized === "sys_platform == 'win32'") return false;
  if (
    normalized ===
    "platform_machine == 'AMD64' or platform_machine == 'aarch64' or platform_machine == 'amd64' or platform_machine == 'arm64' or platform_machine == 'x86_64'"
  ) {
    return true;
  }
  const versionMatch =
    /^python_full_version (==|>=|<) '(\d+\.\d+(?:\.\d+)?)(\.\*)?'$/.exec(
      normalized,
    );
  if (!versionMatch) {
    throw new Error(`Unsupported Python lock marker: ${marker}`);
  }
  const installed = versionTuple(pythonVersion);
  const wanted = versionTuple(versionMatch[2]);
  if (versionMatch[1] === "==") {
    return versionMatch[3]
      ? installed[0] === wanted[0] && installed[1] === wanted[1]
      : compareVersions(installed, wanted) === 0;
  }
  const comparison = compareVersions(installed, wanted);
  return versionMatch[1] === ">=" ? comparison >= 0 : comparison < 0;
}

export function lockedRequirements(contents, pythonVersion) {
  const requirements = [];
  // Hashes trail their requirement on continuation lines. Track which entry is
  // being read so a requirement the markers excluded cannot donate its hashes
  // to whichever one happened to be selected before it.
  let current = null;
  for (const line of contents.split(/\r?\n/)) {
    const match =
      /^([A-Za-z0-9_.-]+)==([^\s;\\]+)(?:\s*;\s*(.*?))?\s*\\?$/.exec(
        line,
      );
    if (match) {
      current = markerApplies(match[3], pythonVersion)
        ? { name: match[1], version: match[2], hashes: new Set() }
        : null;
      if (current) requirements.push(current);
      continue;
    }
    const hash = /^\s*--hash=sha256:([a-f0-9]{64})\s*\\?$/.exec(line);
    if (hash && current) current.hashes.add(hash[1]);
  }
  const duplicates = requirements.filter(
    (requirement, index) =>
      requirements.findIndex(
        (candidate) =>
          candidate.name.toLowerCase().replaceAll("_", "-") ===
          requirement.name.toLowerCase().replaceAll("_", "-"),
      ) !== index,
  );
  if (duplicates.length) {
    throw new Error(
      `The selected Python version resolves multiple versions of: ${[
        ...new Set(duplicates.map((requirement) => requirement.name)),
      ].join(", ")}`,
    );
  }
  if (!requirements.some(({ name }) => name.toLowerCase() === "litellm")) {
    throw new Error("The Python lock did not select LiteLLM.");
  }
  return requirements;
}

export async function pypiResource(requirement, fetchImpl = fetch) {
  const endpoint = `https://pypi.org/pypi/${encodeURIComponent(requirement.name)}/${encodeURIComponent(requirement.version)}/json`;
  const response = await fetchImpl(endpoint);
  if (!response.ok) {
    throw new Error(
      `PyPI metadata failed for ${requirement.name}==${requirement.version}: HTTP ${response.status}`,
    );
  }
  const metadata = await response.json();
  const sourceDistributions = (metadata.urls || []).filter(
    (file) => file.packagetype === "sdist" && file.url && file.digests?.sha256,
  );
  const selected =
    sourceDistributions.find((file) => file.filename.endsWith(".tar.gz")) ||
    sourceDistributions.find((file) => file.filename.endsWith(".zip")) ||
    sourceDistributions[0];
  if (!selected) {
    throw new Error(
      `PyPI publishes no source distribution for ${requirement.name}==${requirement.version}.`,
    );
  }
  // The lock is the security boundary, so the checksum baked into the formula
  // has to come from it rather than from whatever PyPI reports at generation
  // time. Fail closed: an entry with no recorded hashes cannot be vouched for
  // either, and this runs unattended on every release.
  const locked = requirement.hashes;
  if (!locked || locked.size === 0) {
    throw new Error(
      `The Python lock records no hashes for ${requirement.name}==${requirement.version}; refusing to trust PyPI alone.`,
    );
  }
  if (!locked.has(selected.digests.sha256)) {
    throw new Error(
      `PyPI's source distribution for ${requirement.name}==${requirement.version} (sha256 ${selected.digests.sha256}) is not in the Python lock. Regenerate the lock with bin/lock-python rather than trusting this download.`,
    );
  }
  return {
    ...requirement,
    url: selected.url,
    sha256: selected.digests.sha256,
  };
}

export async function resolveResources(requirements, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const concurrency = options.concurrency || 8;
  const resources = new Array(requirements.length);
  const errors = [];
  let next = 0;
  async function worker() {
    while (next < requirements.length) {
      const index = next;
      next += 1;
      try {
        resources[index] = await pypiResource(requirements[index], fetchImpl);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, requirements.length) },
      () => worker(),
    ),
  );
  if (errors.length) {
    throw new AggregateError(errors, "One or more Python resources could not be resolved.");
  }
  return resources;
}

function rubyString(value) {
  return JSON.stringify(String(value));
}

function rubyStringArray(values) {
  return `[${[...values].map(rubyString).join(", ")}]`;
}

// Resources that ship their own Rust workspace and cannot build under the
// compiler environment Homebrew hands to an ordinary C extension. Keep this as
// tight as the evidence allows: every name added here gives up the superenv
// flags the rest of the tree depends on. The install block explains what each
// one needs and why.
export const RELAXED_TOOLCHAIN_RESOURCES = new Set([
  "litellm",
  "polars",
  "polars-runtime-32",
]);

export function renderFormula({
  version,
  sourceUrl,
  sourceSha256,
  pythonFormula,
  pythonVersion,
  resources,
  excludedResources = [],
}) {
  const resourceBlocks = resources
    .map(
      (resource) => `  resource ${rubyString(resource.name)} do
    url ${rubyString(resource.url)}
    sha256 ${rubyString(resource.sha256)}
  end`,
    )
    .join("\n\n");
  const exclusionComment = excludedResources.length
    ? `  # Optional LiteLLM resources omitted because PyPI publishes no portable source:\n${excludedResources
        .map((resource) => `  # - ${resource.name}==${resource.version}`)
        .join("\n")}\n\n`
    : "";
  return `class CodexRouter < Formula
  include Language::Python::Virtualenv

  desc "Use external coding models inside the Codex App and CLI"
  homepage "https://github.com/duolahypercho/codex-router"
  url ${rubyString(sourceUrl)}
  sha256 ${rubyString(sourceSha256)}
  license "MIT"

  depends_on "pkgconf" => :build
  depends_on "rust" => :build
  depends_on "libsndfile"
  # Homebrew's superenv exports SODIUM_INSTALL=system for every build, so PyNaCl
  # skips the libsodium it vendors and expects one to already be present. Without
  # this its _sodium.c cannot find sodium.h. See Homebrew's extend/ENV/super.rb.
  depends_on "libsodium"
  depends_on "libyaml"
  depends_on "node"
  depends_on ${rubyString(pythonFormula)}

${exclusionComment}${resourceBlocks}

  def install
    libexec.install Dir["*"]
    cd libexec do
      system "npm", "install", *std_npm_args(prefix: false), "--omit=dev"
      venv = virtualenv_create(libexec/".venv", ${rubyString(`python${pythonVersion}`)})
      # Only the resources that carry their own Rust workspace need the relaxed
      # toolchain below. Everything else must keep Homebrew's standard superenv:
      # PyNaCl configures a bundled libsodium and silently skips it without the
      # flags superenv injects, leaving _sodium.c unable to find sodium.h.
      # pip_install passes --no-deps, so splitting the set is safe -- every
      # version here is already pinned by the lock.
      relaxed, standard = resources.partition do |resource|
        ${rubyStringArray(RELAXED_TOOLCHAIN_RESOURCES)}.include?(resource.name)
      end
      # A PyO3 extension module leaves the Python C API symbols it calls to be
      # resolved by the interpreter at load time, so linking one on macOS needs
      # -undefined dynamic_lookup. maturin supplies that itself for some projects
      # and not others -- polars gets it, tokenizers does not, and tokenizers
      # fails with hundreds of undefined _Py* symbols. Non-Rust resources ignore
      # the flag, and Linux must not receive this macOS linker option.
      ENV.append_to_rustflags "-C link-arg=-Wl,-undefined,dynamic_lookup" if OS.mac?
      venv.pip_install standard
      # Homebrew's superenv shim strips every -O flag the caller passes and
      # substitutes HOMEBREW_OPTIMIZATION_LEVEL. That breaks a Rust resource
      # built through cc-rs whose vendored C insists on its own level:
      # litellm's python-bridge pulls aws-lc-sys, whose jitterentropy refuses
      # to compile unless optimization is off, and its deliberate -O0 never
      # survives. Dropping "O" from HOMEBREW_CCCFG turns that rewriting off;
      # cargo already picks correct release flags on its own.
      #
      # polars-runtime-32 turns on foldhash's "nightly" cargo feature, whose
      # #![feature(hasher_prefixfree_extras)] stable rustc rejects outright
      # (E0554). Polars publishes wheels built on a nightly toolchain and
      # Homebrew ships only stable, so the escape hatch upstream relies on is
      # the only way through. polars is not optional here: litellm declares it
      # under the "proxy" extra, and the proxy is what this router runs.
      #
      # polars also asks for thin LTO plus debug line tables, and linking it
      # that way needs far more scratch space than the crate itself: a machine
      # without tens of spare gigabytes fails as an LLVM write error,
      # surfacing only as a rustc SIGSEGV. Neither setting changes what the
      # router does with polars, so drop both rather than require headroom.
      with_env(
        HOMEBREW_CCCFG:                        ENV.fetch("HOMEBREW_CCCFG", "").delete("O"),
        RUSTC_BOOTSTRAP:                       "1",
        CARGO_PROFILE_RELEASE_LTO:             "false",
        CARGO_PROFILE_RELEASE_DEBUG:           "false",
        CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: "off",
      ) do
        venv.pip_install relaxed
      end
      # Older release archives predate the dependency fingerprint helper. The
      # dependencies are already installed at this point, so those archives
      # remain usable; newer releases record fingerprints for faster updates.
      install_plan = libexec/"src/install-plan.mjs"
      if install_plan.exist?
        system formula_opt_bin("node")/"node", install_plan, "record", "node-deps"
        system formula_opt_bin("node")/"node", install_plan, "record", "python-deps"
      end
    end

    (bin/"codex-router").write <<~SH
      #!/bin/sh
      source_root=$(CDPATH= cd -- "#{opt_libexec}" && pwd -P)
      export PATH="#{formula_opt_bin("node")}:$PATH"
      export CODEX_ROUTER_SOURCE_ROOT="$source_root"
      export CODEX_ROUTER_NODE_BIN="#{formula_opt_bin("node")}/node"
      export CODEX_ROUTER_PACKAGE_MANAGER=homebrew
      exec "$source_root/bin/model-router" codex "$@"
    SH
  end

  def post_install
    state_root = ENV["MODEL_ROUTER_STATE_DIR"] || ENV["CODEX_ROUTER_STATE_DIR"] ||
                 ENV["KIMI_CODEX_STATE_DIR"] || (Pathname(Dir.home)/".codex/codex-router")
    manifest_path = Pathname(state_root)/"install-manifest.json"
    return unless manifest_path.exist?

    manifest = JSON.parse(manifest_path.read)
    return if manifest.dig("current", "packageManager") != "homebrew"

    system bin/"codex-router", "install"
  rescue JSON::ParserError
    opoo "Existing Codex Router install manifest is invalid; run \`codex-router setup\`."
  end

  def caveats
    <<~EOS
      Finish the one-time Codex integration with:
        codex-router setup --guided

      Before \`brew uninstall codex-router\`, remove the per-user service and
      managed Codex config with:
        codex-router uninstall
    EOS
  end

  test do
    output = shell_output("#{bin}/codex-router providers list --json")
    assert_match '"providers":', output
    assert_match '"anthropic-api"', output
    system formula_opt_bin("node")/"node", "--input-type=module", "--eval",
           "import('#{libexec}/node_modules/proper-lockfile/index.js')"
    system libexec/".venv/bin/python", "-c", "import fastapi, litellm"
  end
end
`;
}

// Where a generated formula lives so this repository doubles as its own tap.
// Homebrew reads formulae from Formula/, HomebrewFormula/, or the repository
// root, so users can `brew tap` this URL directly instead of needing a second
// homebrew-prefixed repository.
export const FORMULA_PATH = "Formula/codex-router.rb";

// Single path from the lock to formula text. The release job and the drift
// check both go through here so neither can quietly build it a different way.
export async function buildFormula({
  version,
  sourceUrl,
  sourceSha256,
  pythonFormula,
  pythonVersion,
  detailed = false,
}) {
  versionTuple(pythonVersion);
  const lockPath = path.join(sourceRoot, "requirements", "python.txt");
  if (!existsSync(lockPath)) throw new Error(`Python lock not found: ${lockPath}`);
  const locked = lockedRequirements(readFileSync(lockPath, "utf8"), pythonVersion);
  const isExcluded = (requirement) =>
    EXCLUDED_OPTIONAL_RESOURCES.has(requirement.name.toLowerCase());
  const excludedResources = locked.filter(isExcluded);
  const resources = await resolveResources(locked.filter((r) => !isExcluded(r)));
  const formula = renderFormula({
    version,
    sourceUrl,
    sourceSha256,
    pythonFormula,
    pythonVersion,
    resources,
    excludedResources,
  });
  return detailed ? { formula, resources, excludedResources } : formula;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const version = option(args, "--version");
  const sourceUrl = option(args, "--source-url");
  const sourceSha256 = option(args, "--source-sha256");
  const pythonFormula = option(args, "--python-formula") || "python@3.14";
  const pythonVersion = option(args, "--python-version") || "3.14";
  const output = option(args, "--output");
  if (
    !version ||
    !sourceUrl ||
    !/^[a-f0-9]{64}$/.test(sourceSha256 || "") ||
    !output
  ) {
    throw new Error(
      "Usage: generate-formula.mjs --version VERSION --source-url URL --source-sha256 SHA256 --output PATH [--python-formula NAME --python-version X.Y]",
    );
  }
  if (!/^https:\/\//.test(sourceUrl) && !args.includes("--allow-local-source")) {
    throw new Error("The formula source URL must use HTTPS.");
  }
  if (!/^[A-Za-z0-9@._+-]+$/.test(pythonFormula)) {
    throw new Error(`Invalid Python formula name: ${pythonFormula}`);
  }
  const { formula, resources, excludedResources } = await buildFormula({
    version,
    sourceUrl,
    sourceSha256,
    pythonFormula,
    pythonVersion,
    detailed: true,
  });
  writeFileSync(path.resolve(output), formula, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      output: path.resolve(output),
      resources: resources.length,
      excluded: excludedResources.map(({ name, version: resourceVersion }) =>
        `${name}==${resourceVersion}`,
      ),
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message =
      error instanceof AggregateError
        ? [error.message, ...error.errors.map((item) => `- ${item.message || item}`)].join("\n")
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(message);
    process.exit(1);
  });
}
