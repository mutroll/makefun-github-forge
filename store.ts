// store.ts — the forge's in-memory data model and its git object machinery.
//
// Everything the four surfaces (git smart HTTP, REST v3, GraphQL, MCP) serve
// lives here: one object database per repository, refs, issues, pull requests,
// comments and labels. Objects are addressed exactly the way git addresses
// them — SHA-1 over "<type> <length>\0<bytes>" — so anything a client pushes
// round-trips byte-for-byte, and anything the forge creates itself (contents
// commits, squash merges) is an ordinary commit in the same store.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

/** The one identity the bearer token names in this trial's world. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

/** SHA-1 of a git object's canonical framing. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// commits and trees

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(view: CommitView): Buffer {
  const lines = [`tree ${view.tree}`];
  for (const parent of view.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${view.author}`);
  lines.push(`committer ${view.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${view.message}`, 'utf8');
}

/** "Name <email> 1700000000 +0000" from parts and a unix timestamp. */
export function ident(name: string, email: string, unixSeconds: number): string {
  return `${name} <${email}> ${unixSeconds} +0000`;
}

/** The date half of an ident line ("1700000000 +0000" -> seconds), or 0. */
export function identSeconds(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match ? Number(match[1]) : 0;
}

export function isoOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories sorting as if suffixed "/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
  }
  return view;
}

// ---------------------------------------------------------------------------
// repositories

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

const DEFAULT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['bug', 'd73a4a'],
  ['documentation', '0075ca'],
  ['duplicate', 'cfd3d7'],
  ['enhancement', 'a2eeef'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
  ['invalid', 'e4e669'],
  ['question', 'd876e3'],
  ['wontfix', 'ffffff'],
];

/** A fixed epoch the forge's own commits derive their times from. */
const FORGE_EPOCH = 1_700_000_000;

export class Repo {
  readonly dbId: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly objects = new Map<string, StoredObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, string>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly comments = new Map<number, CommentRec[]>();
  private nextNumber = 1;
  private nextIssueId: number;
  private clock = 0;

  constructor(dbId: number, owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.dbId = dbId;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
    this.nextIssueId = dbId * 100000;
    for (const [label, color] of DEFAULT_LABELS) this.labels.set(label, color);
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** The forge's deterministic clock: a fresh timestamp for each own commit. */
  tick(): number {
    this.clock += 1;
    return FORGE_EPOCH + this.clock * 60;
  }

  store(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  commitOf(oid: string): CommitView | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Peel tags until a commit (or something else) shows; null when unknown. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      current = parseTag(object.data).object;
    }
    return null;
  }

  /** The commit a ref names, following the ref and any tag chain. */
  refCommit(ref: string): string | null {
    const oid = this.refs.get(ref);
    return oid === undefined ? null : this.peelToCommit(oid);
  }

  /** Every object reachable from the given tips (commits, trees, blobs, tags). */
  reachable(tips: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree, ...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** Ancestor test over commit parents: is `ancestor` reachable from `tip`? */
  isAncestor(ancestor: string, tip: string): boolean {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (commit) stack.push(...commit.parents);
    }
    return false;
  }

  /** The best common ancestor of two commits (first shared commit in BFS order), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestorsOfA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const commit = this.commitOf(oid);
      if (commit) stackA.push(...commit.parents);
    }
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const commit = this.commitOf(oid);
      if (commit) queue.push(...commit.parents);
    }
    return null;
  }

  /** Flatten a tree into path -> {oid, mode} for every blob under it. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) the tree for a flat path -> blob map. */
  treeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Dir {
      files: TreeEntry[];
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, blob] of flat) {
      const segments = path.split('/');
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        let next = dir.dirs.get(segment);
        if (!next) {
          next = { files: [], dirs: new Map() };
          dir.dirs.set(segment, next);
        }
        dir = next;
      }
      dir.files.push({ mode: blob.mode, name: segments[segments.length - 1] as string, oid: blob.oid });
    }
    const build = (dir: Dir): string => {
      const entries: TreeEntry[] = [...dir.files];
      for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.store('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The flat file map at a commit (empty when the commit is unknown). */
  filesAt(commitOid: string): Map<string, { oid: string; mode: string }> {
    const commit = this.commitOf(commitOid);
    if (!commit) return new Map();
    return this.flattenTree(commit.tree);
  }

  /** Make one commit of the forge's own, authored by the viewer. */
  ownCommit(tree: string, parents: string[], message: string): string {
    const when = ident(VIEWER.name, VIEWER.email, this.tick());
    return this.store('commit', buildCommit({ tree, parents, author: when, committer: when, message }));
  }

  /** Commit a single path change (null content deletes) on a branch; returns the commit oid. */
  commitPath(branchRef: string, path: string, content: Buffer | null, message: string): { commit: string; blob: string | null } {
    const tip = this.refs.get(branchRef);
    const baseCommit = tip === undefined ? null : this.peelToCommit(tip);
    const flat = baseCommit === null ? new Map<string, { oid: string; mode: string }>() : this.filesAt(baseCommit);
    let blob: string | null = null;
    if (content === null) {
      flat.delete(path);
    } else {
      blob = this.store('blob', content);
      const existing = flat.get(path);
      flat.set(path, { oid: blob, mode: existing?.mode ?? '100644' });
    }
    const tree = this.treeFromFlat(flat);
    const commit = this.ownCommit(tree, baseCommit === null ? [] : [baseCommit], message);
    this.refs.set(branchRef, commit);
    return { commit, blob };
  }

  createIssue(title: string, body: string, labels: string[]): IssueRec {
    const number = this.nextNumber;
    this.nextNumber += 1;
    this.nextIssueId += 1;
    const issue: IssueRec = { number, id: this.nextIssueId, title, body, state: 'open', labels: [...labels], seq: number };
    this.issues.set(number, issue);
    return issue;
  }

  createPull(title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): PullRec {
    const number = this.nextNumber;
    this.nextNumber += 1;
    this.nextIssueId += 1;
    const pull: PullRec = {
      number,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      seq: number,
    };
    this.pulls.set(number, pull);
    return pull;
  }

  addComment(issueNumber: number, body: string): CommentRec {
    this.nextIssueId += 1;
    const comment: CommentRec = { id: this.nextIssueId, body, seq: this.nextIssueId };
    const list = this.comments.get(issueNumber) ?? [];
    list.push(comment);
    this.comments.set(issueNumber, list);
    return comment;
  }
}

// ---------------------------------------------------------------------------
// the whole forge

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch = 'main'): Repo | null {
    const key = `${owner}/${name}`;
    if (this.repos.has(key)) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate, defaultBranch);
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  repo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  reposOf(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }
}

