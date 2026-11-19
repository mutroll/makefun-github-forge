// main.ts — the entry's life in the trial, in four moves:
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      register with, so the process exits 1 at once.
//   2. The forge server binds an ephemeral port (listen(0)); the env owns the
//      fixed ports, never this process.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N} tells the env where to dial.
//      The first register wins: a 409 means another process got there first
//      and this one simply keeps waiting. A 400 or 405 is a contract error
//      and ends the program; anything else is retried with backoff, since
//      the env may still be starting.
//   4. GET $MAKEFUN_ENV_URL/done is polled until it answers {"done": true};
//      only then does the server close and the process exit 0.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff after `attempt` failures: doubling from RETRY_FIRST_MS, capped. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(attempt));
  }
}

async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet, or a slow poll: either way, not done — poll again.
    }
    await pause(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  // The suite reuses connections across its checks and workloads (the read
  // workload is 2,000 requests on one keep-alive socket): a generous
  // keep-alive window keeps those sockets open instead of paying a fresh
  // TCP handshake whenever a phase pauses for a few seconds.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    // Backlog 511: the clone workload opens 50 connections at once, and a
    // shallow listen queue would refuse or retry some of that burst.
    server.listen(0, 511, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no port was bound'));
      else resolve(address.port);
    });
  });
  await register(port);
  await waitUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

void main();
