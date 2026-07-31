import type { TmuxWindow } from "./tmuxParse";

export interface TmuxWindowListing {
  session: string | undefined;
  windows: TmuxWindow[];
}

export async function loadTmuxWindowListing(
  resolveSession: () => Promise<string | undefined>,
  listWindows: (session: string) => Promise<TmuxWindow[] | undefined>,
): Promise<TmuxWindowListing> {
  const session = await resolveSession();
  if (session === undefined) return { session, windows: [] };
  return { session, windows: await listWindows(session) ?? [] };
}
