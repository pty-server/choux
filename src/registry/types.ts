// Type definitions only - no runes, no implementation. This module exists so
// both `kernel/**` (which implements the registry, see
// `../kernel/extensibility/registry.svelte.ts`) and `features/**` (which consume it) can
// import the same shapes without `features/**` importing from `kernel/**`.
// `apps/choux/eslint.config.js` blocks `features/**` -> `kernel/**` imports;
// this directory sits outside that boundary on purpose (CLIENT.md section 2).
import type { Component } from "svelte";
import type { ExecSessionRequest, ExecSessionResponse, ServerInfo, Session, Workspace } from "@pty-server/protocol";
import type { ServerConfig } from "../kernel/storage/serverConfigStore";

export interface Command {
  id: string;
  title: string;
  run: () => void;
}

// A single chrome slot entry (rail button, sidebar panel, status item, pane
// type). `component` is deliberately typed `unknown` for now - it's a
// placeholder ref to a Svelte component/snippet; the concrete typing is
// deferred to the milestone that actually renders these slots (CLIENT.md
// 13.2 - no pane-type plugin API or session decorators here).
export interface ChromeSlotItem {
  id: string;
  component: unknown;
  order?: number;
}

export interface SessionViewContext {
  session: Session;
  terminalTitle?: string;
  agentState?: AgentState;
}

/** Sub-rows under a session row, chosen by what is running in the session. */
export interface SessionViewItem {
  id: string;
  order?: number;
  /** Must stay pure and synchronous - it runs for every visible session on every poll. */
  detect: (context: SessionViewContext) => boolean;
  component: Component<{ session: Session; serverId: string; onFocusSession: () => void }>;
}

export interface KernelRegistry {
  registerCommand(command: Command): void;
  /** Needed by features whose command set changes at runtime (e.g. one command per session profile). */
  unregisterCommand(id: string): void;
  getCommand(id: string): Command | undefined;
  listCommands(): Command[];

  registerKeybinding(chord: string, commandId: string): void;
  resolveKeybinding(chord: string): Command | undefined;

  registerRailItem(item: ChromeSlotItem): void;
  registerSidebarItem(item: ChromeSlotItem): void;
  registerStatusItem(item: ChromeSlotItem): void;
  registerPaneType(item: ChromeSlotItem): void;

  registerSessionView(item: SessionViewItem): void;
  unregisterSessionView(id: string): void;
  /** First match in `order` wins. */
  resolveSessionView(context: SessionViewContext): SessionViewItem | undefined;

  readonly railItems: ChromeSlotItem[];
  readonly sidebarItems: ChromeSlotItem[];
  readonly statusItems: ChromeSlotItem[];
  readonly paneTypes: ChromeSlotItem[];
  readonly sessionViews: SessionViewItem[];
}

export type SessionDropPosition = "before" | "after";

export type ServerStatus = "connecting" | "online" | "offline" | "unauthorized" | "version-mismatch";

export interface ServerConn {
  readonly config: ServerConfig;
  readonly status: ServerStatus;
  /** Non-secret local credential-store failure, if one prevents connecting. */
  readonly storageError?: string;
  /** Non-secret explanation of the latest failed server request. */
  readonly connectionError?: string;
  readonly info: ServerInfo | undefined;
  readonly workspaces: Workspace[];
  readonly sessions: Session[];
  /** Latest terminal titles received from this server's global event stream. */
  readonly terminalTitles: Readonly<Record<string, string>>;
  readonly agentStates: Readonly<Record<string, AgentState>>;
}

export type AgentActivity = "idle" | "busy" | "tool" | "waiting" | "compacting";

export interface AgentState {
  readonly agent: string;
  readonly activity: AgentActivity;
  readonly sessionId: string;
  readonly pane?: string;
  readonly cwd?: string;
  readonly tool?: string;
  readonly detail?: string;
  readonly message?: string;
  readonly subagents: number;
  readonly updatedAt: number;
}

/** A Choux-supported `choux.question` request awaiting a local response. */
export interface PendingQuestion {
  readonly id: string;
  readonly serverId: string;
  readonly serverLabel: string;
  readonly sessionId: string;
  readonly sessionLabel: string;
  readonly title?: string;
  readonly message: string;
  readonly options: readonly QuestionOption[];
  /** Whether the dialog offers a free-text note. Requests omitting it get one. */
  readonly notes: boolean;
}

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type QuestionResponse =
  | { readonly answer: string; readonly note?: string }
  | { readonly cancelled: true; readonly note?: string };

export type QuestionResponseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export type AggregateServerStatus = "online" | "offline" | "degraded";

export interface ServerRegistry {
  readonly servers: ServerConn[];
  readonly defaultServerId: string | undefined;
  readonly aggregateStatus: AggregateServerStatus;
  /** Ordered globally so only one question dialog is ever visible. */
  readonly pendingQuestions: readonly PendingQuestion[];
  get(id: string): ServerConn | undefined;
  /** Hydrates from persisted config and (re)starts one controller per server. Safe to call more than once (e.g. after Settings changes a server's URL/token) - it tears down existing controllers first. */
  load(): Promise<void>;
  addServer(input: { url: string; transport?: "local"; instance?: string; label?: string; token?: string; accent?: string; auth?: "token" | "none"; serverId?: string }): Promise<ServerConn>;
  /** Adds a server only when its stable identity and normalized URL are both unknown. */
  ensureServer(input: { url: string; transport?: "local"; instance?: string; label?: string; token?: string; accent?: string; auth?: "token" | "none"; serverId?: string }): Promise<ServerConn>;
  /** Patches label/accent/url for an existing server; writes a new token only when `patch.token` is non-empty. Reconnects the controller when the url or token changed. */
  updateServer(id: string, patch: { label?: string; accent?: string; url?: string; token?: string; serverId?: string }): Promise<void>;
  removeServer(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  /** Forces an immediate poll for one server and resets its poll interval phase. */
  refresh(id: string): void;
  /** Rejects when the server advertises no `exec` capability, so callers must treat failure as "no data", not as an outage. */
  execSession(serverId: string, sessionId: string, body: ExecSessionRequest): Promise<ExecSessionResponse>;
  /** Drops pane-keyed agent state for panes that no longer exist. An empty list is a no-op so a failed `tmux` call never wipes state. */
  reconcileAgentPanes(serverId: string, panes: readonly string[]): void;
  /** Sends the correlated reply and removes the question when it was accepted locally. */
  answerQuestion(id: string, response: QuestionResponse): QuestionResponseResult;
}
