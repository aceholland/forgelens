import {Agent,fetch as undiciFetch} from 'undici';

/** Per-client transport: never changes the process-wide dispatcher or TLS policy. */
export function createForgeTransport(idleTimeoutMs = 900000) {
 if(!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<=0)throw new Error('Stream inactivity timeout must be positive.');
 let agent:Agent|undefined;
 const fetch:typeof globalThis.fetch=(input,init)=>{
  agent??=new Agent({headersTimeout:idleTimeoutMs,bodyTimeout:idleTimeoutMs});
  return undiciFetch(input as Parameters<typeof undiciFetch>[0],{...init,dispatcher:agent} as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<typeof globalThis.fetch>;
 };
 return {fetch,close:async()=>{const current=agent;agent=undefined;await current?.destroy();}};
}
