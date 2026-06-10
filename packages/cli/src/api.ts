// Tiny dispatch client. Friendly errors, never a stack trace (BLUEPRINT §4.2).

import { API_BASE } from "./config.ts";

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "NETWORK",
      `could not reach the swarm at ${API_BASE} — it may be down or you may be offline. Your work is not lost; try again in a bit.`,
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const e = (json?.error ?? {}) as { code?: string; message?: string };
    throw new ApiError(e.code ?? `HTTP_${res.status}`, e.message ?? `request failed (${res.status})`);
  }
  return json;
}

export const api = {
  get: (path: string) => request("GET", path),
  post: (path: string, body: unknown) => request("POST", path, body),
};
