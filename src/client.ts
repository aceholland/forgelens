import { createForgeTransport } from './transport';
import { TrueForge, TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

export interface ApprovalDetails {
  sessionId: string; threadId: string; toolCallId: string;
  name: string; serverName?: string; arguments: Record<string, unknown>;
}
export interface QuestionDetails { sessionId: string; threadId: string; toolCallId: string; question: string; options: string[]; }
export type ApprovalDecision = boolean | { allowed: boolean; reason: string };
export type ForgeEvent = TrueForgeApi.TurnStreamingEvent | { type: 'client.status'; message: string };
export interface ForgeOptions {
  baseUrl: string; model: string; fallbackModel?: string; preloadTools?: boolean; reasoningEffort?: string; dynamicSubAgents?: boolean; mcpName: string; instructions: string;
  onEvent(event: ForgeEvent): void;
  onApproval(details: ApprovalDetails): Promise<ApprovalDecision>;
  onQuestion?(details: QuestionDetails): Promise<string | undefined>;
  runTimeoutMs?: number; streamIdleTimeoutMs?: number;
  /** Wall-clock budget per model.message lifecycle (not per SSE delta). */
  modelCallTimeoutMs?: number;
  onModelCallTimeout?(): void;
  onFallback?(): void;
  /** Opt in for editing tasks; omit for read-only checks. */
  getStagedProposalCount?(): number;
  getRecentToolCalls?(): string[];
  sdk?: Pick<TrueForge, 'sessions' | 'settings'>;
}
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120000;
class ModelCallTimeout extends Error {}
export interface RunResult { sessionId: string; status: 'done' | 'cancelled' | 'error' }

/** Reasoning/usage/lifecycle events alone are not usable model output. */
function hasModelOutput(message: TrueForgeApi.ModelMessageEvent | TrueForgeApi.ModelMessageDeltaEvent): boolean {
  const content = message.content;
  const hasContent = typeof content === 'string' ? !!content.trim() :
    Array.isArray(content) && content.some(part =>
      part.type === 'text' ? !!part.text.trim() : !!part.refusal.trim());
  return hasContent || !!message.refusal?.trim() || !!message.toolCalls?.length;
}

export async function registerMcp(baseUrl: string, name: string, url: string, token: string): Promise<void> {
  const host = new URL(baseUrl).hostname;
  // Use the same per-client transport as turns for literal loopback addresses.
  // Never route a redirected request or alter proxy behavior for remote hosts.
  const transport = host === '[::1]' || host === '127.0.0.1' ? createForgeTransport(15000) : undefined;
  const fetch: typeof globalThis.fetch | undefined = transport
    ? (input, init) => transport.fetch(input, { ...init, redirect: 'error' })
    : undefined;
  try {
    const client = new TrueForge({ baseUrl, maxRetries: 0, timeoutInSeconds: 15, fetch });
    await client.settings.mcpServers.create({ manifest: {
      name, description: 'Read and search a VS Code workspace, propose reviewable edits, run approved commands.',
      type: 'remote', url, auth: { type: 'header', headers: { Authorization: `Bearer ${token}` } },
    } });
  } finally {
    await transport?.close();
  }
}

/** A transport for the TrueForge agent loop, never a model-provider client. */
export class ForgeRunner {
  private readonly sdk: Pick<TrueForge, 'sessions' | 'settings'>;
  private controller = new AbortController();
  private sessionId = '';
  private turnId = '';
  private terminalModelTimeout=false;
  private cancelled = false;
  private cancellationRequest?: Promise<void>;
  private running = false;
  private transport: ReturnType<typeof createForgeTransport>;
  constructor(private readonly options: ForgeOptions) {
    this.transport = createForgeTransport(options.streamIdleTimeoutMs ?? 900000);
    this.sdk = options.sdk ?? new TrueForge({ baseUrl: options.baseUrl, timeoutInSeconds: 900, maxRetries: 0, fetch: this.transport.fetch });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    // Abort locally immediately; server cancellation is separate and bounded.
    this.controller.abort();
    if (this.sessionId) {
      this.cancellationRequest ??= (async () => {
        try { await this.sdk.sessions.cancel(this.sessionId, {}, { timeoutInSeconds: 5, maxRetries: 0 }); }
        catch { this.options.onEvent({ type: 'client.status', message: 'Local work stopped. Could not confirm server cancellation; check the TrueForge session.' }); }
      })();
      await this.cancellationRequest;
    }
  }

  async run(prompt: string): Promise<RunResult> {
    if (this.running) throw new Error('A TrueForge task is already running. Cancel or wait before starting another.');
    this.running = true; this.cancelled = false; this.cancellationRequest = undefined; this.sessionId = ''; this.controller = new AbortController();
    let timedOut = false;
    const runTimeoutMs = this.options.runTimeoutMs ?? 300000;
    const modelTimeout=this.options.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS;
    if (!Number.isSafeInteger(modelTimeout) || modelTimeout<=0) {this.running=false;throw new Error('Model call timeout must be positive.');}
    if (!Number.isSafeInteger(runTimeoutMs) || runTimeoutMs <= 0) { this.running = false; throw new Error('Run timeout must be positive.'); }
    const deadline = setTimeout(() => {
      timedOut = true;
      this.options.onEvent({type:'client.status',message:'Run time limit reached. Local tools stopped; no automatic replay. Check the TrueForge session before retrying.'});
      void this.cancel();
    },runTimeoutMs);
    try {
      const result = await this.runModels(prompt);
      return timedOut || (result.status==='done' && this.options.getStagedProposalCount?.()===0) ? {sessionId:this.sessionId,status:'error'} : result;
    } catch(error) {
      if(timedOut)return {sessionId:this.sessionId,status:'error'};
      throw error;
    } finally {
      clearTimeout(deadline);
      if ((!this.cancelled || timedOut) && this.options.getStagedProposalCount?.()===0) {
        // Names only: never echo source, tool arguments, secrets or provider payloads.
        const recent=(this.options.getRecentToolCalls?.()??[]).slice(-8).map(summary=>summary.match(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}(?=[\s(:]|$)/)?.[0]??'[tool]');
        this.options.onEvent({type:'client.status',message:`Agent proposed no edits${timedOut?' before the run time limit':''}. No unreviewed edits were applied. Recent tool calls: ${recent.length?recent.join(' → '):'(none)'}.`});
      }
      try { await this.cancellationRequest; await this.transport.close(); }
      finally { this.running = false; }
    }
  }

  private async runModels(prompt:string):Promise<RunResult> {
      const models = [this.options.model, this.options.fallbackModel].filter((m, i, a): m is string => !!m && a.indexOf(m) === i);
      for (let index = 0; index < models.length; index++) {
        try {
          const result = await this.runModelWithDeadline(prompt, models[index]);
          if (result.status !== 'error' || index === models.length - 1 || this.cancelled || (this.options.getStagedProposalCount?.()??0)>0 || (this.terminalModelTimeout&&this.options.getStagedProposalCount?.()!==0)) return result;
        } catch (error) {
          if (this.cancelled) return { sessionId: this.sessionId, status: 'cancelled' };
          // Do not replay ambiguous interrupted turns: they might still be running remotely.
          if (error instanceof ModelCallTimeout) {
            const stopped=await this.confirmTimeoutCancellation();
            if(this.cancelled)return {sessionId:this.sessionId,status:'cancelled'};
            if (!stopped || this.options.getStagedProposalCount?.()!==0 || index===models.length-1) {
              this.options.onEvent({type:'client.status',message:'Model call timed out. No fallback: cancellation is unconfirmed, staged-edit state is unsafe/unknown, or no second model is configured. Check the TrueForge session.'});
              return {sessionId:this.sessionId,status:'error'};
            }
          } else if (this.sessionId || index === models.length - 1) throw error;
        }
        this.controller=new AbortController();this.cancellationRequest=undefined;this.options.onFallback?.();
        this.options.onEvent({ type: 'client.status', message: 'The configured model failed. Trying the configured fallback through TrueForge; edits still require review.' });
      }
      return { sessionId: this.sessionId, status: 'error' };
  }

  /** Cancellation acceptance is not completion: verify the exact timed-out turn. */
  private async confirmTimeoutCancellation():Promise<boolean> {
    if(!this.sessionId||!this.turnId)return false;
    try {
      await this.bounded(this.sdk.sessions.cancel(this.sessionId,{}, {timeoutInSeconds:2,maxRetries:0}),2200);
      for(let attempt=0;attempt<3&&!this.cancelled;attempt++) {
        const result=await this.bounded(this.sdk.sessions.getTurn(this.sessionId,this.turnId,{timeoutInSeconds:2,maxRetries:0}),2200);
        if(['cancelled','done','error'].includes(result.data.state.status))return true;
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch {/* No confirmed terminal state: never replay. */}
    return false;
  }
  private async bounded<T>(promise:PromiseLike<T>,ms:number):Promise<T> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Confirmation timeout')),ms);})]);}
    finally{clearTimeout(timer);}
  }
  private async runModelWithDeadline(prompt:string,model:string):Promise<RunResult> {
    const timers=new Map<string,{threadId:string;timer:ReturnType<typeof setTimeout>}>();
    const signal=this.controller.signal;
    let rejectTimeout!:(error:Error)=>void;
    const timeout=new Promise<never>((_,reject)=>{rejectTimeout=reject;});
    const stop=(id:string)=>{const value=timers.get(id);if(value)clearTimeout(value.timer);timers.delete(id);};
    const observe=(event:TrueForgeApi.TurnStreamingEvent)=>{
      if(event.type==='model.message'||event.type==='model.message.delta') {
        // TrueForge 0.185.1 emits the initial model.message before awaiting first token.
        // Same-id deltas do not extend the budget. Final usage/finishReason closes it.
        if(event.finishReason!=null || (event.type==='model.message'&&event.usage!=null)) {stop(event.id);return;}
        if(!timers.has(event.id))timers.set(event.id,{threadId:event.threadId,timer:setTimeout(()=>{
          if(signal.aborted)return;
          this.options.onEvent({type:'client.status',message:'Model call time limit reached. Stopping the current TrueForge turn before considering fallback.'});
          this.options.onModelCallTimeout?.();
          rejectTimeout(new ModelCallTimeout('Model call time limit reached.'));this.controller.abort();
        },this.options.modelCallTimeoutMs??DEFAULT_MODEL_CALL_TIMEOUT_MS)});
      } else if(event.type==='turn.done'||(event.type==='turn.update'&&event.state.status==='paused')) {
        for(const id of timers.keys())stop(id);
      } else if(event.type==='tool.response'||event.type==='tool.approval_required'||event.type==='tool.response_required'||event.type==='thread.done') {
        for(const [id,value] of timers)if(value.threadId===event.threadId)stop(id);
      }
    };
    const abort=()=>rejectTimeout(new Error('Run cancelled'));
    signal.addEventListener('abort',abort,{once:true});
    try{return await Promise.race([this.runModel(prompt,model,observe,signal),timeout]);}
    finally{signal.removeEventListener('abort',abort);for(const id of timers.keys())stop(id);}
  }

  private async runModel(prompt: string, model: string, observe:(event:TrueForgeApi.TurnStreamingEvent)=>void, attemptSignal:AbortSignal): Promise<RunResult> {
    this.sessionId = '';this.turnId='';this.terminalModelTimeout=false;
    const create = () => this.sdk.sessions.create({ agent: { spec: {
      model: { name: model, ...(this.options.reasoningEffort ? {params:{reasoningEffort:this.options.reasoningEffort}} : {}) }, instructions: this.options.instructions,
      mcpServers: [{ name: this.options.mcpName, preload: this.options.preloadTools ?? false,
        requireApprovalForTools: ['propose_edit', 'propose_write', 'run_command'] }],
      config: { iterationLimit: 40, ...(this.options.dynamicSubAgents !== undefined ? {dynamicSubAgents:{enabled:this.options.dynamicSubAgents}} : {}) },
    } } }, { abortSignal: attemptSignal, maxRetries: 0 });
    let session: Awaited<ReturnType<typeof create>> | undefined;
    for (let attempt = 0; !session; attempt++) {
      try { session = await create(); }
      catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // Only explicit rejected requests are retryable. Never replay a turn POST.
        if (this.cancelled || attempt >= 2 || (status !== 429 && status !== 503)) throw error;
        await this.delay(200 * 2 ** attempt);
      }
    }
    const sessionId=session.data.id;
    if (this.cancelled || attemptSignal.aborted) {
      try {await this.bounded(this.sdk.sessions.cancel(sessionId,{}, {timeoutInSeconds:2,maxRetries:0}),2200);} catch {}
      return {sessionId,status:'cancelled'};
    }
    this.sessionId = sessionId;
    let stream = await this.sdk.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.message', content: prompt }],
    }, { abortSignal: attemptSignal, maxRetries: 0 });
    const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
    let turnId = ''; let lastEventId = '';
    let sawOutputOrToolActivity = false;
    const questions = new Map<string, TrueForgeApi.ToolResponseRequiredEvent>();
    const pending = new Map<string, TrueForgeApi.ToolApprovalRequiredEvent>();
    while (!this.cancelled && !attemptSignal.aborted) {
      let paused = false;
      for await (const event of stream) {
        if (this.cancelled || attemptSignal.aborted) break;
        observe(event);
        lastEventId = event.id;
        if (isEventDelta(event)) {
          const base = events.get(event.id);
          if (base) mergeEventDelta(base, event);
        } else { events.set(event.id, event); }
        if (event.type === 'model.message' || event.type === 'model.message.delta') {
          sawOutputOrToolActivity ||= hasModelOutput(event);
        } else if (event.type === 'tool.response' || event.type === 'tool.approval_required' || event.type === 'tool.response_required') {
          sawOutputOrToolActivity = true;
        }
        if (event.type === 'turn.done' && event.state.status === 'done' &&
            !sawOutputOrToolActivity && !(event.state.output && hasModelOutput(event.state.output))) {
          // Throw before publishing a misleading done event. A session already exists,
          // so runModels will not replay this through fallback automatically.
          throw new Error(`Model/provider returned no usable output (no text or tool activity). Task not completed. No automatic replay. Check TrueForge session ${sessionId} before retrying.`);
        }
        if (!(event.type==='turn.done' && event.state.status==='done' && this.options.getStagedProposalCount?.()===0)) this.options.onEvent(event);
        if (event.type === 'turn.created') {turnId = event.turnId;this.turnId=turnId;}
        if (event.type === 'tool.response_required') questions.set(event.id,event);
        if (event.type === 'tool.approval_required') pending.set(event.id, event);
        if (event.type === 'turn.done') {this.terminalModelTimeout=event.state.status==='error'&&/time[ -]?out|timed out/i.test(event.state.message);return { sessionId: sessionId, status: event.state.status };}
        if (event.type === 'turn.update' && event.state.status === 'paused') { paused = true; break; }
      }
      if (this.cancelled || attemptSignal.aborted) break;
      if (!paused) throw new Error('TrueForge stream ended without a terminal event. Check the session before retrying.');
      if (!turnId || (!pending.size && !questions.size)) throw new Error('TrueForge paused for an unsupported input. Open its session to continue.');
      const approvals: (TrueForgeApi.UserToolApprovalInputEvent | TrueForgeApi.UserToolResponseInputEvent)[] = [];
      for (const question of questions.values()) for (const ref of question.toolCalls) {
        const source=events.get(ref.sourceEventId);
        const call=source?.type==='model.message' ? source.toolCalls?.find(c=>c.id===ref.id) : undefined;
        if (!call || call.toolInfo.type!=='truefoundry-system' || call.toolInfo.name!=='ask_user_question' || !this.options.onQuestion) throw new Error('TrueForge paused for an unsupported client-side input. Open its session to continue.');
        let args: {question?:unknown;options?:unknown};
        try { args=JSON.parse(call.function.arguments); } catch { throw new Error('Malformed question arguments. No answer sent.'); }
        if (!args || typeof args.question!=='string' || !args.question.trim() || !Array.isArray(args.options) || args.options.length>5 || !args.options.every(x=>typeof x==='string')) throw new Error('Invalid question arguments. No answer sent.');
        const answer=await this.waitForQuestion({sessionId:sessionId,threadId:question.threadId,toolCallId:ref.id,question:args.question,options:args.options},attemptSignal);
        if(attemptSignal.aborted)break;
        if (answer===undefined) { await this.cancel(); break; }
        if (this.cancelled || attemptSignal.aborted) break;
        approvals.push({type:'user.tool_response',threadId:question.threadId,toolCallId:ref.id,content:answer});
      }
      if (this.cancelled || attemptSignal.aborted) break;
      for (const approval of pending.values()) for (const ref of approval.toolCalls) {
        const source = events.get(ref.sourceEventId);
        const call = source?.type === 'model.message' ? source.toolCalls?.find(c => c.id === ref.id) : undefined;
        if (!call) throw new Error('Tool approval has no matching call. No tool was approved.');
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.function.arguments); } catch { throw new Error('Malformed tool arguments. No tool was approved.'); }
        if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Invalid tool arguments.');
        const deferred = call.toolInfo.type === 'truefoundry-system' && call.toolInfo.name === 'call_tool';
        const details: ApprovalDetails = {
          sessionId: sessionId, threadId: approval.threadId, toolCallId: ref.id,
          name: deferred ? String(args.tool_name) : call.toolInfo.name,
          serverName: deferred ? String(args.mcp_server) : call.toolInfo.type === 'mcp' ? call.toolInfo.serverName : undefined,
          arguments: deferred ? ((args.input ?? args.arguments ?? {}) as Record<string, unknown>) : args,
        };
        const decision = await this.waitForApproval(details,attemptSignal);
        if(attemptSignal.aborted)break;
        const allowed = typeof decision === 'boolean' ? decision : decision.allowed;
        const reason = typeof decision === 'boolean' ? 'Rejected by the editor user.' : decision.reason;
        if (!allowed) this.options.onEvent({ type: 'client.status', message: reason });
        if (this.cancelled || attemptSignal.aborted) break;
        approvals.push({ type: 'user.tool_approval', threadId: approval.threadId, toolCallId: ref.id,
          approval: allowed ? { status: 'allow' } : { status: 'deny', reason } });
      }
      if (this.cancelled || attemptSignal.aborted) break;
      pending.clear(); questions.clear();
      stream = await this.sdk.sessions.subscribeToTurn(sessionId, turnId, { afterEventId: lastEventId },
        { abortSignal: attemptSignal, maxRetries: 0 });
      if(attemptSignal.aborted)break;
      await this.sdk.sessions.createTurnEvents(sessionId, turnId, { events: approvals },
        { abortSignal: attemptSignal, maxRetries: 0 });
    }
    return { sessionId: sessionId, status: 'cancelled' };
  }

  private waitForQuestion(details: QuestionDetails, signal:AbortSignal): Promise<string | undefined> {
    if (this.cancelled||signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve,reject)=>{
      const abort=()=>resolve(undefined);
      signal.addEventListener('abort',abort,{once:true});
      this.options.onQuestion!(details).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  private waitForApproval(details: ApprovalDetails, signal:AbortSignal): Promise<ApprovalDecision> {
    if (this.cancelled||signal.aborted) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      const abort = () => resolve(false);
      signal.addEventListener('abort', abort, { once: true });
      this.options.onApproval(details).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
