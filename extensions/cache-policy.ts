import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { CacheEstimate } from "./cache-learning.ts"
import { getTtlMs, type Retention } from "./cache-guard-logic.ts"

type CacheModel = Parameters<typeof getTtlMs>[0]

/** Observations remain independent evidence; they never replace a declared tier. */
export function cacheLifetime(model: CacheModel, retention: Retention, observed: CacheEstimate) {
  const declared = getTtlMs(model, retention)
  return {
    ...observed,
    ttlMs: declared ?? observed.ttlMs,
    source: declared !== undefined ? "declared" as const : observed.source,
    observedTtlMs: observed.ttlMs,
  }
}

type WarmingMode = "off" | "streaming" | "idle" | "unknown"
const mode = (value: unknown): WarmingMode => value === undefined ? "streaming"
  : value === "off" || value === "streaming" || value === "idle" ? value : "unknown"

/** Pi's warming mode is global-only, but getSettings() includes project overrides.
 * Prefer the global file when present. SDK hosts without that file use their
 * supplied settings. Unreadable/invalid settings must not authorize extra spending.
 */
export function nativeWarmingMode(agentDir: string, settings: { cacheWarming?: unknown }): WarmingMode {
  try {
    const global = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
    if (!global || typeof global !== "object" || Array.isArray(global)) return "unknown"
    return mode(global.cacheWarming)
  } catch (error: any) {
    return error.code === "ENOENT" ? mode(settings.cacheWarming) : "unknown"
  }
}

/** Idle mode owns background cache work, even if its economics or safety gates stop it.
 * We cannot inspect native warmer status through ExtensionContext, so do not copy
 * Pi's scheduler or force a warm/stop decision. Streaming warming ends before idle.
 */
export function handoffPauseReason(mode: WarmingMode): string | undefined {
  return mode === "idle" ? "paused: Pi native idle cache warming is enabled"
    : mode === "unknown" ? "paused: Pi cache-warming settings are unavailable" : undefined
}
