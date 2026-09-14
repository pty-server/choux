export type AppUpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "installing"; version: string; progress: number | undefined }
  | { phase: "failed"; version: string | undefined; message: string };

export interface AppUpdateState {
  readonly supported: boolean;
  readonly currentVersion: string | undefined;
  readonly status: AppUpdateStatus;
}

export function installableUpdateVersion(status: AppUpdateStatus): string | undefined {
  return status.phase === "available" || status.phase === "failed" ? status.version : undefined;
}

export function appUpdateButtonLabel(status: AppUpdateStatus): string | undefined {
  switch (status.phase) {
    case "available":
      return `Update to ${status.version}`;
    case "installing":
      return status.progress === undefined ? "Updating…" : `Updating ${Math.round(status.progress * 100)}%`;
    case "failed":
      return status.version === undefined ? undefined : "Retry update";
    default:
      return undefined;
  }
}

export function appUpdateStatusText(status: AppUpdateStatus): string {
  switch (status.phase) {
    case "idle":
      return "Checks for a new release on launch and every 12 hours.";
    case "checking":
      return "Checking for updates…";
    case "current":
      return "Choux is up to date.";
    case "available":
      return `Choux ${status.version} is available.`;
    case "installing":
      return `Installing Choux ${status.version}. It restarts when done.`;
    case "failed":
      return `Update failed: ${status.message}`;
  }
}
