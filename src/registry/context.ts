// Svelte context glue for the kernel registry. The kernel/shell root calls
// `provideKernelRegistry` once, high in the component tree; features call
// `useKernelRegistry` to register commands/keybindings/chrome items without
// ever importing `kernel/**` directly (see `apps/choux/eslint.config.js`).
import { getContext, setContext } from "svelte";
import type { KernelRegistry, ServerRegistry } from "./types";

const registryKey = Symbol("kernel-registry");

export function provideKernelRegistry(registry: KernelRegistry): void {
  setContext(registryKey, registry);
}

export function useKernelRegistry(): KernelRegistry {
  const registry = getContext<KernelRegistry | undefined>(registryKey);
  if (!registry) {
    throw new Error(
      "useKernelRegistry() called outside the kernel's context tree - " +
        "an ancestor component must call provideKernelRegistry() first."
    );
  }
  return registry;
}

const serverRegistryKey = Symbol("server-registry");

export function provideServerRegistry(registry: ServerRegistry): void {
  setContext(serverRegistryKey, registry);
}

export function useServerRegistry(): ServerRegistry {
  const registry = getContext<ServerRegistry | undefined>(serverRegistryKey);
  if (!registry) {
    throw new Error(
      "useServerRegistry() called outside the kernel's context tree - " +
        "an ancestor component must call provideServerRegistry() first."
    );
  }
  return registry;
}
