import type { SessionViewItem } from "../../registry/types";
import AgentBadge from "./AgentBadge.svelte";
import TmuxWindowList from "./TmuxWindowList.svelte";
import { detectAgent } from "./agentDetect";
import { isTmuxSession } from "./tmuxDetect";

export const sessionViews: SessionViewItem[] = [
  {
    id: "tmux",
    order: 10,
    detect: ({ session }) => isTmuxSession(session),
    component: TmuxWindowList,
  },
  {
    id: "agent",
    order: 20,
    detect: ({ session, agentState }) => agentState !== undefined || detectAgent(session) !== undefined,
    component: AgentBadge,
  },
];
