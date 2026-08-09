"""Prove that an install from requirements/python.txt produced a usable gateway.

`pip exited 0` is not the assertion worth making: a lock can install cleanly and
still be missing something `litellm[proxy]` needs at import time, or pin a
`litellm` that is not the one `src/install-plan.mjs` asks for. This runs inside
the freshly created `.venv` and checks, in order:

  1. the direct pins from PYTHON_REQUIREMENTS resolve to exactly those versions,
  2. every requirement `litellm` declares for its `proxy` extra is installed and
     satisfies its specifier,
  3. the proxy actually starts and answers `/health/liveliness` — the endpoint
     `src/start.mjs` blocks on before it will report the router healthy.

One Python file rather than a shell script plus a PowerShell script, because
the whole point of the job is that Linux and Windows run the same checks.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# litellm's own metadata is the source of truth for what `[proxy]` pulls in, so
# a lock that dropped half the extra fails here rather than at a user's first
# request. A handful would mean the extra metadata itself went missing.
MINIMUM_PROXY_REQUIREMENTS = 10


def fail(message: str) -> bool:
    print(f"FAIL: {message}", file=sys.stderr, flush=True)
    return False


def check_direct_pins(requirements: list[str]) -> bool:
    """requirements are the raw `name[extra]==version` strings from install-plan."""
    from importlib.metadata import PackageNotFoundError, version

    ok = True
    for raw in requirements:
        specifier, _, wanted = raw.partition("==")
        name = specifier.split("[", 1)[0].strip()
        wanted = wanted.strip()
        try:
            installed = version(name)
        except PackageNotFoundError:
            ok = fail(f"{name} is not installed, but the lock is supposed to pin {raw}")
            continue
        if installed != wanted:
            ok = fail(f"{name}=={installed} is installed but PYTHON_REQUIREMENTS asks for {wanted}")
            continue
        print(f"  ok  {name}=={installed}")
    return ok


def check_imports() -> bool:
    """A pinned dist-info is not a working import; on macOS litellm builds from
    an sdist, and a lock that resolved but produced an unimportable tree is
    exactly the failure that reaches users as a dead gateway."""
    ok = True
    for module in ("litellm", "fastapi"):
        try:
            imported = __import__(module)
        except Exception as error:  # noqa: BLE001 - any import failure is the finding
            ok = fail(f"import {module} raised {type(error).__name__}: {error}")
            continue
        print(f"  ok  import {module} -> {getattr(imported, '__version__', 'unknown')}")
    return ok


def check_proxy_extra() -> bool:
    """Every requirement litellm declares under `extra == "proxy"` must be usable."""
    from importlib.metadata import PackageNotFoundError, distribution, version

    try:
        # `packaging` is itself in the lock. If it is missing, the install did
        # not even produce litellm's own dependencies, and a traceback here
        # would bury that behind an unrelated-looking ImportError.
        from packaging.requirements import Requirement
    except ImportError:
        return fail("packaging is not installed, so the lock did not install litellm's dependencies")

    try:
        declared = distribution("litellm").requires or []
    except PackageNotFoundError:
        return fail("litellm is not installed, so its proxy extra cannot be checked")

    ok = True
    proxy_only = 0
    checked = 0
    for raw in declared:
        requirement = Requirement(raw)
        # No marker means a base dependency; it is installed either way and
        # checking it costs nothing. A marker that evaluates false under
        # extra="proxy" belongs to a different extra or a different platform.
        if requirement.marker is not None and not requirement.marker.evaluate({"extra": "proxy"}):
            continue
        if requirement.marker is not None and 'extra == "proxy"' in str(requirement.marker):
            proxy_only += 1
        checked += 1
        try:
            installed = version(requirement.name)
        except PackageNotFoundError:
            ok = fail(f"litellm[proxy] requires {raw}, which the lock did not install")
            continue
        if requirement.specifier and not requirement.specifier.contains(
            installed, prereleases=True
        ):
            ok = fail(f"litellm[proxy] requires {raw} but {requirement.name}=={installed} is installed")

    if proxy_only < MINIMUM_PROXY_REQUIREMENTS:
        ok = fail(
            f"litellm declares only {proxy_only} requirements under extra == \"proxy\"; "
            "the extra metadata looks lost rather than satisfied"
        )
    print(f"  ok  {checked} litellm requirements satisfied ({proxy_only} from the proxy extra)")
    return ok


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def stop_proxy(child: subprocess.Popen) -> None:
    """Stop the proxy, and anything it started.

    `terminate()` reaches the CLI process and nothing else. litellm leaves a
    second process behind on Windows that keeps the log file open, so the
    workspace could not be deleted afterwards and something stayed listening on
    the port. Killing the tree is the only way to end both from here.
    """
    if child.poll() is None:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(child.pid)],
                capture_output=True,
                check=False,
            )
        else:
            child.terminate()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()


def check_proxy_starts(venv: Path, timeout: float) -> bool:
    """Start the proxy the way src/start.mjs does and wait for /health/liveliness.

    The upstream is deliberately unreachable: this asks whether the process
    imports and serves, not whether it can reach a provider.
    """
    binary = venv / ("Scripts" if os.name == "nt" else "bin") / (
        "litellm.exe" if os.name == "nt" else "litellm"
    )
    if not binary.exists():
        return fail(f"the litellm entry point is missing at {binary}")

    port = free_port()
    # Deliberately not `TemporaryDirectory()`. A held handle must not fail a
    # check that has already answered: litellm writes its log into this
    # workspace, and on Windows the handle can outlive the process we waited on,
    # so the automatic cleanup raised PermissionError [WinError 32] *after*
    # /health/liveliness had returned 200 -- reporting a working gateway as a
    # broken lock. `ignore_cleanup_errors=True` would say the same thing but
    # only on Python 3.10+, and this script has to keep running wherever it is
    # pointed. A leaked temp directory is not worth a false failure; `stop_proxy`
    # is what keeps the leak from being routine.
    workspace = tempfile.mkdtemp()
    try:
        config = Path(workspace) / "litellm.yaml"
        config.write_text(
            "model_list:\n"
            "  - model_name: probe\n"
            "    litellm_params:\n"
            "      model: openai/probe\n"
            "      api_base: http://127.0.0.1:1/v1\n"
            "      api_key: sk-ci-probe\n",
            encoding="utf8",
        )
        log = Path(workspace) / "litellm.log"
        exited = None
        # The same environment src/start.mjs gives the gateway. The encoding
        # pair is not incidental: LiteLLM prints Unicode banners at startup, and
        # on a non-UTF-8 Windows code page (cp1252 on the runners) that raises
        # UnicodeEncodeError before the app finishes coming up, so the proxy
        # never serves. Omitting it here made this check fail on Windows against
        # a lock that had installed perfectly -- the script was not starting the
        # proxy the way the router does, which is the only thing it claims to
        # test. See the same constants in src/start.mjs.
        environment = {
            **os.environ,
            "LITELLM_LOG": "ERROR",
            "LITELLM_TELEMETRY": "False",
            "NO_COLOR": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
        with log.open("wb") as sink:
            child = subprocess.Popen(
                [str(binary), "--config", str(config), "--host", "127.0.0.1", "--port", str(port)],
                stdout=sink,
                stderr=subprocess.STDOUT,
                env=environment,
            )
            try:
                deadline = time.monotonic() + timeout
                url = f"http://127.0.0.1:{port}/health/liveliness"
                while time.monotonic() < deadline:
                    exited = child.poll()
                    if exited is not None:
                        break
                    try:
                        with urllib.request.urlopen(url, timeout=5) as response:
                            body = response.read().decode("utf8", "replace").strip()
                        print(f"  ok  {url} -> {response.status} {body}")
                        return True
                    except (urllib.error.URLError, OSError):
                        time.sleep(2)
            finally:
                # `exited` was recorded above, before this shutdown overwrites
                # returncode, so "the proxy crashed" is never reported as
                # "CI killed it".
                stop_proxy(child)

        # The proxy output is the diagnosis, so it is printed in full rather
        # than summarised: a transitive dependency the lock's markers excluded
        # surfaces here as an ImportError during startup, and nothing else in
        # the job would say which module it was.
        print("--- litellm output ---", file=sys.stderr)
        print(log.read_text(encoding="utf8", errors="replace")[-20000:], file=sys.stderr)
        print("--- end litellm output ---", file=sys.stderr)
        if exited is not None:
            return fail(f"the proxy exited with {exited} before it became live")
        return fail(f"the proxy did not answer /health/liveliness within {timeout}s")
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> int:
    # CI captures both streams into one log, so unbuffered stdout is what keeps
    # each FAIL next to the check that produced it.
    sys.stdout.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", required=True, type=Path, help="the environment just installed")
    parser.add_argument(
        "--requirement",
        action="append",
        default=[],
        metavar="NAME==VERSION",
        help="a PYTHON_REQUIREMENTS entry, passed through from src/install-plan.mjs",
    )
    parser.add_argument(
        "--proxy-timeout",
        type=float,
        default=240.0,
        help="seconds to wait for /health/liveliness (src/start.mjs allows 300)",
    )
    parser.add_argument("--skip-proxy", action="store_true", help="skip the liveliness check")
    arguments = parser.parse_args()

    if not arguments.requirement:
        parser.error("at least one --requirement is required")

    print(f"python {sys.version.split()[0]} on {sys.platform} ({os.name})")
    print(f"executable {sys.executable}")
    print(f"requirements {json.dumps(arguments.requirement)}")

    results = [
        ("pinned versions", check_direct_pins(arguments.requirement)),
        ("imports", check_imports()),
        ("litellm[proxy] extra", check_proxy_extra()),
    ]
    if arguments.skip_proxy:
        print("  --  proxy liveliness skipped by request")
    else:
        results.append(("proxy liveliness", check_proxy_starts(arguments.venv, arguments.proxy_timeout)))

    failed = [name for name, ok in results if not ok]
    if failed:
        print(f"\nFAILED: {', '.join(failed)}", file=sys.stderr)
        return 1
    print(f"\nOK: {len(results)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
