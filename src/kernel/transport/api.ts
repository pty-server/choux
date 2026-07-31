import type { DirectoryListing, ExecSessionRequest, ExecSessionResponse, ServerInfo, Session, Workspace } from "@pty-server/protocol";
import { localPtysRequest } from "./localPtys";

export interface ApiClientConfig {
  baseUrl: string;
  /** Selects the native control-socket transport for a local ptys instance. */
  localInstance?: string;
  /** Omitted only for a loopback server explicitly started with --no-auth. */
  token?: string;
  headers?: Record<string, string>;
}

export interface CreateSessionBody {
  workspaceId?: string;
  cmd?: string;
  args?: string[];
  env?: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
  followSize?: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** A safe, user-facing explanation for a failed HTTP connection attempt. */
export function describeConnectionFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Authentication failed (401 Unauthorized). Check the server token.";
    if (error.status === 403) return "The server rejected this client (403 Forbidden). Check its access or origin policy.";
    return `The server returned ${error.status}: ${error.message}.`;
  }
  if (error instanceof TypeError) {
    // Browsers intentionally make failed CORS requests indistinguishable from
    // connection failures. Local-daemon discovery adds a precise CORS message
    // when its pidfile exposes the allowed origins.
    return "The server is offline or unreachable, or the browser origin is blocked by CORS.";
  }
  return error instanceof Error && error.message ? error.message : "The connection failed for an unknown reason.";
}

export function createApiClient({ baseUrl, localInstance, token, headers = {} }: ApiClientConfig) {
  const base = baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = token === undefined ? {} : { Authorization: `Bearer ${token}` };

  async function throwForResponse(response: Response): Promise<never> {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: string };
      if (body && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // Body wasn't JSON (or was empty) - fall back to the status line.
    }
    throw new ApiError(message, response.status);
  }

  async function request<T>(path: string): Promise<T> {
    if (localInstance !== undefined) {
      const response = await localPtysRequest(localInstance, path, { headers });
      if (response.status < 200 || response.status >= 300) throw new ApiError(response.body || response.statusText, response.status);
      return JSON.parse(response.body) as T;
    }
    const response = await fetch(`${base}${path}`, {
      headers: { ...headers, ...authHeaders },
    });
    if (!response.ok) return throwForResponse(response);
    return response.json() as Promise<T>;
  }

  async function requestJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    if (localInstance !== undefined) {
      const response = await localPtysRequest(localInstance, path, {
        method,
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status < 200 || response.status >= 300) throw new ApiError(response.body || response.statusText, response.status);
      return JSON.parse(response.body) as T;
    }
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return throwForResponse(response);
    return response.json() as Promise<T>;
  }

  return {
    getInfo: () => request<ServerInfo>("/v1/info"),
    getWorkspaces: () => request<Workspace[]>("/v1/workspaces"),
    listDirectories: (path?: string, q?: string, cursor?: string) => {
      const params = new URLSearchParams();
      if (path !== undefined) params.set("path", path);
      if (q !== undefined) params.set("q", q);
      if (cursor !== undefined) params.set("cursor", cursor);
      return request<DirectoryListing>(`/v1/directories${params.size === 0 ? "" : `?${params}`}`);
    },
    getSessions: (workspaceId?: string) => request<Session[]>(
      `/v1/sessions${workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`}`,
    ),
    createWorkspace: (path: string) => requestJson<Workspace>("/v1/workspaces", { path }),
    createSession: (body: CreateSessionBody) => requestJson<Session>("/v1/sessions", body),
    updateSession: (id: string, name: string) => requestJson<Session>(`/v1/sessions/${encodeURIComponent(id)}`, { name }, "PATCH"),
    execSession: (id: string, body: ExecSessionRequest) => requestJson<ExecSessionResponse>(
      `/v1/sessions/${encodeURIComponent(id)}/exec`,
      body,
    ),
  };
}