// ---------------------------------------------------------------------------
// three-way tree merge and file diffs (pull requests)

/** Merge head's tree onto base's tree with `ancestor` as the merge base. */
export function mergeTrees(
  repo: Repo,
  ancestorTree: string | null,
  baseTree: string,
  headTree: string,
): { tree: string } | { conflict: string } {
  const ancestor = ancestorTree === null ? new Map<string, { oid: string; mode: string }>() : repo.flattenTree(ancestorTree);
  const base = repo.flattenTree(baseTree);
  const head = repo.flattenTree(headTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const sameAB = a?.oid === b?.oid && a?.mode === b?.mode;
    const sameAH = a?.oid === h?.oid && a?.mode === h?.mode;
    const sameBH = b?.oid === h?.oid && b?.mode === h?.mode;
    if (sameBH) {
      if (b) merged.set(path, b);
    } else if (sameAH) {
      if (b) merged.set(path, b);
    } else if (sameAB) {
      if (h) merged.set(path, h);
    } else {
      return { conflict: path };
    }
  }
  return { tree: repo.treeFromFlat(merged) };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** A line-level diff summary between two flat file maps. */
export function diffFiles(repo: Repo, baseFiles: ReadonlyMap<string, { oid: string; mode: string }>, headFiles: ReadonlyMap<string, { oid: string; mode: string }>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b && h && b.oid === h.oid) continue;
    const baseData = b ? repo.get(b.oid)?.data ?? Buffer.alloc(0) : null;
    const headData = h ? repo.get(h.oid)?.data ?? Buffer.alloc(0) : null;
    let additions = 0;
    let deletions = 0;
    let status: FileChange['status'];
    if (b === undefined || baseData === null) {
      status = 'added';
      additions = lineCount(headData ?? Buffer.alloc(0));
    } else if (h === undefined || headData === null) {
      status = 'removed';
      deletions = lineCount(baseData);
    } else {
      status = 'modified';
      // A simple LCS-free estimate: lines only in head count as additions,
      // lines only in base as deletions (multiset difference).
      const baseLines = new Map<string, number>();
      for (const line of baseData.toString('utf8').split('\n')) baseLines.set(line, (baseLines.get(line) ?? 0) + 1);
      const headLines = new Map<string, number>();
      for (const line of headData.toString('utf8').split('\n')) headLines.set(line, (headLines.get(line) ?? 0) + 1);
      for (const [line, count] of headLines) additions += Math.max(0, count - (baseLines.get(line) ?? 0));
      for (const [line, count] of baseLines) deletions += Math.max(0, count - (headLines.get(line) ?? 0));
      if (additions === 0 && deletions === 0) additions = 1;
    }
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

/** Attempt a squash merge of a pull request; null on conflict. */
export function squashMerge(repo: Repo, pull: PullRec): string | null {
  const baseTip = repo.refCommit(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refCommit(`refs/heads/${pull.headRef}`);
  if (baseTip === null || headTip === null) return null;
  const baseCommit = repo.commitOf(baseTip);
  const headCommit = repo.commitOf(headTip);
  if (!baseCommit || !headCommit) return null;
  const base = repo.mergeBase(baseTip, headTip);
  const ancestorTree = base === null ? null : repo.commitOf(base)?.tree ?? null;
  const result = mergeTrees(repo, ancestorTree, baseCommit.tree, headCommit.tree);
  if ('conflict' in result) return null;
  const message = `${pull.title} (#${pull.number})`;
  return repo.ownCommit(result.tree, [baseTip], message);
}
