// rest.ts — the REST v3 surface: repositories, contents, branches, commits,
// labels, issues, comments and pull requests, shaped the way GitHub shapes
// them and judged by the same store the git protocol writes to.

import {
  Forge,
  Repo,
  VIEWER,
  diffFiles,
  identSeconds,
  isoOf,
  parseCommit,
  parseTree,
  squashMerge,
  type IssueRec,
  type PullRec,
} from './store.ts';
import { listCommits } from './gitproto.ts';
import { json, jsonError, parseJsonBody, str, optStr, bool, intParam, type HttpRequest, type HttpResponse } from './web.ts';

const NOT_FOUND = 'Not Found';

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    databaseId: repo.dbId,
    node_id: `R_${repo.dbId}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  return { name, color: repo.labels.get(name) ?? 'ededed', description: null, default: false };
}

/**
 * The serialized form of an issue, memoised on the issue record itself.
 * The key is built from every field the JSON depends on (the issue's own
 * fields, its comment count and its labels' colours), so a PATCH, a new
 * comment or a label recolour changes the key and the body is rebuilt;
 * an unchanged issue — the read workload's 2,000 GETs of one issue —
 * serves the exact bytes json() would have produced, without rebuilding
 * the object graph or re-stringifying it.
 */
const issueBodyCache = new WeakMap<IssueRec, { key: string; body: string }>();

export function issueBody(repo: Repo, issue: IssueRec): string {
  const comments = repo.comments.get(issue.number)?.length ?? 0;
  const labelPart = issue.labels.map((name) => `${name}:${repo.labels.get(name) ?? ''}`).join(',');
  const key = `${issue.title}\0${issue.body}\0${issue.state}\0${comments}\0${labelPart}`;
  const hit = issueBodyCache.get(issue);
  if (hit !== undefined && hit.key === key) return hit.body;
  const body = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issueBodyCache.set(issue, { key, body });
  return body;
}

/** An issue answer whose body is the memoised serialization above. */
function issueResponse(repo: Repo, issue: IssueRec, status = 200): HttpResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: issueBody(repo, issue) };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  // One timestamp serves both fields: they are the same instant by design.
  const stamp = isoOf(1_700_000_000 + issue.seq * 60);
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: repo.comments.get(issue.number)?.length ?? 0,
    created_at: stamp,
    updated_at: stamp,
    html_url: `/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const stamp = isoOf(1_700_000_000 + pull.seq * 60);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : null,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: stamp,
    updated_at: stamp,
    html_url: `/repos/${repo.fullName}/pull/${pull.number}`,
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    created_at: isoOf(1_700_000_000 + comment.id),
    html_url: `/repos/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

/** Page through a list, answering with a Link header when more pages remain. */
function paged<T>(req: HttpRequest, items: readonly T[], render: (item: T) => unknown): HttpResponse {
  const perPage = Math.min(100, intParam(req.query, 'per_page', 30));
  const page = intParam(req.query, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const base = `http://${req.host}${req.path}`;
    const lastPage = Math.ceil(items.length / perPage);
    const withPage = (p: number): string => {
      const params = new URLSearchParams(req.query);
      params.set('per_page', String(perPage));
      params.set('page', String(p));
      return `<${base}?${params.toString()}>`;
    };
    headers.link = `${withPage(page + 1)}; rel="next", ${withPage(lastPage)}; rel="last"`;
  }
  return json(200, slice.map(render), headers);
}

/** Resolve refs/heads/<branch> or a raw commit id to a commit oid. */
function resolveCommit(repo: Repo, refOrSha: string | undefined): string | null {
  if (refOrSha === undefined || refOrSha === '') {
    return repo.refCommit(repo.headRef);
  }
  const byRef = repo.refCommit(`refs/heads/${refOrSha}`);
  if (byRef !== null) return byRef;
  const direct = repo.refCommit(refOrSha);
  if (direct !== null) return direct;
  return repo.peelToCommit(refOrSha);
}

// ---------------------------------------------------------------------------

