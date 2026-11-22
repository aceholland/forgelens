/** Local-only first-draft compatibility bridge between TrueForge and llama.cpp.
 * It wraps JSON text generated under the advertised MCP schema as tool-call arguments.
 * All model input messages are passed through unchanged. No source, edit or task-specific examples live here.
 */
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [port, modelPort] = process.argv.slice(2).map(Number);
if (![port, modelPort].every(n => Number.isInteger(n) && n > 1023 && n < 65536) || port === modelPort) {
  throw Error('Provide a local listening port and a different local llama.cpp server port.');
}
const base='http://127.0.0.1:'+modelPort;
const marker='Draft the requested changes using the retrieved files in the separate user-role context.';
const bytesLimit=2*1024*1024;
const hash=s=>createHash('sha256').update(s).digest('hex');

const server=createServer(async (req,res)=>{
  const reject=(status,text)=>{if(res.headersSent){res.destroy();return;} res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify({error:{message:text}}));};
  if(req.headers.origin || req.headers.host!=='127.0.0.1:'+port) return reject(403,'Loopback service only');
  if(req.method==='GET'&&req.url==='/health') return res.writeHead(200).end('ready');
  const modelList=req.method==='GET'&&req.url==='/v1/models';
  if(!modelList && (req.method!=='POST'||req.url!=='/v1/chat/completions'))return reject(404,'Unknown route');
  const control=new AbortController();
  res.once('close',()=>{if(!res.writableFinished)control.abort();});
  try {
    let bytes, proposal, input;
    if(!modelList) {
      const pieces=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size<=bytesLimit)pieces.push(chunk);}
      if(size>bytesLimit)return reject(413,'Oversized request');
      bytes=Buffer.concat(pieces,size);input=JSON.parse(bytes.toString('utf8'));
      const messages=input.messages||[], tools=input.tools||[];
      const firstDraft=messages.some(m=>['system','developer'].includes(m.role)&&
        (typeof m.content==='string' ? m.content.includes(marker) : Array.isArray(m.content) && m.content.some(p=>p.type==='text'&&p.text?.includes(marker)))) &&
        messages.some(m=>m.role==='user') && messages.every(m=>['system','developer','user'].includes(m.role)) &&
        (input.tool_choice===undefined||input.tool_choice==='auto') &&
        tools.every(t=>t.type==='function'&&['propose_changes','get_current_datetime'].includes(t.function.name)) &&
        input.stream===true && input.response_format===undefined;
      proposal=firstDraft && tools.find(t=>t.function.name==='propose_changes')?.function;
      if(proposal) {
        const modelBody={...input,response_format:{type:'json_schema',json_schema:{
          name:proposal.name,strict:true,schema:proposal.parameters}}};
        delete modelBody.tools;delete modelBody.tool_choice;delete modelBody.parallel_tool_calls;
        bytes=Buffer.from(JSON.stringify(modelBody));
      }
    }
    // Large CPU prompts may take several minutes before producing the first byte.
    // Use the same bounded inactivity limit as the installed TrueForge model provider.
    const upstream=await new Promise((resolve,reject)=>{
      const hop=httpRequest(base+req.url,{method:req.method,signal:control.signal,
        headers:bytes?{'content-type':'application/json','content-length':bytes.length}:{}},incoming=>{
        resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:incoming.headers}));
      });
      hop.setTimeout(30*60*1000,()=>hop.destroy(new Error('Local model timed out')));
      hop.once('error',reject);hop.end(bytes);
    });
    if(!upstream.ok || !proposal){
      const headers={};for(const k of ['content-type','retry-after','cache-control'])if(upstream.headers.has(k))headers[k]=upstream.headers.get(k);
      res.writeHead(upstream.status,headers);res.flushHeaders();
      if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.flushHeaders();
    const id='chatcmpl-'+randomUUID(),toolId='call_'+randomUUID().replaceAll('-','');
    const created=Math.floor(Date.now()/1000);
    async function chunk(delta,finish=null,usage) {
      const body={id,object:'chat.completion.chunk',created,model:input.model,choices:[{index:0,delta,finish_reason:finish}]};
      if(usage)body.usage=usage;
      if(!res.write('data: '+JSON.stringify(body)+'\n\n'))await once(res,'drain',{signal:control.signal});
    }
    let content='',reachedEnd=false,finish,usage,started=false;
    const lines=createInterface({input:Readable.fromWeb(upstream.body),crlfDelay:Infinity});
    for await(const line of lines){
      if(!line.startsWith('data:'))continue;
      const payload=line.slice(5).trimStart();if(payload==='[DONE]'){reachedEnd=true;break;}
      if(!payload)continue;const packet=JSON.parse(payload);
      usage=packet.usage||usage;
      const choice=packet.choices?.[0];if(!choice)continue;
      const fragment=choice.delta?.content;
      if(typeof fragment==='string'&&fragment.length){
        if(!started){await chunk({role:'assistant',tool_calls:[{index:0,id:toolId,type:'function',function:{name:proposal.name,arguments:''}}]});started=true;}
        content+=fragment;
        if(content.length>500000)throw Error('Oversized model arguments');
        await chunk({tool_calls:[{index:0,function:{arguments:fragment}}]});
      }
      if(choice.finish_reason)finish=choice.finish_reason;
    }
    const args=JSON.parse(content);
    if(!reachedEnd || finish!=='stop' || !args || !Array.isArray(args.files) || !args.files.length)throw Error('Incomplete model proposal');
    await chunk({},'tool_calls',usage);
    res.end('data: [DONE]\n\n');
    console.log(JSON.stringify({mode:'first-native-draft-via-json-schema',argumentsSha256:hash(content),characters:content.length,
      completionTokens:usage?.completion_tokens,promptTokens:usage?.prompt_tokens}));
  } catch { if(!res.destroyed)reject(502,'Local model did not return a complete response'); }
});
server.listen(port,'127.0.0.1');
