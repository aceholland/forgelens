"""Show actual Task B checks in the integrated terminal and retain their outputs."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    output = Path(os.environ["FORGELENS_RUN_EVIDENCE"])
    setup = json.loads((output / "setup.json").read_text(encoding="utf-8"))
    repo = Path(setup["workspace"])
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(repo / "src"), str(output)]),
               PYTHONDONTWRITEBYTECODE="1", PYTHONIOENCODING="utf-8", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1")

    def command(args, timeout=240):
        print("\n$", subprocess.list2cmdline(args), flush=True)
        result = subprocess.run(args, cwd=repo, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", timeout=timeout)
        print(result.stdout, flush=True)
        return result

    def git(*args):
        return subprocess.check_output(["git", "-c", "core.autocrlf=false", *args], cwd=repo)

    untracked = git("ls-files", "--others", "--exclude-standard", "-z").decode().strip("\0")
    if untracked:
        git("add", "--intent-to-add", "--", *untracked.split("\0"))
    patch = git("diff", "--no-ext-diff", "--binary", "--full-index", "HEAD")
    assert patch
    patch_file = output / "candidate.patch"
    patch_file.write_bytes(patch)
    command(["git", "diff", "--stat", "HEAD"])
    pytest = command([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests/test_cli.py"])
    (output / "cli.txt").write_text(pytest.stdout, encoding="utf-8")
    (output / "cli-checked.json").write_text(json.dumps({"exit":pytest.returncode}), encoding="utf-8")
    # Coordinate the camera independently of the test outcomes.
    import time
    def wait_for_camera(name):
        until = time.monotonic() + 12
        while not (output / name).is_file() and time.monotonic() < until:
            time.sleep(.1)
    wait_for_camera("camera-cli")
    help_output = command([sys.executable, "-m", "flask", "--help"])
    app = output / "demo_config_fixture.py"
    app.write_text("from flask import Flask\napp=Flask(__name__)\n"
                   "app.config.update(SECRET_KEY='secret-fixture', ApiToken='token-fixture',"
                   "DatabasePassword='password-fixture', BENIGN_TEXT='visible')\n", encoding="utf-8")
    config = command([sys.executable, "-m", "flask", "--app", "demo_config_fixture:app", "config"])
    try:
        data = json.loads(config.stdout)
    except ValueError:
        data = {}
    preview = {key:data.get(key) for key in ("SECRET_KEY", "ApiToken", "DatabasePassword", "BENIGN_TEXT")}
    print("Selected keys from the command output\n"+json.dumps(preview, indent=2), flush=True)
    (output / "json-checked.json").write_text(json.dumps(preview),encoding="utf-8")
    wait_for_camera("camera-json")
    # A separate clone and a baseline negative-control test are handled by the frozen grader.
    grader_path = Path(setup["root"]) / "checks/run-task-b-verification.py"
    grade = command([sys.executable,str(grader_path),str(repo),str(output / "independent"),"--patch",str(patch_file)], timeout=640)
    readback = json.loads((output / "independent/candidate-verification.json").read_text(encoding="utf-8"))
    files = git("diff", "--name-only", "-z", "HEAD").decode().strip("\0").split("\0")
    checks = {"cli":pytest.returncode == 0, "help":bool(help_output.returncode == 0 and re.search(r"(?m)^\s+config\s",help_output.stdout)),
              "json":config.returncode == 0 and preview == {"SECRET_KEY":"***", "ApiToken":"***","DatabasePassword":"***","BENIGN_TEXT":"visible"},
              "threeFiles":len(files) >= 3, "independent":grade.returncode == 0 and readback["passed"]}
    receipt = {"checks":checks,"files":files,"patchSha256":hashlib.sha256(patch).hexdigest(),
               "cli":readback["cliTests"],"full":readback["fullTests"],"sensitiveKeys":readback["sensitiveKeysChecked"],
               "passed":all(checks.values())}
    print("\n"+readback["cliTests"]+" | "+readback["fullTests"],flush=True)
    print("Masked key cases:",readback["sensitiveKeysChecked"],"| Independent grader:",grade.returncode,flush=True)
    (output / "terminal-result.json").write_text(json.dumps(receipt,indent=2),encoding="utf-8")
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