export function handleRest(forge: Forge, req: HttpRequest): HttpResponse | null {
  const path = req.path;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;
  // After the prefix check the split is known: ['', 'api', 'v3', ...rest].
  // Take the rest directly (dropping one trailing empty from a final '/')
  // instead of filtering and re-slicing a copy of every segment.
  const segments = path.split('/').slice(3);
  if (segments.length > 0 && segments[segments.length - 1] === '') segments.pop();
  const method = req.method;

  // Body-bearing verbs must carry valid JSON when they carry a body at all.
  let body: Record<string, unknown> = {};
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = parseJsonBody(req.body);
    if (!parsed.ok) return jsonError(400, 'Problems parsing JSON');
    body = parsed.value;
  }

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      return json(
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return jsonError(404, NOT_FOUND);
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return json(200, userJson());
  }

  // The viewer's repository collection.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = str(body.name);
      if (name === '') return jsonError(422, 'name is required');
      if (forge.repo(VIEWER.login, name) !== null) {
        return jsonError(422, `name already exists on this account`);
      }
      const repo = forge.createRepo(
        VIEWER.login,
        name,
        typeof body.description === 'string' ? body.description : '',
        bool(body.private, false),
        typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
      );
      if (repo === null) return jsonError(422, 'name already exists on this account');
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      return paged(req, forge.reposOf(VIEWER.login), (repo) => repoJson(repo));
    }
    return jsonError(404, NOT_FOUND);
  }

  // Everything under /repos/{owner}/{repo}/…
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] as string);
    const name = decodeURIComponent(segments[2] as string);
    const repo = forge.repo(owner, name);
    if (repo === null) return jsonError(404, NOT_FOUND);
    const rest = segments.slice(3);
    return handleRepo(forge, req, repo, rest, body);
  }

  return jsonError(404, NOT_FOUND);
}

