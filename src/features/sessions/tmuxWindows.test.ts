import { describe, expect, it, vi } from "vitest";
import type { TmuxWindow } from "./tmuxParse";
import { loadTmuxWindowListing } from "./tmuxWindows";

function window(id: string, name: string): TmuxWindow {
  return { id, index: "0", name, active: true, command: "zsh", paneTitle: "" };
}

describe("loadTmuxWindowListing", () => {
  it("resolves the client session again before every window listing", async () => {
    let currentSession = "main";
    const resolveSession = vi.fn(async () => currentSession);
    const listWindows = vi.fn(async (session: string) => [window(`@${session}`, session)]);

    await expect(loadTmuxWindowListing(resolveSession, listWindows)).resolves.toEqual({
      session: "main",
      windows: [window("@main", "main")],
    });

    currentSession = "scratch";

    await expect(loadTmuxWindowListing(resolveSession, listWindows)).resolves.toEqual({
      session: "scratch",
      windows: [window("@scratch", "scratch")],
    });
    expect(resolveSession).toHaveBeenCalledTimes(2);
    expect(listWindows).toHaveBeenNthCalledWith(1, "main");
    expect(listWindows).toHaveBeenNthCalledWith(2, "scratch");
  });

  it("clears the listing when the tty no longer belongs to a tmux client", async () => {
    const listWindows = vi.fn();

    await expect(loadTmuxWindowListing(async () => undefined, listWindows)).resolves.toEqual({
      session: undefined,
      windows: [],
    });
    expect(listWindows).not.toHaveBeenCalled();
  });
});
