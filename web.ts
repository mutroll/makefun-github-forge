// web.ts — the tiny HTTP vocabulary the surface modules share.

export interface HttpRequest {
  method: string;
  /** Decoded path, no query string. */
  path: string;
  query: URLSearchParams;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
  /** The request's Host header, for building absolute Link URLs. */
  host: string;
}

export interface HttpResponse {
  status: number;
  contentType: string;
  body: Buffer | string;
  headers?: Record<string, string>;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

export function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, contentType: JSON_TYPE, body: `${JSON.stringify(value)}\n`, headers };
}

export function jsonError(status: number, message: string): HttpResponse {
  return json(status, { message });
}

/** Parse a JSON request body; { ok: false } when it is not valid JSON. */
export function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function optStr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function intParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
