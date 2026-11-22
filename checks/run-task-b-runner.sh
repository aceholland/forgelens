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
use_adapter=false
desktop=false
max_output=4096
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
  qwen2-5-coder-7b)
    model_sha=509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c
    model_url=https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/13fb94bfda8c8cf22497dc57b78f391a9acb426a/qwen2.5-coder-7b-instruct-q4_k_m.gguf
    context=16384
    export FORGELENS_DRAFT_FROM_CONTEXT=true
    if [[ "${REQUEST_FIRST_DRAFT_TOOL:-false}" == true ]]; then use_adapter=true; fi
    ;;
  qwen3-coder-30b-a3b-desktop)
    # The model and desktop editor share a 16 GiB standard runner.
    model_sha=7055a02d4d974fd68b26b095a9c676f099507aed1171f89a47275025df3f521d
    model_url=https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/b17cb02dd882d5b6ab62fc777ad2995f19668350/Qwen3-Coder-30B-A3B-Instruct-UD-IQ2_M.gguf
    context=12288
    max_output=5200
    model_flags=(--batch-size 256 --ubatch-size 128 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --no-ui)
    desktop=true
    use_adapter=true
    export FORGELENS_DRAFT_FROM_CONTEXT=true
    ;;
  qwen2-5-coder-14b-desktop|ornith-1-5-9b-desktop)
    context=12288
    model_flags=(--batch-size 256 --ubatch-size 128 --no-ui)
    if [[ "$model" == qwen2-5-coder-14b-desktop ]]; then
      model_sha=c1e659736d89ac1065fb495330fb824d94001974a4bfa78e7270e43476a8d940
      model_url=https://huggingface.co/Qwen/Qwen2.5-Coder-14B-Instruct-GGUF/resolve/d0a692ef765eefbf2fabb130b3cb2e8917e3d225/qwen2.5-coder-14b-instruct-q4_k_m.gguf
    else
      model_sha=70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6
      model_url=https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF/resolve/abdd624b12ebf020b767fff532ff44fe552b28c3/Ornith-1.5-9B-Q4_K_M.gguf
      model_flags+=(--reasoning-budget 0 --chat-template-kwargs '{"enable_thinking":false}')
    fi
    desktop=true
    use_adapter=true
    export FORGELENS_DRAFT_FROM_CONTEXT=true
    ;;
  *) echo "Unsupported diagnostic model"; exit 2 ;;
esac
llama_sha=1a1af0cb6dc2af9779e10085266de44084288d58a2917e14b64400c436fb124a
llama_url=https://github.com/ggml-org/llama.cpp/releases/download/b12613/llama-b12613-bin-ubuntu-x64.tar.gz
flags_json="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "${model_flags[@]}")"
printf '{"forgeLens":"%s","flask":"22d924701a6ae2e4cd01e9a15bbaf3946094af65","trueForge":"0.185.1","model":"%s","modelSha256":"%s","contextLength":%d,"maxOutputTokens":%d,"modelFlags":%s,"draftFromContext":%s,"requestFirstDraftTool":%s,"modelCallLimitSeconds":1800,"taskLimitSeconds":4800,"llamaCpp":"b12613","plannedUserRequests":1,"operatorAnswersAllowed":0,"diagnosticApproval":"stage bounded proposals and test disposable overlays"}\n' \
  "$(git rev-parse HEAD)" "$model" "$model_sha" "$context" "$max_output" "$flags_json" "$FORGELENS_DRAFT_FROM_CONTEXT" "$use_adapter" > "$EVIDENCE_DIR/run.json"
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
mkdir -p "$scratch/daemon-home" "$scratch/daemon-temp"
daemon_env=(env -i "PATH=$PATH" "HOME=$scratch/daemon-home" "TMPDIR=$scratch/daemon-temp" LANG=C.UTF-8)
"${daemon_env[@]}" "LD_LIBRARY_PATH=$LD_LIBRARY_PATH" "$server" -m "$scratch/solver.gguf" --alias "$model" --host 127.0.0.1 --port 18931 \
  --ctx-size "$context" "${model_flags[@]}" --parallel 1 --threads 4 --threads-batch 4 --n-gpu-layers 0 --jinja >"$scratch/llama.log" 2>&1 &
