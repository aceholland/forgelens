import { createServer, request as httpRequest } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const host = '127.0.0.1';
const route = '/v1/chat/completions';
const maxBytes = 2 * 1024 * 1024;
const draftInstruction = 'Draft the requested changes using the retrieved files in the separate user-role context.';

function prepareBody(bytes) {
  const body = JSON.parse(bytes.toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected object');
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const isDraft = messages.some(({role, content}) => ['system','developer'].includes(role) &&
    (typeof content === 'string' ? content.includes(draftInstruction) :
      Array.isArray(content) && content.some(part => part?.type === 'text' && part.text?.includes(draftInstruction))));
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const proposals = tools.filter(tool => tool?.type === 'function' && tool.function?.name === 'propose_changes');
  // TrueForge may serialize its default, unspecified tool preference as "auto".
  if (!isDraft || (Object.hasOwn(body, 'tool_choice') && body.tool_choice !== 'auto') || proposals.length !== 1 ||
      !messages.some(m => m.role === 'user') || messages.some(m => !['system','developer','user'].includes(m.role)) ||
      tools.some(t => t?.type !== 'function' || !['propose_changes','get_current_datetime'].includes(t.function?.name))) {
    return { bytes, forced: false };
  }
  // llama.cpp b12613 supports string choices. One untouched function schema names the required tool.
  return { bytes: Buffer.from(JSON.stringify({...body, tools:proposals, tool_choice:'required'})), forced:true };
}

function reject(response, status, message) {
  response.writeHead(status, {'content-type':'application/json', connection:'close'});
  response.end(JSON.stringify({error:{message}}));
}

export function startAdapter(port, upstreamPort, onRequest) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(upstreamPort) ||
      upstreamPort < 1 || upstreamPort > 65535 || port === upstreamPort) throw new Error('Use two distinct local ports.');
  let sequence = 0;
  return createServer(async (req, res) => {
    if (req.headers.origin || req.headers.host !== host + ':' + req.socket.localPort) return reject(res,403,'Loopback clients only.');
    if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end('ready');
    const models = req.method === 'GET' && req.url === '/v1/models';
    if (!models && (req.url !== route || req.method !== 'POST')) return reject(res,404,'Unknown route.');
    let bytes;
    if (!models) {
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return reject(res,415,'JSON required.');
      if (Number(req.headers['content-length']) > maxBytes) return reject(res,413,'Request too large.');
      const parts = [];
      let size = 0;
      try {
        for await (const part of req.iterator({destroyOnReturn:false})) {
          size += part.length;
          if (size > maxBytes) { req.resume(); return reject(res,413,'Request too large.'); }
          parts.push(part);
        }
        const prepared = prepareBody(Buffer.concat(parts, size));
        bytes = prepared.bytes;
        onRequest?.({event:'llama_adapter_request', request:++sequence, forcedProposalToolChoice:prepared.forced});
      } catch {
        if (!res.destroyed) reject(res,400,'Invalid JSON request.');
        return;
      }
    }
    if (res.destroyed) return;
    const upstream = httpRequest({hostname:host, port:upstreamPort, path:models?'/v1/models':route,
      method:models?'GET':'POST', headers:bytes?{'content-type':'application/json','content-length':bytes.length}:{}});
    res.once('close', () => { if (!res.writableFinished) upstream.destroy(); });
    upstream.once('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy(); else reject(res,502,'Local model server unavailable.');
    });
    upstream.once('response', reply => {
      const headers = {};
      for (const key of ['content-type','content-length','content-encoding','cache-control','retry-after']) {
        if (reply.headers[key] !== undefined) headers[key] = reply.headers[key];
      }
      res.writeHead(reply.statusCode, headers);
      res.flushHeaders();
      pipeline(reply, res).catch(() => { upstream.destroy(); res.destroy(); });
    });
    upstream.end(bytes);
  }).listen(port, host);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAdapter(Number(process.argv[2] ?? 18932), Number(process.argv[3] ?? 18931),
    record => console.log(JSON.stringify(record)));
}
