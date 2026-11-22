import { randomBytes } from 'node:crypto';
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { countsTool, startReviewCountsBridge, type ReviewInput } from './codeModeBridge';
import { assertLocalNativeSandbox } from './nativeSandbox';
import { createReviewSkillReadTracker, nativeSandboxOutput, prepareReviewSkill, reviewSkillInstructions } from './nativeSkill';
import { localSetupUrl } from './setupCheck';

export function codeModeCommand(connector: string) {
  if (!/^forgelens-review-[0-9a-f]{16}$/.test(connector)) throw Error('Invalid review connector name.');
  return 'python3 skills/forgelens-review-checklist/review_counts.py ' + connector;
}

type ReviewBridge = Awaited<ReturnType<typeof startReviewCountsBridge>>;
export function matchesReviewReceipt(content: string, bridge: Pick<ReviewBridge, 'totals'|'receipt'|'reads'>) {
  if (!bridge.reads) return false;
  try {
    const report = JSON.parse(nativeSandboxOutput(content) ?? '');
    return report?.receipt === bridge.receipt &&
      Object.entries(bridge.totals).every(([key, value]) => report[key] === value);
  } catch { return false; }
}

/** Run an independent, local TrueForge session with one metadata-only editor connector. */
export async function runCodeModeReview(baseUrl: string, model: string, input: ReviewInput, signal: AbortSignal) {
  const client = new TrueForge({baseUrl: localSetupUrl(baseUrl), maxRetries: 0,
    fetch: (request, init) => fetch(request, {...init, redirect: 'error'})});
  if (!model.trim()) throw Error('Set ForgeLens: Model to a registered TrueForge model first.');
  await assertLocalNativeSandbox(client, signal);
  const skill = await prepareReviewSkill(client, signal);
  const bridge = await startReviewCountsBridge(input, signal);
  const connector = 'forgelens-review-' + randomBytes(8).toString('hex');
  const command = codeModeCommand(connector);
  const options = {abortSignal: signal};
  let sessionId: string | undefined;
  let terminal = false;
  try {
    await client.settings.mcpServers.create({manifest: {name: connector, type: 'remote', url: bridge.url,
      description: 'Anonymous review counts from this ForgeLens snapshot.',
      auth: {type: 'header', headers: {Authorization: 'Bearer ' + bridge.token}}}}, options);
    const session = await client.sessions.create({agent: {spec: {
      model: {name: model}, skills: [skill], instructions: reviewSkillInstructions +
        '\nUse the pinned review helper in the native sandbox. After reading the skill, inspect the output schema for ' +
        countsTool + ' and run the exact Python command in the request. Keep per-file rows in the sandbox.',
      mcpServers: [{name: connector, preload: true, enableTools: [countsTool], requireApprovalForTools: []}],
      config: {iterationLimit: 8, sandbox: {enabled: true, fileDownloads: false}, webSearch: {enabled: false},
        dynamicSubAgents: {enabled: false}, memory: {enabled: false}, askUserQuestions: {enabled: false}, generativeUi: {enabled: false}},
    }}}, options);
    sessionId = session.data.id;
    const stream = await client.sessions.createTurnStream(sessionId, {input: [{type: 'user.message',
      content: 'Analyze this ForgeLens review using the review checklist. Run this exact sandbox command after reading the skill:\n' + command}]}, options);
    const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
    const calls = new Set<string>();
    const tracker = createReviewSkillReadTracker();
    let sandboxCreated = false;
    let receiptVerified = false;
    for await (const event of stream) {
      signal.throwIfAborted();
      if (event.type === 'sandbox.created') sandboxCreated = true;
      if (event.type === 'model.message') messages.set(event.id, event);
      if (isEventDelta(event)) {
        const base = messages.get(event.id);
        if (base) mergeEventDelta(base, event);
      }
      const message = messages.get(event.id);
      if (message) {
        tracker.observe(message);
        for (const call of message.toolCalls ?? []) {
          if (call.toolInfo.type !== 'truefoundry-system' || call.toolInfo.name !== 'exec') continue;
          try {
            const args = JSON.parse(call.function.arguments);
            if (args.command === command && typeof args.intent === 'string' &&
                args.cwd === undefined && args.env === undefined && tracker.verified()) calls.add(call.id);
          } catch { /* Tool arguments may still be streaming. */ }
        }
      } else {
        tracker.observe(event);
      }
      if (event.type === 'tool.response' && calls.has(event.toolCallId)) {
        receiptVerified ||= matchesReviewReceipt(event.content, bridge);
      }
      if (event.type === 'turn.update' && event.state.status === 'paused') throw Error('TrueForge paused this read-only analysis.');
      if (event.type === 'turn.done') {
        terminal = true;
        if (event.state.status !== 'done') throw Error('TrueForge ended the review analysis with status ' + event.state.status + '.');
        const missing = !sandboxCreated ? 'sandbox creation' : !tracker.verified() ? 'the pinned checklist read'
          : !receiptVerified ? 'the Python helper’s review receipt' : undefined;
        if (missing) throw Error('TrueForge finished before ForgeLens could verify ' + missing + '. See session ' + sessionId + '.');
        return {sessionId, ...bridge.totals};
      }
    }
    throw Error('The TrueForge stream ended before confirming the review analysis.');
  } finally {
    await bridge.close();
    if (sessionId && !terminal) await client.sessions.cancel(sessionId, {}, {timeoutInSeconds: 3}).catch(() => {});
    await client.settings.mcpServers.delete(connector, {timeoutInSeconds: 4}).catch(() => {});
  }
}
