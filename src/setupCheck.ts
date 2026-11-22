import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { TrueForge } from '@truefoundry/trueforge-sdk';

export interface SetupRow { name: string; ok: boolean; detail: string }
export interface SetupInput { editor: string; trusted: boolean; localFolder: boolean; baseUrl: string; model: string }

export function meetsVersion(value: string, major: number, minor: number) {
  const version = /^v?(\d+)\.(\d+)(?:\.|$)/.exec(value.trim());
  return !!version && (+version[1] > major || (+version[1] === major && +version[2] >= minor));
}

export function localSetupUrl(address: string) {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) throw Error('Use a local HTTP address such as http://127.0.0.1:8790.');
  return url.href.replace(/\/$/, '');
}

function setupClient(url: string) {
  return new TrueForge({baseUrl:localSetupUrl(url),maxRetries:0,
    fetch:(input,init)=>fetch(input,{...init,redirect:'error'})});
}

async function nodeVersion() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  return (await promisify(execFile)('node', ['--version'], {cwd:path.dirname(process.execPath),env,windowsHide:true,timeout:4000,maxBuffer:4096})).stdout.trim();
}

async function catalog(url: string) {
  const result = await setupClient(url).models.list({timeoutInSeconds:4,maxRetries:0});
  return result.data.map(model=>model.name);
}

export async function inspectSetup(input: SetupInput, getNode = nodeVersion, getModels = catalog): Promise<SetupRow[]> {
  const rows: SetupRow[] = [
    {name:'Desktop VS Code',ok:meetsVersion(input.editor,1,95),detail:`${input.editor} (requires 1.95 or newer)`},
    {name:'Workspace',ok:input.localFolder && input.trusted,detail:!input.localFolder?'Open a local folder in desktop VS Code.':input.trusted?'Trusted local folder':'Review Workspace Trust for this folder.'}
  ];
  if (!input.localFolder || !input.trusted) return rows;
  const version = await getNode().catch(()=>'');
  rows.push({name:'Node.js on PATH',ok:meetsVersion(version,22,14),detail:meetsVersion(version,22,14)?version:`Install Node.js 22.14 or newer for local TrueForge. Detected ${version || 'no Node executable'}.`});
  let url: string;
  try { url=localSetupUrl(input.baseUrl); }
  catch { rows.push({name:'TrueForge',ok:false,detail:'Set ForgeLens: Base Url to a local HTTP or HTTPS endpoint.'});return rows; }
  let names: string[];
  try { names=await getModels(url); }
  catch { rows.push({name:'TrueForge',ok:false,detail:`Could not read the catalog at ${url}. Start TrueForge and check its address.`});return rows; }
  rows.push({name:'TrueForge',ok:true,detail:`Catalog reached at ${url}`});
  const found=names.includes(input.model);
  rows.push({name:'Model',ok:found,detail:found?`${input.model} is registered. Choose Test model to verify inference.`:
    input.model?'That model ID is absent from the catalog. Copy its exact ID into ForgeLens: Model.':'Set ForgeLens: Model to a model ID from the TrueForge catalog.'});
  return rows;
}

/** Explicit connectivity test. The session has no workspace context or editor tools. */
export async function testSetupModel(url: string, model: string, signal: AbortSignal) {
  const client=setupClient(url);
  const {data}=await client.sessions.create({agent:{spec:{model:{name:model},instructions:'Reply briefly to the connectivity check.',mcpServers:[],config:{iterationLimit:1,sandbox:{enabled:false},webSearch:{enabled:false},memory:{enabled:false}}}}},{abortSignal:signal});
  let done=false;
  try {
    const stream=await client.sessions.createTurnStream(data.id,{input:[{type:'user.message',content:'Reply with READY.'}]},{abortSignal:signal});
    let sawText=false;
    for await(const event of stream) {
      if (event.type==='model.message' || event.type==='model.message.delta') {
        const content=event.content;
        if(typeof content==='string'?content.trim():Array.isArray(content) && content.some(part=>part.type==='text' && part.text.trim())) sawText=true;
      }
      if(event.type==='turn.done') { done=true; if(event.state.status==='done' && sawText)return; throw Error('The model did not return a completed text response. Inspect its provider in TrueForge.'); }
    }
    throw Error('The model session ended before a completed response.');
  } finally {
    if(!done) await client.sessions.cancel(data.id,{}, {timeoutInSeconds:3,maxRetries:0}).catch(()=>{});
  }
}
