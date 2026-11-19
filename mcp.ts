// mcp.ts — the Model Context Protocol endpoint: streamable HTTP JSON-RPC at
// /mcp, speaking both eras the clients negotiate — the modern
// `server/discover` revision (2026-07-28) and the legacy initialize
// handshake — with six tools that act on the same store as REST and GraphQL.

import { Forge, VIEWER } from './store.ts';
import { createPullIn, issueJson, mergePullIn, pullJson, repoJson } from './rest.ts';
import { json, type HttpRequest, type HttpResponse } from './web.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: false, required };
}

const STRING = { type: 'string' } as const;

/** The tool list, built once: two tools/list answers must be byte-identical. */
export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: objectSchema(
      { name: STRING, description: STRING, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, title: STRING, body: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'number' }, merge_method: STRING },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

interface RpcError {
  code: number;
  message: string;
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argStr(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: RpcError } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = (tool.inputSchema.required as string[] | undefined) ?? [];
  for (const field of required) {
    const value = args[field];
    if (value === undefined || value === null || value === '') {
      return { rpcError: { code: -32602, message: `Missing required argument: ${field}` } };
    }
  }

  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name');
      const existing = forge.repo(VIEWER.login, repoName);
      if (existing !== null) return toolFailure(`Repository ${VIEWER.login}/${repoName} already exists`);
      const repo = forge.createRepo(
        VIEWER.login,
        repoName,
        argStr(args, 'description'),
        typeof args.private === 'boolean' ? args.private : false,
      );
      if (repo === null) return toolFailure(`Repository ${VIEWER.login}/${repoName} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = forge.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolFailure(`Repository ${argStr(args, 'owner')}/${argStr(args, 'repo')} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = forge.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolFailure('Repository not found');
      const labels = Array.isArray(args.labels) ? args.labels.map((entry) => String(entry)) : [];
      for (const label of labels) if (!repo.labels.has(label)) return toolFailure(`Label "${label}" does not exist`);
      const issue = repo.createIssue(argStr(args, 'title'), argStr(args, 'body'), labels);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = forge.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolFailure('Repository not found');
      const state = argStr(args, 'state');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = forge.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolFailure('Repository not found');
      const created = createPullIn(repo, {
        title: argStr(args, 'title'),
        body: argStr(args, 'body'),
        head: argStr(args, 'head'),
        base: argStr(args, 'base'),
      });
      if ('error' in created) return toolFailure(created.error);
      return toolResult(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = forge.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === null) return toolFailure('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure(`Pull request #${String(args.pull_number)} not found`);
      const merged = mergePullIn(repo, pull);
      if ('error' in merged) return toolFailure(merged.error);
      return toolResult({ ...pullJson(repo, pull), sha: merged.sha });
    }
    default:
      return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function rpcResult(id: unknown, result: unknown): HttpResponse {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): HttpResponse {
  return json(status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle one JSON-RPC request object; null when it is a notification (answered 202 upstream). */
function handleRpc(forge: Forge, message: Record<string, unknown>): HttpResponse | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': SUPPORTED_REVISIONS[0],
        },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: JSON.parse(TOOLS_JSON) as unknown });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, name, args);
      if ('rpcError' in outcome) return rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
      return rpcResult(id, outcome);
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, req: HttpRequest): HttpResponse | null {
  if (req.path !== '/mcp') return null;
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream and no session to end; answer plainly.
    return { status: req.method === 'DELETE' ? 200 : 405, contentType: 'application/json; charset=utf-8', body: '' };
  }
  if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }

  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const response = handleRpc(forge, entry as Record<string, unknown>);
      if (response !== null) responses.push(JSON.parse(response.body as string) as unknown);
    }
    return json(200, responses);
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  const message = parsed as Record<string, unknown>;
  if (message.id === undefined && typeof message.method === 'string') {
    // A notification: accepted, no body owed.
    handleRpc(forge, message);
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }
  const response = handleRpc(forge, message);
  if (response === null) return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  return response;
}
