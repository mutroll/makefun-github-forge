// graphql.ts — a compact GraphQL engine for the subset of GitHub's v4 API
// the forge serves: a tokenizer, a parser for operations/fragments/values,
// and an executor whose resolvers read and write the same store as REST.
//
// It implements real GraphQL mechanics — aliases, variables, input objects,
// enum and list literals, inline fragments, cursor connections, Relay global
// ids, batched operation arrays and field errors as HTTP 200 + `errors` —
// rather than pattern-matching individual documents, so any document built
// from the served schema resolves the same way.

import { Forge, Repo, VIEWER, diffFiles, mergeTrees, type IssueRec, type PullRec } from './store.ts';
import { createPullIn, mergePullIn } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
        this.skipDirectives();
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment without on');
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parens');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.skipBalancedParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value !== 'on') {
        return { kind: 'spread', name: this.expectName() };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// global ids

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// schema surface for introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'description', 'url',
    'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'refs',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergeCommit', 'author',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'repository',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

type Source =
  | { type: 'User' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: IssueRec }
  | { type: 'PullRequest'; repo: Repo; pull: PullRec }
  | { type: 'Ref'; name: string }
  | { type: 'IssueComment'; repo: Repo; id: number; body: string }
  | { type: 'Connection'; connType: string; items: Source[]; hasNextPage: boolean; endCursor: string | null; totalCount: number }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { type: 'Payload'; payloadType: string; value: Source | null }
  | { type: 'CommentEdge'; node: Source }
  | { type: 'GqlType'; name: string }
  | { type: 'GqlField'; name: string }
  | { type: 'GqlEnumValue'; name: string }
  | { type: 'Label'; repo: Repo; name: string };

