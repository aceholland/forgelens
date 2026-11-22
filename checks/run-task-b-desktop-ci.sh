#!/usr/bin/env bash
# The parent runner owns the pinned model, authenticated editor bridge and local TrueForge process.
set -euo pipefail
scratch="$1"
evidence="$2"
desktop_dir="$evidence/desktop"
harness="$scratch/editor-harness"
vsix="$scratch/forgelens.vsix"
command -v xvfb-run >/dev/null
if ! command -v ffmpeg >/dev/null; then
  python -m pip install --disable-pip-version-check --no-cache-dir imageio-ffmpeg==0.6.0
fi
npm install --prefix "$harness" --ignore-scripts --no-audit --no-fund @vscode/test-electron@3.1.0 playwright-core@1.58.2
npm run package -- --out "$vsix"
# Pin the editor SDK version as well as the tested VS Code release.
node - "$harness" "$scratch" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const [harness,scratch]=process.argv.slice(2);
const {downloadAndUnzipVSCode,resolveCliPathFromVSCodeExecutablePath}=require(path.join(harness,'node_modules/@vscode/test-electron'));
(async()=>{
 const editor=await downloadAndUnzipVSCode({version:'1.101.0',cachePath:path.join(scratch,'vscode')});
 const cli=resolveCliPathFromVSCodeExecutablePath(editor);
 const playwright=require.resolve('playwright-core',{paths:[harness]});
 for(const [name,file] of Object.entries({editor,cli,playwright})) fs.writeFileSync(path.join(scratch,name+'-path'),file);
})().catch(e=>{console.error(e.message);process.exitCode=1;});
NODE
export FORGELENS_EDITOR_EXECUTABLE FORGELENS_EDITOR_CLI PLAYWRIGHT_CORE
FORGELENS_EDITOR_EXECUTABLE="$(cat "$scratch/editor-path")"
FORGELENS_EDITOR_CLI="$(cat "$scratch/cli-path")"
PLAYWRIGHT_CORE="$(cat "$scratch/playwright-path")"
export FORGELENS_EDITOR_MODE=draft FORGELENS_EDITOR_MINUTES=80
status=0
xvfb-run -a -s '-screen 0 1440x1000x24' node checks/task-b-desktop-launch.cjs "$desktop_dir" "$vsix" || status=$?
# Keep genuine failed takes and artefacts. The two independent checks also gate success.
session="$(node -e 'try {const r=require(process.argv[1]); if (/^[a-zA-Z0-9_-]{10,80}$/.test(r.sessionId||""))process.stdout.write(r.sessionId)} catch {}' "$desktop_dir/result.json")"
if [[ -n "$session" ]]; then
  python checks/task-b-session-replay.py "$desktop_dir" "$scratch/trueforge.sqlite" "$session" "$evidence/native-replay.json" || status=1
else
  echo 'No native session receipt from the editor.'
  status=1
fi
python checks/task-b-desktop-receipt.py "$scratch" "$evidence" || status=1
exit "$status"
