// app.ts — one HTTP server for the whole forge: the health probe, git smart
// HTTP, REST v3, GraphQL and MCP, all reading and writing one store.
//
// Cross-cutting rules live here so the surfaces cannot drift apart: every
// surface but /healthz requires the bearer token (absent = 401), every REST
// reply is JSON carrying an X-GitHub-Request-Id, and no handler may throw
// its way out of a request — a malformed body is an answer, not a crash.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertiseV0,
  advertiseV2,
  fetchRequestFromArgs,
  fetchV0,
  fetchV2,
  lsRefs,
  parsePushBody,
  parseV0Fetch,
  parseV2Request,
  receivePack,
} from './gitproto.ts';
import { JSON_TYPE, json, jsonError, type HttpRequest, type HttpResponse } from './web.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  const suffix = requestCounter.toString(16).padStart(12, '0').slice(-12);
  return `4D2A-0000-4000-8000-${suffix}`;
}

const EMPTY_BODY: Buffer = Buffer.alloc(0);

function readBody(req: IncomingMessage): Promise<Buffer> {
  // A request that declares no body has nothing to collect: answering from
  // the headers alone skips the stream plumbing the sequential REST
  // workloads would otherwise pay on every one of thousands of GETs.
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
    const length = req.headers['content-length'];
    const hasBody = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
    if (!hasBody) return Promise.resolve(EMPTY_BODY);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Shared by every query-less request; handlers only ever read it. */
const EMPTY_QUERY: URLSearchParams = new URLSearchParams();

function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const body = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : response.body;
  const headers: Record<string, string | number> = {
    'content-type': response.contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  };
  if (response.headers) {
    for (const [name, value] of Object.entries(response.headers)) headers[name] = value;
  }
  res.writeHead(response.status, headers);
  res.end(body);
}

function hasToken(req: HttpRequest): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

// ---------------------------------------------------------------------------
// git smart HTTP

function gitResponse(contentType: string, body: Buffer): HttpResponse {
  return { status: 200, contentType, body };
}

function handleGit(forge: Forge, req: HttpRequest): HttpResponse | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(req.path);
  if (match === null) return null;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const service = match[3] as string;
  const repo = forge.repo(owner, name);
  if (repo === null) return jsonError(404, 'Not Found');

  if (service === 'info/refs' && req.method === 'GET') {
    const wanted = req.query.get('service');
    if (wanted === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'];
      const v2 = typeof protocol === 'string' && protocol.includes('version=2');
      return gitResponse('application/x-git-upload-pack-advertisement', v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'));
    }
    if (wanted === 'git-receive-pack') {
      return gitResponse('application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
    }
    return jsonError(400, 'Unknown service');
  }

  if (service === 'git-upload-pack' && req.method === 'POST') {
    const protocol = req.headers['git-protocol'];
    const v2 = typeof protocol === 'string' && protocol.includes('version=2');
    try {
      if (v2) {
        const request = parseV2Request(req.body);
        if (request.command === 'ls-refs') return gitResponse('application/x-git-upload-pack-result', lsRefs(repo, request.args));
        return gitResponse('application/x-git-upload-pack-result', fetchV2(repo, fetchRequestFromArgs(request.args)));
      }
      const { request, capabilities } = parseV0Fetch(req.body);
      return gitResponse('application/x-git-upload-pack-result', fetchV0(repo, request, capabilities));
    } catch {
      return jsonError(400, 'Malformed upload-pack request');
    }
  }

  if (service === 'git-receive-pack' && req.method === 'POST') {
    try {
      const { commands, pack } = parsePushBody(req.body);
      const outcome = receivePack(repo, commands, pack);
      return gitResponse('application/x-git-receive-pack-result', outcome.report);
    } catch {
      return jsonError(400, 'Malformed receive-pack request');
    }
  }

  return jsonError(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL

function handleGraphQL(forge: Forge, req: HttpRequest): HttpResponse | null {
  if (req.path !== '/api/graphql') return null;
  if (req.method !== 'POST') return json(405, { errors: [{ message: 'GraphQL only accepts POST' }] });
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return json(400, { errors: [{ message: 'The request body is not valid JSON' }] });
  }
  const runOne = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object') return { errors: [{ message: 'Invalid operation' }] };
    const operation = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof operation.query !== 'string') return { errors: [{ message: 'No query document' }] };
    const variables =
      operation.variables !== null && typeof operation.variables === 'object'
        ? (operation.variables as Record<string, unknown>)
        : {};
    return executeGraphQL(forge, operation.query, variables, typeof operation.operationName === 'string' ? operation.operationName : undefined);
  };
  if (Array.isArray(parsed)) return json(200, parsed.map(runOne));
  return json(200, runOne(parsed));
}

// ---------------------------------------------------------------------------
// the server

export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      let response: HttpResponse;
      try {
        // Origin-form URLs only: split path and query by hand instead of
        // paying the WHATWG parser on every request. The pathname keeps
        // its percent-encoding, exactly as URL.pathname presented it, and
        // the surfaces decode the segments they care about.
        const rawUrl = req.url ?? '/';
        const qmark = rawUrl.indexOf('?');
        const body = await readBody(req);
        const request: HttpRequest = {
          method: req.method ?? 'GET',
          path: qmark === -1 ? rawUrl : rawUrl.slice(0, qmark),
          query: qmark === -1 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qmark + 1)),
          headers: req.headers,
          body,
          host: typeof req.headers.host === 'string' ? req.headers.host : 'localhost',
        };

        if (request.method === 'GET' && request.path === '/healthz') {
          response = json(200, { ok: true });
        } else if (
          request.path.startsWith('/api/') ||
          request.path === '/mcp' ||
          request.path.includes('.git/')
        ) {
          if (!hasToken(request)) {
            response = jsonError(401, 'Requires authentication');
          } else if (request.path.includes('.git/')) {
            // Real git paths are the only ones the git handler answers;
            // anything else carrying ".git/" (a contents path, say) falls
            // through to the API surfaces exactly as before.
            response =
              handleGit(forge, request) ??
              handleRest(forge, request) ??
              handleGraphQL(forge, request) ??
              handleMcp(forge, request) ??
              jsonError(404, 'Not Found');
          } else if (request.path === '/mcp') {
            response = handleMcp(forge, request) ?? jsonError(404, 'Not Found');
          } else if (request.path === '/api/graphql') {
            response = handleGraphQL(forge, request) ?? jsonError(404, 'Not Found');
          } else {
            response = handleRest(forge, request) ?? jsonError(404, 'Not Found');
          }
        } else {
          response = jsonError(404, 'Not Found');
        }
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        response = jsonError(500, 'Internal Server Error');
      }
      writeResponse(res, response);
    })();
  });
}

export { JSON_TYPE };