function handleRepo(forge: Forge, req: HttpRequest, repo: Repo, rest: string[], body: Record<string, unknown>): HttpResponse {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(repo.fullName);
        (repo as { name: string }).name = body.name;
        forge.repos.set(repo.fullName, repo);
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
    }
    return jsonError(404, NOT_FOUND);
  }

  const head = rest[0] as string;

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1] as string);
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (oid === undefined) return jsonError(404, 'Branch not found');
      return json(200, { name: branch, commit: { sha: oid }, protected: false });
    }
    return jsonError(404, NOT_FOUND);
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || repo.get(sha) === undefined) return jsonError(422, 'Invalid ref or sha');
      if (repo.refs.has(ref)) return jsonError(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: repo.get(sha)?.type ?? 'commit', url: '' }, url: '' });
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return jsonError(404, NOT_FOUND);
      return json(200, { ref, object: { sha: oid, type: repo.get(oid)?.type ?? 'commit', url: '' }, url: '' });
    }
    return jsonError(404, NOT_FOUND);
  }

  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const tip = resolveCommit(repo, req.query.get('sha') ?? undefined);
    if (tip === null) return json(200, []);
    const commits = listCommits(repo, tip).map((oid) => {
      const commit = parseCommit((repo.get(oid) as { data: Buffer }).data);
      const seconds = identSeconds(commit.committer);
      return {
        sha: oid,
        node_id: `C_${oid}`,
        commit: {
          message: commit.message,
          tree: { sha: commit.tree },
          author: { name: commit.author.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.author)?.[1] ?? '', date: isoOf(seconds) },
          committer: { name: commit.committer.replace(/ <.*$/, ''), email: /<([^>]*)>/.exec(commit.committer)?.[1] ?? '', date: isoOf(seconds) },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return paged(req, commits, (entry) => entry);
  }

  if (head === 'contents') {
    return handleContents(req, repo, rest.slice(1).join('/'), body);
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
    }
    if (method === 'POST' && rest.length === 1) {
      const name = str(body.name);
      const color = str(body.color) || 'ededed';
      if (name === '') return jsonError(422, 'name is required');
      // Creating a label that already exists updates it in place (201 either
      // way): the seeded default labels must not make creation fail.
      repo.labels.set(name, color.replace(/^#/, ''));
      return json(201, labelJson(repo, name));
    }
    return jsonError(404, NOT_FOUND);
  }

  if (head === 'issues') return handleIssues(req, repo, rest.slice(1), body);
  if (head === 'pulls') return handlePulls(req, repo, rest.slice(1), body);

  return jsonError(404, NOT_FOUND);
}

// ---------------------------------------------------------------------------
// contents

function handleContents(req: HttpRequest, repo: Repo, rawPath: string, body: Record<string, unknown>): HttpResponse {
  const method = req.method;
  const filePath = rawPath.split('/').map((part) => decodeURIComponent(part)).join('/');

  if (method === 'GET') {
    const refName = req.query.get('ref') ?? undefined;
    const tip = resolveCommit(repo, refName);
    if (tip === null) return jsonError(404, NOT_FOUND);
    const commit = repo.commitOf(tip);
    if (!commit) return jsonError(404, NOT_FOUND);
    if (filePath === '') {
      return json(200, dirListing(repo, commit.tree, ''));
    }
    const found = lookupPath(repo, commit.tree, filePath);
    if (found === null) return jsonError(404, NOT_FOUND);
    if (found.kind === 'dir') return json(200, dirListing(repo, found.oid, filePath));
    const object = repo.get(found.oid);
    if (!object) return jsonError(404, NOT_FOUND);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: object.data.toString('base64'),
      sha: found.oid,
      size: object.data.length,
      name: filePath.split('/').pop(),
      path: filePath,
    });
  }

  if (method === 'PUT') {
    const branch = optStr(body.branch) ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const message = str(body.message) || 'update';
    const encoded = str(body.content);
    let content: Buffer;
    try {
      content = Buffer.from(encoded, 'base64');
    } catch {
      return jsonError(422, 'content is not valid base64');
    }
    // A stale sha (the file changed since the caller read it) is a 409.
    const tip = repo.refCommit(ref);
    const existing = tip === null ? null : lookupPath(repo, (repo.commitOf(tip) as { tree: string }).tree, filePath);
    const givenSha = optStr(body.sha);
    if (existing !== null && existing.kind === 'file' && givenSha !== undefined && givenSha !== existing.oid) {
      return jsonError(409, `${filePath} has changed since it was read`);
    }
    if (existing !== null && existing.kind === 'file' && givenSha === undefined) {
      return jsonError(422, 'sha is required to update an existing file');
    }
    const isUpdate = existing !== null && existing.kind === 'file';
    const result = repo.commitPath(ref, filePath, content, message);
    return json(isUpdate ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        sha: result.blob,
        size: content.length,
        name: filePath.split('/').pop(),
        path: filePath,
      },
      commit: { sha: result.commit, message },
    });
  }

  if (method === 'DELETE') {
    const branch = optStr(body.branch) ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const message = str(body.message) || 'delete';
    const tip = repo.refCommit(ref);
    if (tip === null) return jsonError(404, NOT_FOUND);
    const existing = lookupPath(repo, (repo.commitOf(tip) as { tree: string }).tree, filePath);
    if (existing === null || existing.kind !== 'file') return jsonError(404, NOT_FOUND);
    const givenSha = optStr(body.sha);
    if (givenSha !== undefined && givenSha !== existing.oid) return jsonError(409, `${filePath} has changed since it was read`);
    const result = repo.commitPath(ref, filePath, null, message);
    return json(200, { content: null, commit: { sha: result.commit, message } });
  }

  return jsonError(404, NOT_FOUND);
}

function lookupPath(repo: Repo, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string } | null {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    const isLast = index === segments.length - 1;
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    if (isLast) return { kind: isDir ? 'dir' : 'file', oid: entry.oid };
    if (!isDir) return null;
    current = entry.oid;
  }
  return null;
}

