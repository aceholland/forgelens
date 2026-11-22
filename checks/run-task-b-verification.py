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
    nodes = {line.strip() for line in result.stdout.splitlines() if line.startswith("tests/") and "::" in line}
    return nodes, result.returncode == 0


def pytest_summary(result):
    for line in reversed(result.stdout.splitlines()):
        if re.search(r"\b(?:passed|failed|error|skipped)\b", line):
            return line.strip()[-220:]
    return ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flask", type=Path, help="Local clone containing the official commit")
    parser.add_argument("evidence", type=Path, help="Directory containing the harness proposals.json")
    parser.add_argument("--patch", type=Path, help="Grade a retained Git patch instead of proposals.json")
    args = parser.parse_args()
    source = args.flask.resolve()
    evidence = args.evidence.resolve()
    if evidence.is_relative_to(source):
        parser.error("Choose an evidence directory outside the target Flask checkout")
    evidence.mkdir(parents=True, exist_ok=True)
    env = {name: value for name, value in os.environ.items() if name.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL"
    }}
    env.update(PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_NOSYSTEM="1",
               GIT_CONFIG_GLOBAL=os.devnull, PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")
    with tempfile.TemporaryDirectory(prefix="forgelens-grade-") as tmp:
        scratch = Path(tmp)
        root = scratch / "flask"
        git(scratch, env, "clone", "--local", "--no-hardlinks", "--no-checkout", str(source), str(root))
        git(root, env, "checkout", "--detach", FLASK_COMMIT)
        if git(root, env, "rev-parse", "HEAD").strip() != FLASK_COMMIT:
            raise ValueError("Unexpected upstream commit")
        env["PYTHONPATH"] = os.pathsep.join([str(root / "src"), str(scratch)])
        before, upstream_collected = test_nodes(root, env)
        if not upstream_collected:
            raise RuntimeError("pytest could not collect the untouched upstream tests")
        if args.patch:
            git(root, env, "apply", "--index", str(args.patch.resolve()))
            changed = git(root, env, "diff", "--cached", "--name-only", "-z", "HEAD").strip("\0").split("\0")
            proposals = {}
            for name in changed:
                file = root / name
                if not file.is_file() or file.is_symlink() or not file.resolve().is_relative_to(root):
                    raise ValueError("The patch must change ordinary files within the checkout")
                proposals[name] = file.read_bytes().decode("utf8")
        else:
            proposals = json.loads((evidence / "proposals.json").read_text(encoding="utf8"))
        if not isinstance(proposals, dict) or not 1 <= len(proposals) <= 50:
            raise ValueError("Expected a bounded set of proposed files")
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
            # Flask's repository retains LF. Treat a Windows checkout's CRLF as the same text.
            target.write_bytes(contents.replace("\r\n", "\n").encode("utf8"))
        git(root, env, "add", "--intent-to-add", "--", *proposals)
        patch = git(root, env, "diff", "--binary", "--no-ext-diff", "HEAD")
        (evidence / "candidate.patch").write_bytes(patch.encode("utf8"))
        after, candidate_collected = test_nodes(root, env)
        new_tests = sorted(after - before)
        all_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], root, env)
        cli_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_cli.py"], root, env)
        additional_tests = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "--", *new_tests], root, env) if new_tests else None
        control = None
        if new_tests:
            # Check that at least one added test actually detects the missing feature.
            baseline = scratch / "baseline"
            git(scratch, env, "clone", "--local", "--no-hardlinks", "--no-checkout", str(source), str(baseline))
            git(baseline, env, "checkout", "--detach", FLASK_COMMIT)
            for name in proposals:
                if name.startswith("tests/"):
                    file = baseline / name
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.write_bytes((root / name).read_bytes())
            control_env = {**env, "PYTHONPATH": os.pathsep.join([str(baseline / "src"), str(scratch)])}
            control = run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider",
                           "--", *new_tests], baseline, control_env)
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
            "addedTestsFailAgainstUnchangedFlask": bool(control and control.returncode == 1 and re.search(r"\b[1-9]\d* failed\b", control.stdout)),
            "existingTestNodesRetained": bool(before) and before <= after,
            "candidateTestCollectionSucceeds": candidate_collected,
            "flaskCliTestsPass": cli_tests.returncode == 0,
            "fullFlaskSuitePasses": all_tests.returncode == 0,
        }
        report = {"flaskCommit": FLASK_COMMIT, "python": sys.version.split()[0],
                  "upstreamTestsCollected": len(before), "candidateTestsCollected": len(after),
                  "proposedFiles": sorted(proposals), "addedTests": new_tests,
                  "sensitiveKeysChecked": len(values), "cliTests": pytest_summary(cli_tests),
                  "cliExitCode": cli_tests.returncode, "fullTests": pytest_summary(all_tests),
                  "fullExitCode": all_tests.returncode, "checks": checks, "passed": all(checks.values())}
        (evidence / "candidate-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        print(json.dumps(report, indent=2))
        return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
