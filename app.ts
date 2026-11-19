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

function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeResponse(res: ServerResponse, response: HttpResponse): void {
  const body = typeof response.body === 'string' ? Buffer.from(response.body, 'utf8') : response.body;
  res.writeHead(response.status, {
    'content-type': response.contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...(response.headers ?? {}),
  });
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
        const url = new URL(req.url ?? '/', 'http://entry');
        const body = await readBody(req);
        const request: HttpRequest = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          host: typeof req.headers.host === 'string' ? req.headers.host : 'localhost',
        };

        if (request.method === 'GET' && request.path === '/healthz') {
          response = json(200, { ok: true });
        } else if (
          request.path.startsWith('/api/') ||
          request.path === '/mcp' ||
          /\.git\//.test(request.path)
        ) {
          if (!hasToken(request)) {
            response = jsonError(401, 'Requires authentication');
          } else {
            response =
              handleGit(forge, request) ??
              handleRest(forge, request) ??
              handleGraphQL(forge, request) ??
              handleMcp(forge, request) ??
              jsonError(404, 'Not Found');
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
