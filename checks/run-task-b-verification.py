"""Independently grade a staged ForgeLens candidate against the official Flask commit.

Run with a Python environment containing Flask's test dependencies. The checker
executes the candidate in a disposable checkout. Use a trusted or isolated host.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile


FLASK_COMMIT = "22d924701a6ae2e4cd01e9a15bbaf3946094af65"
SENSITIVE = [
    prefix + token + suffix
    for token in ("SECRET", "PASSWORD", "TOKEN", "KEY")
    for prefix, suffix in (("", "_A"), ("X", "_B"), ("PREFIX_", ""))
] + ["aPi_kEy_vAlUe", "SessionToken", "DatabasePassword", "MixedSecret"]
VISIBLE = {"BENIGN_TEXT": "ordinary", "RETRIES": 7, "ENABLED": True}


def run(args, cwd, env, timeout=240):
    return subprocess.run(
        args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        encoding="utf8", errors="replace", timeout=timeout, check=False,
    )


def git(cwd, env, *args):
    proc = run(["git", "-c", "core.autocrlf=false", *args], cwd, env)
    if proc.returncode:
        raise RuntimeError(f"git {args[0]} exited {proc.returncode}")
    return proc.stdout


def test_nodes(root, env):
    result = run([sys.executable, "-m", "pytest", "--collect-only", "-q",
                  "-p", "no:cacheprovider", "tests"], root, env)
    if result.returncode:
        raise RuntimeError("pytest could not collect Flask's tests")
    return {line.strip() for line in result.stdout.splitlines() if line.startswith("tests/") and "::" in line}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flask", type=Path, help="Local clone containing the official commit")
    parser.add_argument("evidence", type=Path, help="Directory containing the harness proposals.json")
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    proposals = json.loads((evidence / "proposals.json").read_text(encoding="utf8"))
    if not isinstance(proposals, dict) or not 1 <= len(proposals) <= 50:
        raise ValueError("Expected a bounded JSON object of proposed file contents")
    env = {name: value for name, value in os.environ.items() if name.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"
    }}
    env.update(PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_NOSYSTEM="1",
               GIT_CONFIG_GLOBAL=os.devnull, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    with tempfile.TemporaryDirectory(prefix="forgelens-grade-") as tmp:
        scratch = Path(tmp)
        root = scratch / "flask"
        git(scratch, env, "clone", "--local", "--no-hardlinks", "--no-checkout", str(args.flask.resolve()), str(root))
        git(root, env, "checkout", "--detach", FLASK_COMMIT)
        if git(root, env, "rev-parse", "HEAD").strip() != FLASK_COMMIT:
            raise ValueError("Unexpected upstream commit")
        env["PYTHONPATH"] = os.pathsep.join([str(root / "src"), str(scratch)])
        before = test_nodes(root, env)
        for name, contents in proposals.items():
            item = PurePosixPath(name)
            if (not re.fullmatch(r"[A-Za-z0-9_.\-/]+", name) or item.is_absolute()
                    or item.as_posix() != name or any(part == ".." or part.startswith(".") for part in item.parts)
                    or not isinstance(contents, str) or "\x00" in contents or len(contents) > 250000):
                raise ValueError("Candidate contains an unsupported file")
            target = root.joinpath(*item.parts)
            if not target.resolve().is_relative_to(root) or any(parent.is_symlink() for parent in [target, *target.parents] if parent.is_relative_to(root)):
                raise ValueError("Candidate contains a symlink")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents.encode("utf8"))
        git(root, env, "add", "--intent-to-add", "--", *proposals)
        patch = git(root, env, "diff", "--binary", "--no-ext-diff", "HEAD")
        (evidence / "candidate.patch").write_bytes(patch.encode("utf8"))
        after = test_nodes(root, env)
        new_tests = sorted(after - before)
        all_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], root, env)
        cli_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_cli.py"], root, env)
        additional_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--", *new_tests], root, env) if new_tests else None
        help_text = run([sys.executable, "-m", "flask", "--help"], root, env)
        values = {name: "fixture-" + str(i) for i, name in enumerate(SENSITIVE)}
        (scratch / "grading_fixture.py").write_text(
            "from flask import Flask\napp = Flask(__name__)\napp.config.update("
            + repr({**values, **VISIBLE}) + ")\n", encoding="utf8")
        output = run([sys.executable, "-m", "flask", "--app", "grading_fixture:app", "config"], root, env)
        try:
            parsed = json.loads(output.stdout)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        valid = output.returncode == 0 and isinstance(parsed, dict)
        docs = git(root, env, "diff", "--unified=0", "HEAD", "--", "docs/cli.rst")
        checks = {
            "appearsInGlobalHelp": help_text.returncode == 0 and bool(re.search(r"(?m)^\s+config(?:\s|$)", help_text.stdout)),
            "printsJSONObject": valid,
            "masksAll16SyntheticKeys": valid and all(parsed.get(k) == "***" and value not in output.stdout for k, value in values.items()),
            "preservesOrdinaryTypesAndValues": valid and all(type(parsed.get(k)) is type(v) and parsed[k] == v for k, v in VISIBLE.items()),
            "includesFlaskDefaults": valid and "PERMANENT_SESSION_LIFETIME" in parsed,
            "documentedAlongsideBuiltins": bool(re.search(r"^\+(?!\+).*\bconfig\b", docs, re.I | re.M)),
            "addedTestsExecuted": bool(new_tests and additional_tests and additional_tests.returncode == 0 and re.search(r"\b[1-9]\d* passed\b", additional_tests.stdout)),
            "existingTestNodesRetained": bool(before) and before <= after,
            "flaskCliTestsPass": cli_tests.returncode == 0,
            "fullFlaskSuitePasses": all_tests.returncode == 0,
        }
        summary = lambda result: next((line.strip() for line in reversed(result.stdout.splitlines()) if re.search(r"\b(?:passed|failed|error|skipped)\b", line)), "")[-220:]
        report = {"flaskCommit": FLASK_COMMIT, "python": sys.version.split()[0],
                  "proposedFiles": sorted(proposals), "addedTests": new_tests,
                  "sensitiveKeysChecked": len(values), "cliTests": summary(cli_tests),
                  "fullTests": summary(all_tests), "checks": checks, "passed": all(checks.values())}
        (evidence / "candidate-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
