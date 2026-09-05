import { serverUsesToken, type ServerConfig } from "../storage/serverConfigStore";

export interface ResolvedCredential {
  key: string;
  token: string | undefined;
}

export function credentialKey(config: ServerConfig): string {
  return `${config.id} ${config.tokenRef}`;
}

export function credentialFor(
  credential: ResolvedCredential | undefined,
  config: ServerConfig | undefined,
): string | undefined {
  if (config === undefined || credential === undefined) return undefined;
  return credential.key === credentialKey(config) ? credential.token : undefined;
}

export function canAttach(
  credential: ResolvedCredential | undefined,
  config: ServerConfig | undefined,
): boolean {
  if (config === undefined) return false;
  if (!serverUsesToken(config)) return true;
  return credentialFor(credential, config) !== undefined;
}
