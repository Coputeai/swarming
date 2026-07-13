// Tiny dispatch client. Friendly errors, never a stack trace (BLUEPRINT §4.2).

import { API_BASE, BOARD_BASE } from "./config.ts";

export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Bearer key for authenticated endpoints (work/results/subscribe). Set once
// after loading identity; requests without it stay anonymous (register, reads).
let apiKey: string | null = null;
export function setApiKey(key: string | undefined | null): void {
  apiKey = key ?? null;
}

async function request(method: string, base: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "NETWORK",
      `could not reach the swarm at ${base} — it may be down or you may be offline. Your work is not lost; try again in a bit.`,
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
  get: (path: string) => request("GET", API_BASE, path),
  post: (path: string, body: unknown) => request("POST", API_BASE, path, body),
  // Board reads (leaderboard, profiles, badges) live at the domain root, not
  // under /api — see BOARD_BASE in config.ts.
  board: (path: string) => request("GET", BOARD_BASE, path),
};
