# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mutroll/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mutroll/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node process that serves a small but complete GitHub-compatible forge
from its own in-memory store, standard library only:

- **git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack`
  and `git-receive-pack`, protocol v0 and v2 (`ls-refs`, shallow fetch and
  deepen), packfiles read and written in-process, OFS/REF deltas resolved on
  receive.
- **REST v3** under `/api/v3` — repositories, contents, branches, commits,
  labels, issues, comments and pull requests with GitHub's shapes and status
  codes.
- **GraphQL** at `/api/graphql` — a small real executor (variables, aliases,
  fragments, input objects, cursor connections, Relay global ids, operation
  batching, introspection) over the same store.
- **MCP** at `/mcp` — streamable-HTTP JSON-RPC speaking both the
  `server/discover` era (2026-07-28) and the legacy `initialize` handshake,
  with `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` tools that act on the same
  objects REST sees.

Issues and pull requests share one number sequence per repository; pull
requests merge with real three-way squash semantics; every object the forge
creates is an ordinary git object in the same store clients push to.

## Layout

- `main.ts` — the trial lifecycle: bind an ephemeral port, register it with
  the env, serve until the env says done.
- `app.ts` — the HTTP server and the cross-surface rules (auth, JSON, ids).
- `store.ts` — the data model: object database, refs, issues, pulls, merges.
- `gitproto.ts` — pkt-lines, packfiles, advertisements, fetch planning, push.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — the GraphQL tokenizer, parser and executor.
- `mcp.ts` — the MCP endpoint and its tools.
- `web.ts` — the small HTTP vocabulary the surfaces share.

## Running

The platform runs `node main.ts` with `MAKEFUN_ENV_URL` set; the process
exits 1 without it. No dependencies, no build step: Node 22's type stripping
runs the TypeScript directly.
