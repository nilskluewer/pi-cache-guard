import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import { calculateCost } from "@earendil-works/pi-ai"
import { getSeedEstimate } from "./cache-learning.ts"

export type Retention = "short" | "long"

/** The last request that wrote or refreshed the provider prompt cache. */
export interface CacheHit {
  at: number
  provider: string
  model: string
  promptTokens: number
  /** The request reported cache reads or writes, so this route caches. */
  cached: boolean
}

export type CacheStatus =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "warm"; remainingMs: number; ttlMs: number }
  | { state: "cold"; expiredForMs?: number }

type Entry = { type: string; timestamp?: string; [key: string]: any }

/** Pi uses long retention only when PI_CACHE_RETENTION=long. */
export function getRetention(env: Record<string, string | undefined> = process.env): Retention {
  return env.PI_CACHE_RETENTION === "long" ? "long" : "short"
}

export function getTtlMs(model: Pick<Model<Api>, "promptCache">, retention: Retention): number | undefined {
  const seconds = model.promptCache?.[retention]
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000)
    ? seconds * 1000 : undefined
}

/** A declaration takes priority over route seeds. Neither one proves a cache hit. */
export function resolveTtlMs(
  model: Pick<Model<Api>, "provider" | "id" | "api" | "promptCache" | "compat">,
  retention: Retention,
  hit: Pick<CacheHit, "cached"> | undefined,
): number | undefined {
  if (!hit?.cached) return undefined
  return getTtlMs(model, retention) ?? getSeedEstimate(model, retention).ttlMs
}

export function promptTokens(usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite"> | undefined): number {
  if (!usage) return 0
  return (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
}

/**
 * Walks the branch backwards to the last request that touched the cache:
 * an assistant message or one of Pi's own cache_warm refreshes.
 * A compaction rewrites the prompt prefix, so no cache is known after it.
 */
export function findLastCacheHit(entries: readonly Entry[]): CacheHit | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.type === "compaction") return undefined
    if (entry.type === "usage" && entry.kind === "cache_warm") {
      const tokens = promptTokens(entry.usage)
      if (tokens > 0) {
        return { at: Date.parse(entry.timestamp ?? ""), provider: entry.provider, model: entry.model, promptTokens: tokens,
          cached: (entry.usage.cacheRead ?? 0) + (entry.usage.cacheWrite ?? 0) > 0 }
      }
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message
      const tokens = promptTokens(message.usage)
      // Failed requests report no usage and do not refresh the cache.
      if (tokens > 0) {
        // The message timestamp is the request start: the conservative TTL anchor.
        const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp ?? "")
        const cached = (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0) > 0
        return { at, provider: message.provider, model: message.model, promptTokens: tokens, cached }
      }
    }
  }
  return undefined
}

export function getCacheStatus(
  model: Pick<Model<Api>, "provider" | "id" | "api" | "promptCache">,
  hit: CacheHit | undefined,
  retention: Retention,
  now: number,
  estimatedTtlMs?: number,
): CacheStatus {
  const ttl = getTtlMs(model, retention) ?? estimatedTtlMs ?? resolveTtlMs(model, retention, hit)
  const implicitWrite = estimatedTtlMs !== undefined && model.api !== "anthropic-messages"
  if (ttl === undefined || !hit || (!hit.cached && !implicitWrite) || !Number.isFinite(hit.at)) return { state: "unknown" }
  // Prompt caches are per model: a model change always starts cold.
  if (hit.provider !== model.provider || hit.model !== model.id) return { state: "cold" }
  const remainingMs = hit.at + ttl - now
  return remainingMs > 0 ? { state: "warm", remainingMs, ttlMs: ttl } : { state: "cold", expiredForMs: Math.max(0, -remainingMs) }
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Price to send `tokens` of prompt without a cache hit, from Pi's model catalog. */
export function coldCost(model: Model<Api>, tokens: number, retention: Retention): number {
  const usage = emptyUsage()
  usage.totalTokens = tokens
  if (model.cost.cacheWrite > 0) {
    usage.cacheWrite = tokens
    if (retention === "long" && model.api === "anthropic-messages" && model.compat?.supportsLongCacheRetention !== false) usage.cacheWrite1h = tokens
  } else {
    // Implicit caches (OpenAI, Gemini) bill a miss as normal input.
    usage.input = tokens
  }
  return calculateCost(model, usage).total
}

/** Price to send `tokens` of prompt with a full cache hit. */
export function warmCost(model: Model<Api>, tokens: number): number {
  const usage = emptyUsage()
  usage.cacheRead = tokens
  usage.totalTokens = tokens
  return calculateCost(model, usage).total
}

/** Every scoped model, in scope order. Ineligible models stay visible with a reason. */
export function scopedModelOptions(
  scoped: readonly Model<Api>[],
  tokens: number,
  retention: Retention,
): { model: Model<Api>; cost: number; unavailable?: string }[] {
  return scoped.map((model) => ({
    model,
    cost: coldCost(model, tokens, retention),
    unavailable: model.contextWindow >= tokens ? undefined
      : `context too large for model: ~${formatTokens(tokens)} tokens, limit ${formatTokens(model.contextWindow)}`,
  }))
}

export function formatUsd(value: number): string {
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`
}

/** Parse a budget such as "0.5", "$0.50", "€1" or "0,25". Returns undefined when it is not a non-negative number. */
export function parseUsd(input: string): number | undefined {
  const text = input.trim().replace(/^[$€]\s*/, "").replace(/\s*[$€]$/, "").replace(",", ".")
  if (!/^\d*\.?\d+$|^\d+\.$/.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

export function formatAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}
