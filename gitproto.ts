// gitproto.ts — the git smart-HTTP wire: pkt-lines, packfiles, ref
// advertisements, protocol v0 and v2 upload-pack, and v0 receive-pack.
//
// Written against the git protocol itself: objects are framed the way git
// frames them, packs are version-2 with plain (undeltified) objects — a form
// every reader accepts — and incoming packs may carry OFS/REF deltas, which
// are resolved against the objects already read.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  Repo,
  ZERO_OID,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  type ObjectType,
  type StoredObject,
} from './store.ts';

export const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// pkt-lines

export function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a whole pkt-line stream; throws on malformed framing. */
export function parsePackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4) {
      throw new Error(`bad pkt-line length ${length}`);
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------------------
// packfiles

const TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: ReadonlyArray<{ oid: string } & StoredObject>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const varint: number[] = [];
    if (size === 0) {
      varint.push(first);
    } else {
      varint.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        varint.push(size > 0 ? byte | 0x80 : byte);
      }
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at `offset`; returns data + next offset. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed nothing');
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const count = op & 0x7f;
      delta.copy(out, written, offset, offset + count);
      offset += count;
      written += count;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

/** Read a packfile into resolved objects (deltas applied), in pack order. */
export function readPack(pack: Buffer, lookupExternal?: (oid: string) => StoredObject | undefined): PackObject[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, PackObject>();
  const resolved: PackObject[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] as number;
    offset += 1;
    let typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeId === 6) {
      // OFS_DELTA: a backwards offset to the base object's start.
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = (back + 1) * 128 + (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === 7) {
      // REF_DELTA: the base object's id.
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    let object: PackObject;
    if (typeId === 6 || typeId === 7) {
      let base: PackObject | StoredObject | undefined;
      if (typeId === 6) base = byOffset.get(baseOffset);
      else if (baseOid !== null) base = resolved.find((entry) => entry.oid === baseOid) ?? lookupExternal?.(baseOid);
      if (!base) throw new Error('delta base is not in the pack or the store');
      const data = applyDelta(base.data, inflated.data);
      object = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`pack object type ${typeId}`);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      object = { oid: hashObject(type, inflated.data), type, data: inflated.data };
    }
    byOffset.set(start, object);
    resolved.push(object);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// sideband framing

/** Wrap pack bytes in band-1 sideband packets (payloads stay under the cap). */
export function sidebandPackets(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (chunks.length === 0) chunks.push(pkt(Buffer.from([1])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// advertisements

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.get(oid);
  if (!object || object.type !== 'tag') return null;
  return repo.peelToCommit(oid);
}

export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:${repo.headRef}`
      : `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(repo.headRef);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pkt(`${oid} ${ref}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null && ref.startsWith('refs/tags/')) parts.push(pkt(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)

export function lsRefs(repo: Repo, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(repo.headRef);
  if (prefixes.length === 0) {
    if (headTip !== undefined) {
      parts.push(pkt(`${headTip} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack)

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowArgs: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  objects: Array<{ oid: string } & StoredObject>;
  shallow: string[];
  unshallow: string[];
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const wants = request.wants.filter((oid) => repo.get(oid) !== undefined);
  if (request.depth === null) {
    const haveClosure = repo.reachable(request.haves.filter((oid) => repo.get(oid) !== undefined));
    const wantClosure = repo.reachable(wants);
    const objects: Array<{ oid: string } & StoredObject> = [];
    for (const oid of wantClosure) {
      if (haveClosure.has(oid)) continue;
      const object = repo.get(oid);
      if (object) objects.push({ oid, ...object });
    }
    return { objects, shallow: [], unshallow: [] };
  }

  // Depth-limited: commits within `depth` generations of the wants, minus
  // the have tips themselves; each included commit brings its whole tree.
  const depth = Math.max(1, request.depth);
  const distance = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const want of wants) {
    const commit = repo.peelToCommit(want);
    if (commit !== null) queue.push([commit, 1]);
  }
  while (queue.length > 0) {
    const [oid, dist] = queue.shift() as [string, number];
    if (dist > depth) continue;
    if (distance.has(oid) && (distance.get(oid) as number) <= dist) continue;
    distance.set(oid, dist);
    const commit = repo.commitOf(oid);
    if (commit) for (const parent of commit.parents) queue.push([parent, dist + 1]);
  }
  const haveSet = new Set(request.haves);
  const includedCommits = new Set<string>();
  for (const [oid, dist] of distance) {
    if (dist <= depth && !haveSet.has(oid)) includedCommits.add(oid);
  }
  const include = new Set<string>();
  for (const oid of includedCommits) {
    include.add(oid);
    const commit = repo.commitOf(oid);
    if (commit) {
      // The commit's own tree closure only — never its ancestry's.
      for (const part of repo.reachable([commit.tree])) include.add(part);
    }
  }
  const objects: Array<{ oid: string } & StoredObject> = [];
  for (const oid of include) {
    const object = repo.get(oid);
    if (object) objects.push({ oid, ...object });
  }
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const commit = repo.commitOf(oid);
    if (!commit) continue;
    const parentsOutside = commit.parents.filter((parent) => !includedCommits.has(parent));
    if (commit.parents.length > 0 && parentsOutside.length > 0 && !parentsOutside.every((parent) => haveSet.has(parent))) {
      shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of request.shallowArgs) {
    if (shallow.includes(oid)) continue;
    const commit = repo.commitOf(oid);
    if (commit && commit.parents.some((parent) => includedCommits.has(parent))) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

function orderForPack(objects: Array<{ oid: string } & StoredObject>): Array<{ oid: string } & StoredObject> {
  const rank = (type: ObjectType): number => (type === 'commit' ? 0 : type === 'tag' ? 1 : type === 'tree' ? 2 : 3);
  return [...objects].sort((a, b) => rank(a.type) - rank(b.type) || (a.oid < b.oid ? -1 : 1));
}

export function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(orderForPack(plan.objects));
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pkt('acknowledgments\n'));
  const knownHaves = request.haves.filter((oid) => repo.get(oid) !== undefined);
  if (knownHaves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    for (const have of knownHaves) parts.push(pkt(`ACK ${have} common\n`));
    if (request.done) parts.push(pkt('ready\n'));
  }
  parts.push(PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function fetchV0(repo: Repo, request: FetchRequest, capabilities: ReadonlySet<string>): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(orderForPack(plan.objects));
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const knownHaves = request.haves.filter((oid) => repo.get(oid) !== undefined);
  if (knownHaves.length === 0) {
    parts.push(pkt('NAK\n'));
  } else if (capabilities.has('multi_ack_detailed')) {
    for (const have of knownHaves) parts.push(pkt(`ACK ${have} common\n`));
    parts.push(pkt(`ACK ${knownHaves[knownHaves.length - 1]} ready\n`));
  } else {
    parts.push(pkt(`ACK ${knownHaves[knownHaves.length - 1]}\n`));
  }
  parts.push(sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack

export interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string[];
}

export function parsePushBody(body: Buffer): { commands: PushCommandLine[]; pack: Buffer | null } {
  const commands: PushCommandLine[] = [];
  let offset = 0;
  let first = true;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated push command list');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('bad push pkt-line');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    let capabilities: string[] = [];
    if (first) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    first = false;
    const fields = line.split(' ');
    if (fields.length !== 3) throw new Error(`bad push command ${JSON.stringify(line)}`);
    commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string, capabilities });
  }
  const rest = body.subarray(offset);
  return { commands, pack: rest.length > 0 ? rest : null };
}

export interface PushOutcome {
  report: Buffer;
  unpackOk: boolean;
}

/** Apply a receive-pack request: store the pack, judge each ref, move the ok ones. */
export function receivePack(repo: Repo, commands: readonly PushCommandLine[], pack: Buffer | null): PushOutcome {
  let unpackOk = true;
  let unpackLine = 'unpack ok\n';
  if (pack !== null && pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.get(oid));
      for (const object of objects) {
        if (!repo.objects.has(object.oid)) repo.objects.set(object.oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    if (current !== command.oldOid) {
      fail(current === ZERO_OID || command.oldOid === ZERO_OID ? 'stale info' : 'non-fast-forward');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // delete
      if (!command.ref.startsWith('refs/')) {
        fail('invalid ref');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!isOid(command.newOid) || repo.get(command.newOid) === undefined) {
      fail('not our ref');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const oldCommit = repo.peelToCommit(command.oldOid);
      const newCommit = repo.peelToCommit(command.newOid);
      if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !repo.isAncestor(oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const lines: Buffer[] = [pkt(unpackLine)];
  for (const result of results) {
    lines.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  lines.push(PKT_FLUSH);
  const reportBody = Buffer.concat(lines);
  const sideband = commands[0]?.capabilities.includes('side-band-64k') ?? false;
  if (sideband) {
    const chunks: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < reportBody.length; offset += CHUNK) {
      chunks.push(pkt(Buffer.concat([Buffer.from([1]), reportBody.subarray(offset, offset + CHUNK)])));
    }
    chunks.push(PKT_FLUSH);
    return { report: Buffer.concat(chunks), unpackOk };
  }
  return { report: reportBody, unpackOk };
}

// ---------------------------------------------------------------------------
// upload-pack request parsing

export interface UploadRequest {
  command: 'ls-refs' | 'fetch';
  args: string[];
  capabilities: string[];
}

/** Parse a v2 upload-pack POST body into its command and argument lines. */
export function parseV2Request(body: Buffer): UploadRequest {
  const packets = parsePackets(body);
  let command = '';
  const args: string[] = [];
  const capabilities: string[] = [];
  let section: 'capability' | 'argument' = 'capability';
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 'argument';
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 'capability') {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      else capabilities.push(line);
    } else {
      args.push(line);
    }
  }
  if (command !== 'ls-refs' && command !== 'fetch') throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
  return { command, args, capabilities };
}

export function fetchRequestFromArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallowArgs: [], depth: null, done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallowArgs.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim());
    else if (arg === 'done') request.done = true;
  }
  return request;
}

/** Parse a v0 upload-pack POST body (two sections: wants, then haves). */
export function parseV0Fetch(body: Buffer): { request: FetchRequest; capabilities: Set<string> } {
  const packets = parsePackets(body);
  const request: FetchRequest = { wants: [], haves: [], shallowArgs: [], depth: null, done: false };
  const capabilities = new Set<string>();
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          for (const cap of line.slice(nul + 1).split(' ')) if (cap) capabilities.add(cap);
          line = line.slice(0, nul);
        }
        request.wants.push(line.slice(5).trim());
      } else if (line.startsWith('shallow ')) request.shallowArgs.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line === 'done') request.done = true;
    }
  }
  return { request, capabilities };
}

/** The commit list for GET /commits: newest first from a tip. */
export function listCommits(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (oid: string): void => {
    if (seen.has(oid)) return;
    const commit = repo.commitOf(oid);
    if (!commit) return;
    seen.add(oid);
    order.push(oid);
    for (const parent of commit.parents) visit(parent);
  };
  visit(tip);
  return order;
}

export { parseCommit, parseTag };