llama_pid=$!
trueforge_pid=''
adapter_pid=''
stop_services() {
  for pid in "$llama_pid" "$trueforge_pid" "$adapter_pid"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
}
trap stop_services EXIT
export STANDALONE=true HOST=127.0.0.1 SQLITE_PATH="$scratch/trueforge.sqlite"
export NETWORK_POLICY_ENABLED=true OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'
export MODEL_HTTP_MAX_RETRIES=0 MODEL_HTTP_HEADERS_TIMEOUT_MS=1800000 MODEL_HTTP_BODY_TIMEOUT_MS=1800000
export MCP_REQUEST_TIMEOUT_MS=240000
"${daemon_env[@]}" STANDALONE=true HOST=127.0.0.1 "SQLITE_PATH=$SQLITE_PATH" NETWORK_POLICY_ENABLED=true \
  "OUTBOUND_URL_ALLOWED_HOSTS=$OUTBOUND_URL_ALLOWED_HOSTS" MODEL_HTTP_MAX_RETRIES=0 MODEL_HTTP_HEADERS_TIMEOUT_MS=1800000 \
  MODEL_HTTP_BODY_TIMEOUT_MS=1800000 MCP_REQUEST_TIMEOUT_MS=240000 SENTRY_ENABLED=false \
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
provider_url=http://127.0.0.1:18931/v1
if [[ "$use_adapter" == true ]]; then
  adapter=scripts/llama-draft-adapter.mjs
  if [[ "$desktop" == true ]]; then adapter=scripts/llama-schema-draft.mjs; fi
  "${daemon_env[@]}" node "$adapter" 18932 18931 >"$scratch/adapter.log" 2>&1 &
  adapter_pid=$!
  wait_for_service http://127.0.0.1:18932/health "$adapter_pid"
  provider_url=http://127.0.0.1:18932/v1
fi
export TRUEFORGE_URL=http://127.0.0.1:18930 TRUEFORGE_MODEL="ci-local/$model"
provider="$(node -e 'const [model,context,url,output]=process.argv.slice(1);console.log(JSON.stringify({manifest:{type:"custom",name:"ci-local",base_url:url,auth:{api_key:"local-placeholder"},models:[{name:model,model_id:model,properties:{context_length:Number(context),max_output_tokens:Number(output)}}]}}))' "$model" "$context" "$provider_url" "$max_output")"
curl --fail --silent --show-error -o /dev/null -H 'Content-Type: application/json' \
  -d "$provider" \
  "$TRUEFORGE_URL/api/v1/settings/model-providers"
if [[ "$desktop" == true ]]; then
  bash checks/run-task-b-desktop-ci.sh "$scratch" "$EVIDENCE_DIR"
  exit
fi
export CONTEXT_BUDGET=14000 FORGELENS_COMPACT_REQUESTS=true FORGELENS_VALIDATE_STAGED=true DYNAMIC_SUB_AGENTS=false
export FORGELENS_TEST_FIXTURE_PINS="$PWD/docs/evidence/task-b-flash-lite/public-fixture-pins.json"
export RUN_TIMEOUT_MS=4800000 MODEL_CALL_TIMEOUT_MS=1800000 STREAM_IDLE_TIMEOUT_MS=1800000
model_status=0
adapter_status=0
node --import tsx test-local-b.ts || model_status=$?
if [[ "$use_adapter" == true ]]; then
  node --input-type=module - "$scratch/adapter.log" "$EVIDENCE_DIR/provider-audit.json" <<'NODE' || adapter_status=$?
import {readFile,writeFile} from 'node:fs/promises';
const [source,target] = process.argv.slice(2);
const requests = [];
for (const line of (await readFile(source,'utf8')).split(/\r?\n/)) {
  let event;
  try { event=JSON.parse(line); } catch { continue; }
  if (event.event==='llama_adapter_request' && Number.isSafeInteger(event.request) &&
      typeof event.forcedProposalToolChoice==='boolean') {
    requests.push({request:event.request,forcedProposalToolChoice:event.forcedProposalToolChoice});
  }
}
const selectedRequests = requests.filter(entry=>entry.forcedProposalToolChoice).length;
await writeFile(target,JSON.stringify({requests,selectedRequests},null,2)+'\n');
console.log('Loopback tool choice audit',JSON.stringify({requests,selectedRequests}));
if(selectedRequests!==1) {
  console.error('The request audit did not confirm exactly one native draft tool selection.');
  process.exitCode=1;
}
NODE
fi
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
test "$adapter_status" -eq 0
test "$model_status" -eq 0
