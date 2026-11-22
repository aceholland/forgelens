import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export interface ReviewCounts { accepted: number; pending: number; rejected: number }
export interface ReviewInput {
  files: readonly ReviewCounts[];
  latestStagedTest?: {candidateExitCode: number; reviewChangedSinceTest: boolean};
}
const testState = z.enum(['not-run', 'stale', 'passed', 'failed']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const countsSchema = z.object({ accepted: count, pending: count, rejected: count });
export const countsTool = 'get_review_counts';

/** Copy only numeric hunk counts; callers' paths and other editor fields never enter the connector. */
export function reviewCountSnapshot({files, latestStagedTest}: ReviewInput) {
  if (!files.length) throw Error('Review a proposed edit in ForgeLens first.');
  if (files.length > 2048) throw Error('The review exceeds the 2,048-file analysis limit.');
  const tests: z.infer<typeof testState> = !latestStagedTest ? 'not-run'
    : latestStagedTest.reviewChangedSinceTest ? 'stale' : latestStagedTest.candidateExitCode === 0 ? 'passed' : 'failed';
  return {files: files.map(file => countsSchema.parse(file)), tests};
}

/** The disposable loopback connector has exactly one tool and holds no workspace handle. */
export async function startReviewCountsBridge(input: ReviewInput, signal: AbortSignal) {
  signal.throwIfAborted();
  const snapshot = reviewCountSnapshot(input);
  const totals = {files: snapshot.files.length, tests: snapshot.tests, pending: 0, accepted: 0, rejected: 0};
  for (const row of snapshot.files) {
    totals.pending += row.pending;
    totals.accepted += row.accepted;
    totals.rejected += row.rejected;
  }
  const receipt = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const credential = Buffer.from('Bearer ' + token);
  let reads = 0;
  const server = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== credential.length || !timingSafeEqual(actual, credential)) { res.writeHead(401).end(); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (signal.aborted) { res.writeHead(410).end(); return; }
    const mcp = new McpServer({name: 'forgelens-review-counts', version: '1'});
    mcp.registerTool(countsTool, {
      description: 'Read an immutable snapshot of anonymous per-file hunk counts for this review.',
      inputSchema: {}, outputSchema: {receipt: z.string(), files: z.array(countsSchema), tests: testState},
      annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    }, async () => {
      signal.throwIfAborted();
      reads++;
      const data = {receipt, ...snapshot};
      return {structuredContent: data, content: [{type: 'text', text: JSON.stringify(data)}]};
    });
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 16384});
    res.once('close', () => { void mcp.close().catch(() => {}); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Could not open review counts connector.');
  return {url: `http://127.0.0.1:${address.port}/mcp`, token, receipt, totals, get reads() {return reads;},
    async close() {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await stopped;
    }};
}
