"""Record pytest's per-test outcomes for the ForgeLens baseline comparison."""
import json
import os

outcomes = {}


def pytest_runtest_logreport(report):
    if report.failed:
        outcomes[report.nodeid] = "failed"
    elif report.when == "call" or report.skipped:
        if outcomes.get(report.nodeid) != "failed":
            outcomes[report.nodeid] = "skipped" if report.skipped else "passed"


def pytest_sessionfinish(session, exitstatus):
    with open(os.environ["FORGELENS_TEST_REPORT"], "w", encoding="utf-8") as stream:
        for test_id, state in outcomes.items():
            stream.write(json.dumps([test_id, state], ensure_ascii=True) + "\n")
        stream.write('"complete"\n')