const SCALAR = Symbol('scalar');

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let descending = false;
  const orderBy = args.orderBy;
  if (orderBy !== null && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'DESC') descending = true;
    if (direction === 'ASC') descending = false;
  }
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const total = issues.length;
  const afterNumber = numberFromCursor(args.after);
  let start = 0;
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < total;
  const last = page[page.length - 1];
  return {
    type: 'Connection',
    connType: 'IssueConnection',
    items: page.map((issue) => ({ type: 'Issue', repo, issue }) as Source),
    hasNextPage,
    endCursor: last ? cursorOf(last.number) : null,
    totalCount: total,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Source {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const total = pulls.length;
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : total;
  const page = pulls.slice(0, first);
  return {
    type: 'Connection',
    connType: 'PullRequestConnection',
    items: page.map((pull) => ({ type: 'PullRequest', repo, pull }) as Source),
    hasNextPage: page.length < total,
    endCursor: page.length > 0 ? cursorOf((page[page.length - 1] as PullRec).number) : null,
    totalCount: total,
  };
}

function pullState(pull: PullRec): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

function pullMergeable(repo: Repo, pull: PullRec): string {
  if (pull.merged) return 'UNKNOWN';
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const baseCommit = repo.commitOf(baseTip);
  const headCommit = repo.commitOf(headTip);
  if (!baseCommit || !headCommit) return 'UNKNOWN';
  const base = repo.mergeBase(baseTip, headTip);
  const ancestorTree = base === null ? null : repo.commitOf(base)?.tree ?? null;
  const result = mergeTrees(repo, ancestorTree, baseCommit.tree, headCommit.tree);
  return 'conflict' in result ? 'CONFLICTING' : 'MERGEABLE';
}

function filesConnection(repo: Repo, pull: PullRec, args: Record<string, unknown>): Source {
  const baseCommit = repo.peelToCommit(pull.baseSha) ?? pull.baseSha;
  const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const headCommit = repo.peelToCommit(headOid) ?? headOid;
  const changes = diffFiles(repo, repo.filesAt(baseCommit), repo.filesAt(headCommit));
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
  const page = changes.slice(0, first);
  return {
    type: 'Connection',
    connType: 'PullRequestChangedFileConnection',
    items: page.map((change) => ({ type: 'ChangedFile', path: change.filename }) as unknown as Source),
    hasNextPage: page.length < changes.length,
    endCursor: null,
    totalCount: changes.length,
  };
}

type ChangedFileSource = { type: 'ChangedFile'; path: string };

/** Resolve one field on one source; SCALAR marks a leaf value. */
function resolveField(ctx: Ctx, sourceType: string, source: Source | null, field: string, args: Record<string, unknown>): { value: unknown; type: string } | typeof SCALAR {
  const forge = ctx.forge;
  // Dispatch on the source's own kind: a connection answers as 'Connection'
  // whatever its GraphQL type name (IssueConnection, …), a mutation payload
  // as 'Payload', a node(id:) hit as the concrete type it resolved to.
  const kind = source === null ? sourceType : source.type;
  switch (kind) {
    case 'Query': {
      switch (field) {
        case 'viewer':
          return { value: { type: 'User' } as Source, type: 'User' };
        case 'repository': {
          const repo = forge.repo(String(args.owner ?? ''), String(args.name ?? ''));
          return { value: repo === null ? null : ({ type: 'Repository', repo } as Source), type: 'Repository' };
        }
        case 'node': {
          const node = nodeById(ctx, String(args.id ?? ''));
          return { value: node, type: node === null ? 'Node' : concreteType(node) };
        }
        case '__type': {
          const name = String(args.name ?? '');
          const known = TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined;
          return { value: known ? ({ type: 'GqlType', name } as Source) : null, type: '__Type' };
        }
        case '__schema':
          return { value: null, type: '__Schema' };
        default:
          break;
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, args);
    }
    case 'User': {
      switch (field) {
        case 'login':
          return leaf(VIEWER.login);
        case 'id':
          return leaf(globalId('User', VIEWER.id));
        case 'name':
          return leaf(VIEWER.name);
        case 'email':
          return leaf(VIEWER.email);
        default:
          break;
      }
      break;
    }
    case 'Repository': {
      const repo = (source as { repo: Repo }).repo;
      switch (field) {
        case 'id':
          return leaf(globalId('Repository', repo.dbId));
        case 'databaseId':
          return leaf(repo.dbId);
        case 'name':
          return leaf(repo.name);
        case 'nameWithOwner':
          return leaf(repo.fullName);
        case 'description':
          return leaf(repo.description);
        case 'isPrivate':
          return leaf(repo.isPrivate);
        case 'owner':
          return { value: { type: 'User' } as Source, type: 'User' };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(repo.headRef);
          return { value: tip === undefined ? null : ({ type: 'Ref', name: repo.defaultBranch } as Source), type: 'Ref' };
        }
        case 'viewerPermission':
          return leaf('ADMIN');
        case 'hasIssuesEnabled':
          return leaf(true);
        case 'hasProjectsEnabled':
          return leaf(true);
        case 'hasWikiEnabled':
          return leaf(true);
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return { value: issue === undefined ? null : ({ type: 'Issue', repo, issue } as Source), type: 'Issue' };
        }
        case 'issues':
          return { value: issuesConnection(repo, args), type: 'IssueConnection' };
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return { value: pull === undefined ? null : ({ type: 'PullRequest', repo, pull } as Source), type: 'PullRequest' };
        }
        case 'pullRequests':
          return { value: pullsConnection(repo, args), type: 'PullRequestConnection' };
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: IssueRec };
      switch (field) {
        case 'id':
          return leaf(globalId('Issue', repo.dbId, issue.number));
        case 'number':
          return leaf(issue.number);
        case 'title':
          return leaf(issue.title);
        case 'body':
          return leaf(issue.body);
        case 'state':
          return leaf(issue.state.toUpperCase());
        case 'repository':
          return { value: { type: 'Repository', repo } as Source, type: 'Repository' };
        case 'author':
          return { value: { type: 'User' } as Source, type: 'User' };
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: PullRec };
      switch (field) {
        case 'id':
          return leaf(globalId('PullRequest', repo.dbId, pull.number));
        case 'number':
          return leaf(pull.number);
        case 'title':
          return leaf(pull.title);
        case 'body':
          return leaf(pull.body);
        case 'state':
          return leaf(pullState(pull));
        case 'merged':
          return leaf(pull.merged);
        case 'mergeable':
          return leaf(pullMergeable(repo, pull));
        case 'headRefName':
          return leaf(pull.headRef);
        case 'baseRefName':
          return leaf(pull.baseRef);
        case 'repository':
          return { value: { type: 'Repository', repo } as Source, type: 'Repository' };
        case 'author':
          return { value: { type: 'User' } as Source, type: 'User' };
        case 'files':
          return { value: filesConnection(repo, pull, args), type: 'PullRequestChangedFileConnection' };
        default:
          break;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return leaf((source as { name: string }).name);
      if (field === 'prefix') return leaf('refs/heads/');
      break;
    }
    case 'IssueComment': {
      const comment = source as { repo: Repo; id: number; body: string };
      if (field === 'id') return leaf(globalId('IssueComment', comment.repo.dbId, comment.id));
      if (field === 'body') return leaf(comment.body);
      if (field === 'author') return { value: { type: 'User' } as Source, type: 'User' };
      break;
    }
    case 'ChangedFile': {
      if (field === 'path') return leaf((source as unknown as ChangedFileSource).path);
      break;
    }
    case 'Connection': {
      const conn = source as Extract<Source, { type: 'Connection' }>;
      if (field === 'nodes') return { value: conn.items, type: conn.connType.replace('Connection', '') };
      if (field === 'pageInfo') {
        return {
          value: { type: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } as Source,
          type: 'PageInfo',
        };
      }
      if (field === 'totalCount') return leaf(conn.totalCount);
      if (field === 'edges') return { value: [], type: 'Edge' };
      break;
    }
    case 'PageInfo': {
      const info = source as Extract<Source, { type: 'PageInfo' }>;
      if (field === 'hasNextPage') return leaf(info.hasNextPage);
      if (field === 'hasPreviousPage') return leaf(false);
      if (field === 'endCursor') return leaf(info.endCursor);
      if (field === 'startCursor') return leaf(info.endCursor);
      break;
    }
    case 'Payload': {
      const payload = source as Extract<Source, { type: 'Payload' }>;
      if (field === 'clientMutationId') return leaf(null);
      if (payload.payloadType === 'AddCommentPayload' && field === 'commentEdge') {
        return { value: payload.value === null ? null : ({ type: 'CommentEdge', node: payload.value } as Source), type: 'IssueCommentEdge' };
      }
      if (field === 'issue') return { value: payload.value, type: 'Issue' };
      if (field === 'pullRequest') return { value: payload.value, type: 'PullRequest' };
      if (field === 'subject') return { value: payload.value, type: 'Issue' };
      break;
    }
    case 'CommentEdge': {
      if (field === 'node') return { value: (source as Extract<Source, { type: 'CommentEdge' }>).node, type: 'IssueComment' };
      if (field === 'cursor') return leaf(cursorOf(0));
      break;
    }
    case 'GqlType': {
      const typeName = (source as { name: string }).name;
      if (field === 'name') return leaf(typeName);
      if (field === 'kind') return leaf(ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT');
      if (field === 'fields') {
        const names = TYPE_FIELDS[typeName] ?? [];
        return { value: names.map((name) => ({ type: 'GqlField', name }) as Source), type: '__Field' };
      }
      if (field === 'enumValues') {
        const names = ENUM_VALUES[typeName] ?? [];
        return { value: names.map((name) => ({ type: 'GqlEnumValue', name }) as Source), type: '__EnumValue' };
      }
      break;
    }
    case 'GqlField':
    case 'GqlEnumValue': {
      if (field === 'name') return leaf((source as { name: string }).name);
      if (field === 'description') return leaf(null);
      if (field === 'isDeprecated') return leaf(false);
      if (field === 'deprecationReason') return leaf(null);
      break;
    }
    case 'Label': {
      const label = source as Extract<Source, { type: 'Label' }>;
      if (field === 'name') return leaf(label.name);
      if (field === 'color') return leaf(label.repo.labels.get(label.name) ?? 'ededed');
      if (field === 'id') return leaf(globalId('Label', label.repo.dbId, label.name));
      break;
    }
    default:
      break;
  }
  ctx.errors.push({ message: `Cannot query field '${field}' on type '${sourceType}'.` });
  return leaf(null);
}

