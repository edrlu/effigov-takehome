/** Thin typed wrappers over the case API. No cache: every read is live data. */

import type {
  Call,
  Case,
  CaseEvent,
  CasePatch,
  CaseStatus,
  Report,
  TokenResponse,
  Turn,
} from "./types";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * A sentence for the panel that will render this, never the wire body.
 *
 * FastAPI answers every failure with `{"detail": "case not found"}`, and
 * putting the response text on screen verbatim shows the reader a JSON blob
 * where an explanation belongs. Take the detail out; fall back to the status
 * line when the body is not the shape we expect.
 */
export async function errorMessage(response: Response): Promise<string> {
  const status = `${response.status} ${response.statusText}`.trim();
  const body = await response.text().catch(() => "");
  if (!body) return status;

  try {
    const parsed = JSON.parse(body);
    const detail = typeof parsed === "object" && parsed !== null ? parsed.detail : null;
    if (typeof detail === "string" && detail) return detail.slice(0, 200);
  } catch {
    // Not JSON. The raw text is the best we have, and it is already prose.
  }
  return body.slice(0, 200) || status;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch {
    throw new ApiError(`Cannot reach the case API at ${API_BASE}`, 0);
  }

  if (!response.ok) {
    throw new ApiError(await errorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  listCases(params: { q?: string; status?: CaseStatus | "all" } = {}) {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.status && params.status !== "all") search.set("status", params.status);
    const qs = search.toString();
    return request<Case[]>(`/api/cases${qs ? `?${qs}` : ""}`);
  },

  getCase(id: number) {
    return request<Case>(`/api/cases/${id}`);
  },

  updateCase(id: number, patch: CasePatch) {
    return request<Case>(`/api/cases/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  },

  addNote(id: number, note: string) {
    return request<Case>(`/api/cases/${id}/notes`, { method: "POST", body: JSON.stringify({ note }) });
  },

  caseEvents(id: number) {
    return request<CaseEvent[]>(`/api/cases/${id}/events`);
  },

  caseCalls(id: number) {
    return request<Call[]>(`/api/cases/${id}/calls`);
  },

  /** Reports are new; a backend that predates them answers 404, not an outage. */
  async caseReports(id: number): Promise<Report[] | null> {
    try {
      return await request<Report[]>(`/api/cases/${id}/reports`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  escalateCase(id: number, reason: string) {
    return request<Case>(`/api/cases/${id}/escalate`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },

  listCalls() {
    return request<Call[]>("/api/calls");
  },

  activeCalls() {
    return request<Call[]>("/api/calls/active");
  },

  getCall(id: number) {
    return request<Call>(`/api/calls/${id}`);
  },

  callTurns(id: number) {
    return request<Turn[]>(`/api/calls/${id}/turns`);
  },

  createToken(body: { room?: string; identity?: string } = {}) {
    return request<TokenResponse>("/api/token", { method: "POST", body: JSON.stringify(body) });
  },
};
