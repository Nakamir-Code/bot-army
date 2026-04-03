/**
 * Backend registry — exports all available coding agent backends.
 *
 * To add a new backend:
 * 1. Create src/backends/<name>/backend.ts exporting a BackendDef
 * 2. Import and register it in BACKENDS below
 * 3. Add the name to CliBackend in src/types.ts
 *    (Record<CliBackend, BackendDef> ensures they stay in sync at compile time)
 */

import type { CliBackend, ModelPreset, Config } from "../types.js";
import type { BackendDef } from "./types.js";
import claude from "./claude/backend.js";
import copilot from "./copilot/backend.js";

export type { BackendDef, SpawnOpts } from "./types.js";
export { ROLE_PROMPT, resolveFromPath, getBunPath, resolveHome, shortenHome } from "./types.js";

const BACKENDS: Record<CliBackend, BackendDef> = {
  claude,
  copilot,
};

/** Backend choices for command dropdowns / CLI help — generated from registry */
export function getBackendChoices(): Array<{ name: string; value: string }> {
  return Object.entries(BACKENDS).map(([key, def]) => ({ name: def.label, value: key }));
}

export function getBackendDef(backend: CliBackend): BackendDef {
  const def = BACKENDS[backend];
  if (!def) throw new Error(`Unknown backend: "${backend}". Available: ${Object.keys(BACKENDS).join(", ")}`);
  return def;
}

export function getModelPresets(config: Config): ModelPreset[] {
  // Merge presets from ALL backends so the dropdown works regardless of per-bot backend
  const byId = new Map<string, ModelPreset>();
  for (const def of Object.values(BACKENDS)) {
    for (const p of def.modelPresets) byId.set(p.id, p);
  }
  for (const p of config.model_presets ?? []) byId.set(p.id, p);
  return [...byId.values()];
}

export function buildCliInvocation(
  backend: CliBackend,
  opts: import("./types.js").SpawnOpts,
): { command: string; args: string[] } {
  const def = getBackendDef(backend);
  const command = def.resolveCommand();
  const args = def.buildArgs(opts);
  return { command, args };
}