function leaf(value: unknown): { value: unknown; type: string } {
  return { value, type: 'Scalar' };
}

function nodeById(ctx: Ctx, id: string): Source | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const dbId = Number(decoded.parts[0]);
    for (const repo of ctx.forge.repos.values()) {
      if (repo.dbId === dbId) return { type: 'Repository', repo };
    }
    return null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const dbId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of ctx.forge.repos.values()) {
      if (repo.dbId !== dbId) continue;
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { type: 'Issue', repo, issue };
      }
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : { type: 'PullRequest', repo, pull };
    }
  }
  return null;
}

function repoByGlobalId(ctx: Ctx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const node = nodeById(ctx, id);
  return node !== null && node.type === 'Repository' ? node.repo : null;
}

function resolveMutation(ctx: Ctx, field: string, args: Record<string, unknown>): { value: unknown; type: string } {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository.' });
        return leaf(null);
      }
      const issue = repo.createIssue(String(input.title ?? ''), String(input.body ?? ''), []);
      return { value: { type: 'Payload', payloadType: 'CreateIssuePayload', value: { type: 'Issue', repo, issue } as Source } as Source, type: 'CreateIssuePayload' };
    }
    case 'closeIssue': {
      const node = typeof input.issueId === 'string' ? nodeById(ctx, input.issueId) : null;
      if (node === null || node.type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the issue.' });
        return leaf(null);
      }
      node.issue.state = 'closed';
      return { value: { type: 'Payload', payloadType: 'CloseIssuePayload', value: node } as Source, type: 'CloseIssuePayload' };
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(ctx, input.repositoryId);
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve the repository.' });
        return leaf(null);
      }
      const created = createPullIn(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return leaf(null);
      }
      return {
        value: { type: 'Payload', payloadType: 'CreatePullRequestPayload', value: { type: 'PullRequest', repo, pull: created } as Source } as Source,
        type: 'CreatePullRequestPayload',
      };
    }
    case 'mergePullRequest': {
      const node = typeof input.pullRequestId === 'string' ? nodeById(ctx, input.pullRequestId) : null;
      if (node === null || node.type !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve the pull request.' });
        return leaf(null);
      }
      const merged = mergePullIn(node.repo, node.pull);
      if ('error' in merged) {
        ctx.errors.push({ message: merged.error });
        return { value: { type: 'Payload', payloadType: 'MergePullRequestPayload', value: node } as Source, type: 'MergePullRequestPayload' };
      }
      return { value: { type: 'Payload', payloadType: 'MergePullRequestPayload', value: node } as Source, type: 'MergePullRequestPayload' };
    }
    case 'addComment': {
      const node = typeof input.subjectId === 'string' ? nodeById(ctx, input.subjectId) : null;
      if (node === null || node.type !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve the comment subject.' });
        return leaf(null);
      }
      const comment = node.repo.addComment(node.issue.number, String(input.body ?? ''));
      const commentSource = { type: 'IssueComment', repo: node.repo, id: comment.id, body: comment.body } as Source;
      return { value: { type: 'Payload', payloadType: 'AddCommentPayload', value: commentSource } as Source, type: 'AddCommentPayload' };
    }
    default:
      ctx.errors.push({ message: `Cannot query field '${field}' on type 'Mutation'.` });
      return leaf(null);
  }
}

