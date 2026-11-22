import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const target = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const host = '127.0.0.1';
const maxBody = 2 * 1024 * 1024;
const pacingMs = 32_000;
export const defaultModel = 'DeepSeek-V4.1-Flash-1017';

function errorResponse(response, status, message) {
  if (!response.destroyed && !response.headersSent) {
    response.writeHead(status, {'content-type':'application/json'});
    response.end(JSON.stringify({error:{message}}));
  }
}

function retryTime(value) {
  if (!value) return 61_000;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value)*1000 : Date.parse(value)-Date.now();
  return Number.isFinite(ms) ? Math.max(1000,ms+500) : 61_000;
}

// Only public project data should be sent to an external anonymous provider.
// The local auth token never appears in any upstream header or message.
export function anonymousProvider({localToken, model=defaultModel, forward=fetch, wait=sleep, interval=pacingMs, observe, checkPublicInput}={}) {
  if (typeof localToken !== 'string' || localToken.length < 24) throw Error('Set a local access token of at least 24 characters.');
  const auth = Buffer.from('Bearer '+localToken);
  let nextStart = 0;
  async function reserve(signal) {
    const now=Date.now(), start=Math.max(now,nextStart);
    nextStart=start+interval;
    if (start>now) await wait(start-now,undefined,{signal});
    signal.throwIfAborted();
  }
  return createServer(async (req,res) => {
    const incoming=Buffer.from(req.headers.authorization || '');
    if (req.headers.origin || req.headers.host !== host+':'+req.socket.localPort ||
        incoming.length!==auth.length || !timingSafeEqual(incoming,auth)) return errorResponse(res,403,'Local provider access denied.');
    if (req.method==='GET' && req.url==='/v1/models') {
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({object:'list',data:[{id:model,object:'model'}]}));
      return;
    }
    if (req.url!=='/v1/chat/completions' || req.method!=='POST') return errorResponse(res,404,'Unknown route.');
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json') return errorResponse(res,415,'JSON required.');
    const controller=new AbortController();
    res.on('close',()=>{if (!res.writableFinished) controller.abort();});
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8*60_000)]);
    try {
      let bytes=0; const parts=[];
      for await (const part of req) {
        bytes+=part.length;
        if (bytes<=maxBody) parts.push(part);
      }
      if (bytes>maxBody) return errorResponse(res,413,'Request too large.');
      const buffer=Buffer.concat(parts,bytes);
      let body;
      try { body=JSON.parse(buffer.toString('utf8')); } catch { return errorResponse(res,400,'Invalid JSON.'); }
      if (body?.model!==model || !Array.isArray(body.messages)) return errorResponse(res,400,'Unexpected model or messages.');
      if (checkPublicInput && !checkPublicInput(body)) return errorResponse(res,403,'Local information in proposed outbound request.');
      for (let attempt=0; ; attempt++) {
        if(nextStart-Date.now()>120_000) {
          res.setHeader('retry-after',String(Math.ceil((nextStart-Date.now())/1000)));
          return errorResponse(res,429,'Anonymous model quota will become available later.');
        }
        await reserve(signal);
        const reply=await forward(target,{method:'POST',headers:{'content-type':'application/json'},body:buffer,signal,redirect:'error'});
        observe?.({time:new Date().toISOString(),status:reply.status,attempt:attempt+1});
        if (reply.status===429) {
          const waitMs=retryTime(reply.headers.get('retry-after'));
          nextStart=Math.max(nextStart,Date.now()+waitMs);
          if (attempt<2 && waitMs<=120_000) {
            await reply.body?.cancel();
            continue;
          }
        }
        const headers={'content-type':reply.headers.get('content-type') || 'application/json'};
        if (reply.headers.has('retry-after')) headers['retry-after']=reply.headers.get('retry-after');
        res.writeHead(reply.status,headers);res.flushHeaders();
        if (reply.body) await pipeline(Readable.fromWeb(reply.body),res,{signal});
        else res.end();
        break;
      }
    } catch {
      if (res.headersSent) res.destroy();
      else errorResponse(res,502,'The anonymous model request could not finish.');
    }
  });
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const port=Number(process.argv[2] || 18940), model=process.argv[3] || defaultModel;
  const token=randomBytes(32).toString('hex');
  const server=anonymousProvider({localToken:token,model});
  server.listen(port,host,()=>console.log('TrueForge provider URL: http://'+host+':'+server.address().port+'/v1\nModel: '+model+'\nLocal access token: '+token));
}
