"""Summarize a ForgeLens review snapshot using TrueForge's sandbox MCP client."""

import asyncio
import json
import sys

from mcp_client import call_tool


async def main(connector):
    snapshot = await call_tool(connector, "get_review_counts", {})
    rows = snapshot["files"]
    report = {
        "receipt": snapshot["receipt"],
        "files": len(rows),
        "tests": snapshot["tests"],
        **{key: sum(row[key] for row in rows) for key in ("pending", "accepted", "rejected")},
    }
    print(json.dumps(report))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
