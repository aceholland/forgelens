#!/usr/bin/env bash
# Run on a fresh standard Linux CI host. All model inference stays on that host.
set -euo pipefail
scratch="${RUNNER_TEMP:?This check needs a disposable CI runner}/task-b"
export EVIDENCE_DIR="$RUNNER_TEMP/task-b-evidence"
export FLASK_ROOT="$scratch/flask"
export FORGELENS_PYTHON="$(command -v python)"
mkdir -p "$scratch/llama" "$EVIDENCE_DIR"
model="${SOLVER_MODEL:-gpt-oss-20b}"
model_flags=()
export FORGELENS_DRAFT_FROM_CONTEXT=false
case "$model" in
  gpt-oss-20b)
    model_sha=27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901
    model_url=https://huggingface.co/ggml-org/gpt-oss-20b-GGUF/resolve/41e8a94d15d62070b36cf4553a0250717ecf46b8/gpt-oss-20b-MXFP4.gguf
    context=24576
    model_flags=(--reasoning-effort low --reasoning-budget 256)
    export FORGELENS_DRAFT_FROM_CONTEXT=true
    ;;
  qwen3-coder-30b-a3b)
    model_sha=d6b85d2b6633c55be3751848acc74fab40d28d93b27dabacd96ceabe10962057
    model_url=https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/b17cb02dd882d5b6ab62fc777ad2995f19668350/Qwen3-Coder-30B-A3B-Instruct-UD-IQ3_XXS.gguf
    context=16384
    model_flags=(--flash-attn on --cache-type-k q8_0 --cache-type-v q8_0)
    ;;
  *) echo "Unsupported diagnostic model"; exit 2 ;;
esac
llama_sha=1a1af0cb6dc2af9779e10085266de44084288d58a2917e14b64400c436fb124a
llama_url=https://github.com/ggml-org/llama.cpp/releases/download/b12613/llama-b12613-bin-ubuntu-x64.tar.gz
flags_json="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${model_flags[@]}")"
printf '{"forgeLens":"%s","flask":"22d924701a6ae2e4cd01e9a15bbaf3946094af65","trueForge":"0.185.1","model":"%s","modelSha256":"%s","contextLength":%d,"maxOutputTokens":4096,"modelFlags":%s,"draftFromContext":%s,"modelCallLimitSeconds":1800,"taskLimitSeconds":4800,"llamaCpp":"b12613","userRequests":1,"operatorAnswers":0,"diagnosticApproval":"stage bounded proposals and test disposable overlays"}\n' \
  "$(git rev-parse HEAD)" "$model" "$model_sha" "$context" "$flags_json" "$FORGELENS_DRAFT_FROM_CONTEXT" > "$EVIDENCE_DIR/run.json"
git clone --depth 1 --branch 3.1.3 https://github.com/pallets/flask.git "$FLASK_ROOT"
test "$(git -C "$FLASK_ROOT" rev-parse HEAD)" = 22d924701a6ae2e4cd01e9a15bbaf3946094af65
# The upstream lockfile versions for Python 3.12 keep this a Flask 3.1.3 check.
python -m pip install --disable-pip-version-check -e "$FLASK_ROOT" pytest==9.0.2 \
  asgiref==3.11.0 greenlet==3.3.1 python-dotenv==1.2.1 werkzeug==3.1.5 click==8.3.1 \
  blinker==1.9.0 itsdangerous==2.2.0 jinja2==3.1.6 markupsafe==3.0.3
npm install --prefix "$scratch/trueforge" --no-audit --no-fund @truefoundry/trueforge@0.185.1
curl --fail --location --retry 3 --silent --show-error "$llama_url" -o "$scratch/llama.tar.gz"
echo "$llama_sha  $scratch/llama.tar.gz" | sha256sum --check --status
tar -xzf "$scratch/llama.tar.gz" -C "$scratch/llama"
curl --fail --location --retry 3 --silent --show-error "$model_url" -o "$scratch/solver.gguf"
echo "$model_sha  $scratch/solver.gguf" | sha256sum --check --status
server="$(find "$scratch/llama" -type f -name llama-server -print -quit)"
test -x "$server"
export LD_LIBRARY_PATH="$(dirname "$server")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$server" -m "$scratch/solver.gguf" --alias "$model" --host 127.0.0.1 --port 18931 \
  --ctx-size "$context" "${model_flags[@]}" --parallel 1 --threads 4 --threads-batch 4 --n-gpu-layers 0 --jinja >"$scratch/llama.log" 2>&1 &