/** The concrete type a source answers to (for inline fragments). */
function concreteType(source: Source | null): string {
  if (source === null) return '';
  switch (source.type) {
    case 'Connection':
      return source.connType;
    case 'Payload':
      return source.payloadType;
    case 'GqlType':
      return '__Type';
    case 'GqlField':
      return '__Field';
    case 'GqlEnumValue':
      return '__EnumValue';
    case 'CommentEdge':
      return 'IssueCommentEdge';
    default:
      return source.type;
  }
}

function executeSelection(ctx: Ctx, sourceType: string, source: Source | null, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelection(ctx, sourceType, source, fragment));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === concreteType(source) || selection.typeCondition === sourceType) {
        Object.assign(out, executeSelection(ctx, selection.typeCondition ?? sourceType, source, selection.selection));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    const resolved = resolveField(ctx, sourceType, source, selection.name, args);
    if (resolved === SCALAR || resolved.type === 'Scalar') {
      out[key] = resolved === SCALAR ? null : resolved.value;
      continue;
    }
    const value = resolved.value as Source | Source[] | null;
    if (value === null) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        selection.selection ? executeSelection(ctx, resolved.type, item, selection.selection) : item,
      );
    } else {
      out[key] = selection.selection ? executeSelection(ctx, resolved.type, value, selection.selection) : value;
    }
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one operation document (or, given an array body upstream, one entry of it). */
export function executeGraphQL(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation in the document.' }] };
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selection);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
