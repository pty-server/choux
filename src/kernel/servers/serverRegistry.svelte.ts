import { PROTOCOL_VERSION, type EventControl, type ExecSessionRequest, type ExecSessionResponse, type Session } from "@pty-server/protocol";
import { SvelteMap } from "svelte/reactivity";
import { ApiError, createApiClient, describeConnectionFailure } from "../transport/api";
import { EventStreamController } from "../transport/events";
import { localPtysSocket } from "../transport/localPtys";
import type { EventSocket, EventSocketFactory } from "../transport/events";
import { protocolMismatch } from "../transport/protocolVersion";
import {
  addServer as persistAddServer,
  deleteServer as persistDeleteServer,
  getDefaultServerId,
  getServer,
  listServers,
  setDefaultServerId,
  updateServer as persistUpdateServer,
  type ServerConfig,
  serverUsesToken,
} from "../storage/serverConfigStore";
import { tokenStore } from "../storage/tokenStore";
import { agentStateKey, agentStatePane } from "../../registry/agentStateKey";
import { isAgentStateData, reduceAgentState, sweepAgentStates } from "./agentState";
import type {
  PendingQuestion,
  QuestionOption,
  QuestionResponse,
  ServerConn,
  ServerRegistry,
} from "../../registry/types";

export const POLL_INTERVAL_MS = 5000;