function dirListing(repo: Repo, treeOid: string, prefix: string): unknown[] {
  const object = repo.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const child = repo.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: isDir ? 0 : child?.data.length ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// issues

function handleIssues(req: HttpRequest, repo: Repo, rest: string[], body: Record<string, unknown>): HttpResponse {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (title === '') return jsonError(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as { name?: unknown })?.name))) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return jsonError(422, `Label "${label}" does not exist`);
      }
      const issue = repo.createIssue(title, str(body.body), labels);
      return issueResponse(repo, issue, 201);
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return paged(req, issues, (issue) => issueJson(repo, issue));
    }
    return jsonError(404, NOT_FOUND);
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;

  if (rest.length === 1) {
    if (issue === undefined) return jsonError(404, NOT_FOUND);
    if (method === 'GET') return issueResponse(repo, issue);
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.map((entry) => (typeof entry === 'string' ? entry : str((entry as { name?: unknown })?.name)));
        for (const label of labels) if (!repo.labels.has(label)) return jsonError(422, `Label "${label}" does not exist`);
        issue.labels = labels;
      }
      return issueResponse(repo, issue);
    }
    return jsonError(404, NOT_FOUND);
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return jsonError(404, NOT_FOUND);
    if (method === 'POST') {
      const text = str(body.body);
      if (text === '') return jsonError(422, 'body is required');
      const comment = repo.addComment(number, text);
      return json(201, commentJson(repo, number, comment));
    }
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      return paged(req, comments, (comment) => commentJson(repo, number, comment));
    }
  }

  return jsonError(404, NOT_FOUND);
}

// ---------------------------------------------------------------------------
// pull requests

export function findPull(repo: Repo, number: number): PullRec | undefined {
  return repo.pulls.get(number);
}

/** Create a pull in the store from branch names; shared by REST, GraphQL, MCP. */
export function createPullIn(repo: Repo, input: { title: string; body: string; head: string; base: string }): PullRec | { error: string; status: number } {
  const headRef = input.head.includes(':') ? (input.head.split(':').pop() as string) : input.head;
  const baseRef = input.base.includes(':') ? (input.base.split(':').pop() as string) : input.base;
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined) return { error: `head branch ${headRef} does not exist`, status: 422 };
  if (baseSha === undefined) return { error: `base branch ${baseRef} does not exist`, status: 422 };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
      return { error: `A pull request already exists for ${headRef} into ${baseRef}`, status: 422 };
    }
  }
  return repo.createPull(input.title, input.body, headRef, headSha, baseRef, baseSha);
}

/** Merge a pull (squash semantics); shared by REST, GraphQL and MCP. */
export function mergePullIn(repo: Repo, pull: PullRec): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'Pull request is already merged', status: 405 };
  if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
  const sha = squashMerge(repo, pull);
  if (sha === null) return { error: 'Merge conflict', status: 405 };
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoOf(repo.tick());
  return { sha };
}

function handlePulls(req: HttpRequest, repo: Repo, rest: string[], body: Record<string, unknown>): HttpResponse {
  const method = req.method;

  if (rest.length === 0) {
    if (method === 'POST') {
      const created = createPullIn(repo, {
        title: str(body.title),
        body: str(body.body),
        head: str(body.head),
        base: str(body.base),
      });
      if ('error' in created) return jsonError(created.status, created.error);
      return json(201, pullJson(repo, created));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.seq - a.seq);
      return paged(req, pulls, (pull) => pullJson(repo, pull));
    }
    return jsonError(404, NOT_FOUND);
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 1 && method === 'GET') {
    if (pull === undefined) return jsonError(404, NOT_FOUND);
    return json(200, pullJson(repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return jsonError(404, NOT_FOUND);
    const baseCommit = repo.peelToCommit(pull.baseSha) ?? pull.baseSha;
    const headCommit = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const headPeel = repo.peelToCommit(headCommit) ?? headCommit;
    const changes = diffFiles(repo, repo.filesAt(baseCommit), repo.filesAt(headPeel));
    return json(200, changes.map((change) => ({ ...change, sha: '', patch: '' })));
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return jsonError(404, NOT_FOUND);
    const merged = mergePullIn(repo, pull);
    if ('error' in merged) return jsonError(merged.status, merged.error);
    return json(200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return jsonError(404, NOT_FOUND);
}