llama_pid=$!
trueforge_pid=''
trap 'kill "$llama_pid" 2>/dev/null || true; if [[ -n "$trueforge_pid" ]]; then kill "$trueforge_pid" 2>/dev/null || true; fi' EXIT
export STANDALONE=true HOST=127.0.0.1 SQLITE_PATH="$scratch/trueforge.sqlite"
export NETWORK_POLICY_ENABLED=true OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
export MODEL_HTTP_MAX_RETRIES=0 MODEL_HTTP_HEADERS_TIMEOUT_MS=1800000 MODEL_HTTP_BODY_TIMEOUT_MS=1800000
export MCP_REQUEST_TIMEOUT_MS=240000
node "$scratch/trueforge/node_modules/@truefoundry/trueforge/dist/cli.js" --port 18930 >"$scratch/trueforge.log" 2>&1 &
trueforge_pid=$!
wait_for_service() {
  local url="$1" pid="$2"
  for (( i = 0; i < 150; i++ )); do
    if ! kill -0 "$pid" 2>/dev/null; then echo "Service exited before becoming ready at $url"; return 1; fi
    if curl -fsS --max-time 2 "$url" -o /dev/null 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "Service did not become ready at $url"; return 1
}
wait_for_service http://127.0.0.1:18931/health "$llama_pid"
wait_for_service http://127.0.0.1:18930/api/v1/models "$trueforge_pid"
export TRUEFORGE_URL=http://127.0.0.1:18930 TRUEFORGE_MODEL="ci-local/$model"
provider="$(node -e 'const [model,context]=process.argv.slice(1);console.log(JSON.stringify({manifest:{type:"custom",name:"ci-local",base_url:"http://127.0.0.1:18931/v1",auth:{api_key:"local-placeholder"},models:[{name:model,model_id:model,properties:{context_length:Number(context),max_output_tokens:4096}}]}}))' "$model" "$context")"
curl --fail --silent --show-error -o /dev/null -H 'Content-Type: application/json' \
  -d "$provider" \
  "$TRUEFORGE_URL/api/v1/settings/model-providers"
export CONTEXT_BUDGET=14000 FORGELENS_COMPACT_REQUESTS=true FORGELENS_VALIDATE_STAGED=true DYNAMIC_SUB_AGENTS=false
export FORGELENS_TEST_FIXTURE_PINS="$PWD/docs/evidence/task-b-flash-lite/public-fixture-pins.json"
export RUN_TIMEOUT_MS=4800000 MODEL_CALL_TIMEOUT_MS=1800000 STREAM_IDLE_TIMEOUT_MS=1800000
model_status=0
node --import tsx test-local-b.ts || model_status=$?
if [[ "$model_status" != 0 && -f "$EVIDENCE_DIR/result.json" ]]; then
  node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.env.EVIDENCE_DIR;
const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'));
const events = JSON.parse(await readFile(join(dir, 'events.json'), 'utf8'));
const turn = events.find(event => event.type === 'turn.created')?.turnId;
if (turn && result.sessionId) {
  const url = new URL('/api/v1/sessions/' + encodeURIComponent(result.sessionId) + '/turns/' + encodeURIComponent(turn), process.env.TRUEFORGE_URL);
  const response = await fetch(url);
  if (response.ok) {
    const message = (await response.json()).data?.state?.message ?? '';
    const families = [
      ['context_limit', /context.{0,40}(?:size|length|exceed|limit)|too many tokens|prompt is too long/i],
      ['iteration_limit', /iteration.{0,40}(?:limit|exceed)|maximum.{0,40}iterations/i],
      ['model_server_unavailable', /connection refused|ECONNRESET|ECONNREFUSED|fetch failed/i],
      ['upstream_timeout', /timeout|timed out/i],
      ['tool_schema', /tool.{0,40}(?:schema|invalid)|invalid.{0,40}tool/i],
    ];
    const failure = {category: families.find(([, pattern]) => pattern.test(message))?.[0] ?? 'other',
      httpStatus: Number(message.match(/(?:HTTP|failed \()\s*([45]\d\d)/i)?.[1]) || null};
    console.log('Free local model diagnostic', failure);
    await writeFile(join(dir,'run.json'), JSON.stringify({...JSON.parse(await readFile(join(dir,'run.json'),'utf8')), failure},null,2));
  }
}
NODE
fi
test -f "$EVIDENCE_DIR/proposals.json"
python checks/run-task-b-verification.py "$FLASK_ROOT" "$EVIDENCE_DIR"
test "$model_status" -eq 0