function isEventData(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTitleEvent(value: unknown): value is { title: string } {
  return isEventData(value) && typeof value.title === "string";
}

function isRenameEvent(value: unknown): value is { name: string } {
  return isEventData(value) && typeof value.name === "string";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isEventData(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isExitedEvent(value: unknown): value is NonNullable<Session["exited"]> {
  return isEventData(value)
    && typeof value.code === "number"
    && typeof value.at === "number"
    && (value.signal === undefined || typeof value.signal === "number");
}

function isCreatedEvent(value: unknown): value is Session {
  return isEventData(value)
    && typeof value.id === "string"
    && typeof value.workspaceId === "string"
    && (value.name === undefined || typeof value.name === "string")
    && typeof value.cmd === "string"
    && Array.isArray(value.args)
    && value.args.every((arg) => typeof arg === "string")
    && isStringRecord(value.env)
    && typeof value.cols === "number"
    && Number.isInteger(value.cols)
    && value.cols > 0
    && typeof value.rows === "number"
    && Number.isInteger(value.rows)
    && value.rows > 0
    && (value.followSize === undefined || typeof value.followSize === "boolean")
    && typeof value.createdAt === "number"
    && (value.exited === undefined || isExitedEvent(value.exited));
}

interface QuestionData {
  title?: string;
  message: string;
  options: QuestionOption[];
  notes?: boolean;
}

function isQuestionData(value: unknown): value is QuestionData {
  if (!isEventData(value) || typeof value.message !== "string" || value.message.length === 0 || !Array.isArray(value.options) || value.options.length === 0) {
    return false;
  }
  if (value.title !== undefined && typeof value.title !== "string") return false;
  if (value.notes !== undefined && typeof value.notes !== "boolean") return false;

  const optionIds: string[] = [];
  return value.options.every((option) => {
    if (!isEventData(option) || typeof option.id !== "string" || option.id.length === 0 || typeof option.label !== "string" || option.label.length === 0) {
      return false;
    }
    if (option.description !== undefined && typeof option.description !== "string") return false;
    if (optionIds.includes(option.id)) return false;
    optionIds.push(option.id);
    return true;
  });
}

export interface ServerRegistryDeps {
  /** Defaults to createApiClient from ./api. Injectable for tests. */
  createClient?: (config: { baseUrl: string; token?: string; localInstance?: string }) => ReturnType<typeof createApiClient>;
  /** Defaults to the browser WebSocket constructor. Injectable for tests. */
  createEventSocket?: EventSocketFactory;
  questionsEnabled?: () => boolean;
  onAttention?: (target: AttentionTarget) => void;
  pollIntervalMs?: number;
}

export interface AttentionTarget {
  serverId: string;
  sessionId: string;
  pane?: string;
}

interface Controller {
  stop(): void;
  refresh(): void;
  exec(sessionId: string, body: ExecSessionRequest): Promise<ExecSessionResponse>;
}

type MutableServerConn = {
  -readonly [Key in keyof ServerConn]: ServerConn[Key];
};

export function createServerRegistry(deps: ServerRegistryDeps = {}): ServerRegistry {
  const conns = new SvelteMap<string, ServerConn>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Controller handles are non-reactive bookkeeping.
  const controllers = new Map<string, Controller>();
  const createClient = deps.createClient ?? createApiClient;
  const createEventSocket: EventSocketFactory | undefined = deps.createEventSocket ?? (
    typeof window === "undefined"
      ? undefined
      : ((url: string, protocols: string[]) => new WebSocket(url, protocols) as unknown as EventSocket)
  );
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const questionsEnabled = deps.questionsEnabled ?? (() => true);
  let pendingQuestions = $state<PendingQuestion[]>([]);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Local connection callbacks are non-reactive bookkeeping.
  const questionReplies = new Map<string, (response: QuestionResponse) => boolean>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Timer handles are non-reactive bookkeeping.
  const questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let defaultServerId = $state<string | undefined>(undefined);
  let loadGeneration = 0;

  const normalizedUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      parsed.pathname = "/";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return url;
    }
  };

  const removeQuestion = (id: string): void => {
    const timer = questionTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    questionTimers.delete(id);
    questionReplies.delete(id);
    pendingQuestions = pendingQuestions.filter((question) => question.id !== id);
  };

  const removeQuestionsForServer = (serverId: string): void => {
    for (const question of pendingQuestions) {
      if (question.serverId === serverId) removeQuestion(question.id);
    }
  };

  const removeQuestionsForSession = (serverId: string, sessionId: string): void => {
    for (const question of pendingQuestions) {
      if (question.serverId === serverId && question.sessionId === sessionId) removeQuestion(question.id);
    }
  };

  function startController(config: ServerConfig): void {
    const conn = $state<MutableServerConn>({
      config,
      status: "connecting",
      storageError: undefined,
      connectionError: undefined,
      info: undefined,
      workspaces: [],
      sessions: [],
      terminalTitles: {},
      agentStates: {},
    });
    conns.set(config.id, conn);

    let client: ReturnType<typeof createApiClient> | undefined;
    let inFlight = false;
    let stopped = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let eventStream: EventStreamController | undefined;
    let sessionEventRevision = 0;

    const sessionLabel = (sessionId: string): string => {
      const session = conn.sessions.find((candidate) => candidate.id === sessionId);
      return session?.name || (session ? [session.cmd, ...session.args].join(" ") : sessionId);
    };

    const waitingPane = (sessionId: string): string | undefined => {
      for (const [key, state] of Object.entries(conn.agentStates)) {
        if (state.sessionId === sessionId && state.activity === "waiting") return agentStatePane(key);
      }
      return undefined;
    };

    const notifyAttention = (sessionId: string, pane: string | undefined): void => {
      deps.onAttention?.({ serverId: config.id, sessionId, ...(pane === undefined ? {} : { pane }) });
    };

    const handleEvent = (frame: EventControl): void => {
      if (stopped) return;
      const event = frame.event;
      const requestId = frame.requestId;
      const ttl = frame.ttl;
      if (event.type === "choux.agent.state" && requestId === undefined && isAgentStateData(event.data)) {
        const key = agentStateKey(event.sessionId, event.data.pane);
        const previous = conn.agentStates[key];
        const next = reduceAgentState(previous, event.sessionId, event.data);
        if (next === previous) return;
        const states = { ...conn.agentStates };
        if (next === undefined) delete states[key];
        else states[key] = next;
        conn.agentStates = states;
        if (next?.activity === "waiting" && previous?.activity !== "waiting") {
          notifyAttention(event.sessionId, next.pane);
        }
        return;
      }
      if (event.type === "choux.question" && requestId !== undefined && ttl !== undefined && isQuestionData(event.data)) {
        if (!questionsEnabled()) {
          eventStream?.reply(requestId, { type: "choux.question.answer", data: { cancelled: true } });
          notifyAttention(event.sessionId, waitingPane(event.sessionId));
          return;
        }
        const id = `${config.id}:${requestId}`;
        if (pendingQuestions.some((question) => question.id === id)) return;
        const wasEmpty = pendingQuestions.length === 0;
        const question: PendingQuestion = {
          id,
          serverId: config.id,
          serverLabel: conn.config.label,
          sessionId: event.sessionId,
          sessionLabel: sessionLabel(event.sessionId),
          ...(event.data.title === undefined ? {} : { title: event.data.title }),
          message: event.data.message,
          options: event.data.options,
          notes: event.data.notes !== false,
        };
        pendingQuestions = [...pendingQuestions, question];
        // Questions are displayed one at a time. Do not ask for attention for a
        // later queued question while the user is already answering one.
        if (wasEmpty) notifyAttention(event.sessionId, waitingPane(event.sessionId));
        questionReplies.set(id, (response) => eventStream?.reply(requestId, {
          type: "choux.question.answer",
          data: response,
        }) ?? false);
        if (ttl > 0) {
          questionTimers.set(id, setTimeout(() => removeQuestion(id), ttl * 1000));
        }
        return;
      }
      if (event.type === "session.title" && isTitleEvent(event.data)) {
        const titles = { ...conn.terminalTitles };
        if (event.data.title) titles[event.sessionId] = event.data.title;
        else delete titles[event.sessionId];
        conn.terminalTitles = titles;
        return;
      }
      if (event.type === "session.created" && isCreatedEvent(event.data) && event.data.id === event.sessionId) {
        // Bound to a local: narrowing of `event.data` does not survive the
        // findIndex/map calls below.
        const created = event.data;
        sessionEventRevision += 1;
        const existingIndex = conn.sessions.findIndex((candidate) => candidate.id === event.sessionId);
        conn.sessions = existingIndex === -1
          ? [...conn.sessions, created]
          : conn.sessions.map((candidate) => candidate.id === event.sessionId ? created : candidate);
        return;
      }
      if (event.type === "session.exited" && isExitedEvent(event.data)) {
        const exited = event.data;
        removeQuestionsForSession(config.id, event.sessionId);
        const remaining = Object.entries(conn.agentStates).filter(([, state]) => state.sessionId !== event.sessionId);
        if (remaining.length !== Object.keys(conn.agentStates).length) conn.agentStates = Object.fromEntries(remaining);
        const session = conn.sessions.find((candidate) => candidate.id === event.sessionId);
        if (!session || session.exited?.at === exited.at) return;
        sessionEventRevision += 1;
        conn.sessions = conn.sessions.map((candidate) => (
          candidate.id === event.sessionId ? { ...candidate, exited } : candidate
        ));
        return;
      }
      if (event.type !== "session.updated" || !isRenameEvent(event.data)) return;
      const name = event.data.name;

      const session = conn.sessions.find((candidate) => candidate.id === event.sessionId);
      if (!session || session.name === name) return;
      sessionEventRevision += 1;
      conn.sessions = conn.sessions.map((candidate) => (
        candidate.id === event.sessionId ? { ...candidate, name } : candidate
      ));
    };

    const poll = async (): Promise<void> => {
      if (stopped || !client || inFlight) return;
      inFlight = true;
      const swept = sweepAgentStates(conn.agentStates, Date.now());
      if (swept !== undefined) conn.agentStates = swept;
      const eventRevisionAtStart = sessionEventRevision;
      try {
        const [sessions, workspaces, info] = await Promise.all([
          client.getSessions(),
          client.getWorkspaces(),
          client.getInfo(),
        ]);
        if (stopped) return;
        // A rename event can arrive while this request is in flight. Keep the
        // event-applied name until the next poll rather than restoring a
        // stale response for several seconds.
        if (sessionEventRevision === eventRevisionAtStart) conn.sessions = sessions;
        conn.workspaces = workspaces;
        conn.info = info;
        conn.status = protocolMismatch(PROTOCOL_VERSION, info.protocol) ? "version-mismatch" : "online";
        conn.connectionError = undefined;
        if (conn.config.serverId !== info.serverId) {
          const updated = await persistUpdateServer(config.id, { serverId: info.serverId });
          if (updated && !stopped) conn.config = updated;
        }
      } catch (err) {
        if (stopped) return;
        // A single dropped poll must not blank the UI's last-good data.
        conn.status = err instanceof ApiError && err.status === 401 ? "unauthorized" : "offline";
        conn.connectionError = describeConnectionFailure(err);
      } finally {
        inFlight = false;
      }
    };

    const restartInterval = (): void => {
      if (stopped || !client) return;
      interval = setInterval(() => {
        void poll();
      }, pollIntervalMs);
    };

    const controller: Controller = {
      stop() {
        stopped = true;
        removeQuestionsForServer(config.id);
        eventStream?.close();
        eventStream = undefined;
        if (interval !== undefined) {
          clearInterval(interval);
          interval = undefined;
        }
      },
      refresh() {
        if (stopped || !client) return;
        if (interval !== undefined) {
          clearInterval(interval);
          interval = undefined;
        }
        void poll();
        restartInterval();
      },
      exec(sessionId, body) {
        if (stopped || !client) return Promise.reject(new Error("server is not connected"));
        return client.execSession(sessionId, body);
      },
    };
    controllers.set(config.id, controller);

    void (async () => {
      let token: string | undefined;
      if (serverUsesToken(config)) {
        try {
          token = await tokenStore.get(config.tokenRef);
        } catch (err) {
          if (!stopped) {
            conn.status = "unauthorized";
            conn.storageError = err instanceof Error ? err.message : "Native token storage is unavailable.";
          }
          return;
        }
      }
      if (stopped) return;
      if (serverUsesToken(config) && !token) {
        conn.status = "unauthorized";
        return;
      }
      conn.storageError = undefined;
      client = createClient({ baseUrl: config.url, token, ...(config.transport === "local" && config.instance ? { localInstance: config.instance } : {}) });
      if (config.transport === "local" && config.instance) {
        eventStream = new EventStreamController({
          baseUrl: config.url,
          createSocket: (url, protocols) => {
            const target = new URL(url);
            return localPtysSocket(config.instance!, `${target.pathname}${target.search}`, protocols);
          },
          onEvent: handleEvent,
        });
      } else if (createEventSocket !== undefined) {
        eventStream = new EventStreamController({
          baseUrl: config.url,
          token,
          createSocket: createEventSocket,
          onEvent: handleEvent,
        });
      }
      await poll();
      if (stopped) return;
      restartInterval();
    })();
  }

  return {
    get servers() {
      return [...conns.values()];
    },
    get defaultServerId() {
      return defaultServerId;
    },
    get aggregateStatus() {
      const servers = [...conns.values()];
      if (servers.length === 0) return "offline";
      if (servers.every((conn) => conn.status === "online")) return "online";
      if (servers.every((conn) => conn.status === "offline" || conn.status === "unauthorized")) return "offline";
      return "degraded";
    },
    get pendingQuestions() {
      return pendingQuestions;
    },
    get(id) {
      return conns.get(id);
    },
    async load() {
      const generation = ++loadGeneration;
      for (const controller of controllers.values()) controller.stop();
      controllers.clear();
      conns.clear();

      const [configs, storedDefault] = await Promise.all([listServers(), getDefaultServerId()]);
      if (generation !== loadGeneration) return;
      for (const config of configs) startController(config);
      defaultServerId = configs.some((config) => config.id === storedDefault) ? storedDefault : configs[0]?.id;
    },
    async addServer(input) {
      const config = await persistAddServer(input);
      startController(config);
      if (defaultServerId === undefined) {
        defaultServerId = config.id;
        await setDefaultServerId(config.id);
      }
      return conns.get(config.id)!;
    },
    async ensureServer(input) {
      const known = [...conns.values()].find((conn) =>
        (input.serverId !== undefined && conn.config.serverId === input.serverId)
        || (input.transport === "local" && conn.config.transport === "local" && conn.config.instance === input.instance)
        || (input.transport !== "local" && normalizedUrl(conn.config.url) === normalizedUrl(input.url)),
      );
      if (known) {
        controllers.get(known.config.id)?.refresh();
        return known;
      }
      return this.addServer(input);
    },
    async updateServer(id, patch) {
      const existing = await getServer(id);
      if (!existing) return;
      await persistUpdateServer(id, patch);
      const updatedConfig = await getServer(id);
      if (!updatedConfig) return;
      const reconnect = patch.url !== undefined || Boolean(patch.token);
      if (reconnect) {
        controllers.get(id)?.stop();
        controllers.delete(id);
        conns.delete(id);
        startController(updatedConfig);
      } else {
        const conn = conns.get(id) as MutableServerConn | undefined;
        if (conn) conn.config = updatedConfig;
      }
    },
    async removeServer(id) {
      controllers.get(id)?.stop();
      controllers.delete(id);
      conns.delete(id);
      await persistDeleteServer(id);
      if (defaultServerId === id) {
        defaultServerId = conns.keys().next().value;
        if (defaultServerId !== undefined) await setDefaultServerId(defaultServerId);
      }
    },
    async setDefault(id) {
      defaultServerId = id;
      await setDefaultServerId(id);
    },
    refresh(id) {
      controllers.get(id)?.refresh();
    },
    reconcileAgentPanes(serverId, panes) {
      const conn = conns.get(serverId) as MutableServerConn | undefined;
      if (conn === undefined || panes.length === 0) return;
      const kept = Object.entries(conn.agentStates).filter(([key]) => {
        const pane = agentStatePane(key);
        return pane === undefined || panes.includes(pane);
      });
      if (kept.length !== Object.keys(conn.agentStates).length) conn.agentStates = Object.fromEntries(kept);
    },
    execSession(serverId, sessionId, body) {
      const controller = controllers.get(serverId);
      if (controller === undefined) return Promise.reject(new Error("unknown server"));
      return controller.exec(sessionId, body);
    },
    answerQuestion(id, response) {
      const question = pendingQuestions.find((candidate) => candidate.id === id);
      const reply = questionReplies.get(id);
      if (!question || !reply) return { ok: false, error: "This question is no longer available." };
      if (!reply(response)) return { ok: false, error: "Unable to send the answer. Reconnect to the server and try again." };
      removeQuestion(id);
      return { ok: true };
    },
  };
}
