/** Metadata only: never persist source, arguments, provider errors or model prose. */
export const TASK_B_PROMPT = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;
export function loopbackUrl(value:string):string {
 const u=new URL(value);
 if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash)throw new Error('Use a credential-free loopback TrueForge URL.');
 return u.href.replace(/\/$/,'');
}
export function safeRelativePath(value:unknown):value is string {
 return typeof value==='string'&&/^[A-Za-z0-9_. /-]{1,240}$/.test(value)&&!value.startsWith('/')&&!value.split('/').some(p=>p==='..'||p==='.'||p===''||p.startsWith('.env'));
}
function statusCategory(message:unknown):string|undefined {
 if(typeof message!=='string')return undefined;
 if(message.startsWith('Run time limit reached.'))return 'run_timeout';
 if(message.startsWith('Model call time limit reached.'))return 'model_timeout';
 if(message.startsWith('Model call timed out. No fallback:'))return 'fallback_blocked';
 if(message.startsWith('The configured model failed. Trying'))return 'fallback_started';
 if(message.startsWith('Agent proposed no edits'))return 'no_proposals';
 if(message.startsWith('Local work stopped. Could not confirm'))return 'cancellation_unconfirmed';
 return 'status_update';
}
const allowedTools=new Set(['find_relevant_files','select_context','read_file','search_workspace','report_plan','propose_write','propose_edit','propose_changes','create_file','validate_candidate','run_command']);
export const toolName=(name:string)=>allowedTools.has(name)?name:'[unknown tool]';
const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(v)?v:undefined;
export const modelId=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_./:-]{1,160}$/.test(v)&&!/(?:sk-|ghp_|github_pat_|AIza)/.test(v)?v:undefined;
export class Metadata {
 readonly events:Record<string,unknown>[]=[];
 readonly calls:string[]=[];
 readonly models=new Set<string>();
 readonly discoveredPaths=new Set<string>();
 readonly plannedPaths=new Set<string>();
 readonly statuses:string[]=[];
 paths(kind:'discovery'|'plan',values:unknown[]){const paths=[...new Set(values.filter(safeRelativePath))];for(const p of paths)(kind==='discovery'?this.discoveredPaths:this.plannedPaths).add(p);return paths;}
 readonly usage=new Map<string,{inputTokens:number;outputTokens:number}>();
 readonly streamDeltas={total:0,text:0,reasoning:0,toolCalls:0};
 initialized=0; fallbackTransitions=0; modelTimeouts=0; sessionId:string|undefined;
 private attempt=0;
 add(event:Record<string,any>) {
  const type=typeof event.type==='string'&&/^[a-z_.]{1,80}$/.test(event.type)?event.type:'unknown';
  const safe:Record<string,unknown>={type};
  if(type==='client.status'){safe.category=statusCategory(event.message);this.statuses.push(String(safe.category));}
  for(const key of ['id','threadId','turnId']){const value=id(event[key]);if(value)safe[key]=value;}
  if(event.state&&['running','paused','done','cancelled','error'].includes(event.state.status)){safe.status=event.state.status;if(event.state.status==='error'){safe.category=typeof event.state.message==='string'&&/time[ -]?out|timed out/i.test(event.state.message)?'server_timeout':'server_error';this.statuses.push(String(safe.category));}}
  if(type==='model.message'||type==='model.message.delta') {
   if(type==='model.message.delta'){
    this.streamDeltas.total++;
    const content=event.content;
    const hasText=typeof content==='string' ? content.length>0 :
      Array.isArray(content) && content.some(part=>part?.type==='text'&&typeof part.text==='string'&&part.text.length>0);
    if(hasText)this.streamDeltas.text++;
    if(typeof event.reasoningContent==='string'&&event.reasoningContent.length>0)this.streamDeltas.reasoning++;
    if(Array.isArray(event.toolCalls)&&event.toolCalls.length)this.streamDeltas.toolCalls++;
   }
   const name=modelId(event.model?.name);if(name){this.models.add(name);safe.model=name;}
   const u=event.usage;
   if(id(event.id)&&u&&Number.isSafeInteger(u.inputTokens)&&u.inputTokens>=0&&Number.isSafeInteger(u.outputTokens)&&u.outputTokens>=0){
    // Usage is a per-message snapshot, not an additive stream delta.
    const usage={inputTokens:u.inputTokens,outputTokens:u.outputTokens};this.usage.set(`${this.attempt}:${event.threadId}:${event.id}`,usage);safe.usage=usage;
   }
  }
  this.events.push(safe);return safe;
 }
 fallback(){this.attempt++;this.fallbackTransitions++;}
 summary(){return {discoveredPaths:[...this.discoveredPaths],plannedPaths:[...this.plannedPaths],statusCategories:this.statuses,mcpInitialized:this.initialized>0,mcpInitializationCount:this.initialized,toolCalls:this.calls.length,lastToolCalls:this.calls.slice(-8),observedModels:[...this.models],fallbackTransitions:this.fallbackTransitions,modelTimeouts:this.modelTimeouts,streamDeltas:{...this.streamDeltas},tokenUsage:this.usage.size?{inputTokens:[...this.usage.values()].reduce((s,u)=>s+u.inputTokens,0),outputTokens:[...this.usage.values()].reduce((s,u)=>s+u.outputTokens,0),reportedModelMessages:this.usage.size}:null};}
}
export function failureMetadata(error:unknown){
 const e=error as {statusCode?:unknown;cause?:{code?:unknown};code?:unknown};
 const code=e?.code??e?.cause?.code;
 return {category:'harness_failure',...(typeof e?.statusCode==='number'?{httpStatus:e.statusCode}:{}),...(['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EACCES','EADDRNOTAVAIL'].includes(String(code))?{code}:{}),detail:'Inspect TrueForge locally; raw error text deliberately omitted.'};
}
