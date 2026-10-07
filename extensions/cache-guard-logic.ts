import type { Api, Model, Usage } from "@earendil-works/pi-ai"
import { calculateCost } from "@earendil-works/pi-ai/models"

export type Retention = "short" | "long"

/** The last request that wrote or refreshed the provider prompt cache. */
export interface CacheHit {
  at: number
  provider: string
  model: string
  promptTokens: number
}

export type CacheStatus =
  | { state: "none" }
  | { state: "warm"; remainingMs: number }
  | { state: "cold"; expiredForMs?: number }

type Entry = { type: string; timestamp?: string; [key: string]: any }

/** Pi uses long retention only when PI_CACHE_RETENTION=long. */
export function getRetention(env: Record<string, string | undefined> = process.env): Retention {
  return env.PI_CACHE_RETENTION === "long" ? "long" : "short"
}

export function getTtlMs(model: Pick<Model<Api>, "promptCache">, retention: Retention): number | undefined {
  const seconds = model.promptCache?.[retention]
  return seconds && seconds > 0 ? seconds * 1000 : undefined
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
        return { at: Date.parse(entry.timestamp ?? ""), provider: entry.provider, model: entry.model, promptTokens: tokens }
      }
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const message = entry.message
      const tokens = promptTokens(message.usage)
      // Failed requests report no usage and do not refresh the cache.
      if (tokens > 0) {
        // The message timestamp is the request start: the conservative TTL anchor.
        const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp ?? "")
        return { at, provider: message.provider, model: message.model, promptTokens: tokens }
      }
    }
  }
  return undefined
}

export function getCacheStatus(
  model: Pick<Model<Api>, "provider" | "id" | "promptCache">,
  hit: CacheHit | undefined,
  retention: Retention,
  now: number,
): CacheStatus {
  const ttl = getTtlMs(model, retention)
  if (ttl === undefined || !hit || !Number.isFinite(hit.at)) return { state: "none" }
  // Prompt caches are per model: a model change always starts cold.
  if (hit.provider !== model.provider || hit.model !== model.id) return { state: "cold" }
  const remainingMs = hit.at + ttl - now
  return remainingMs > 0 ? { state: "warm", remainingMs } : { state: "cold", expiredForMs: -remainingMs }
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
    if (retention === "long") usage.cacheWrite1h = tokens
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

/**
 * Up to `limit` cheaper models of the same provider that fit the context,
 * one per price level: the closest cheaper levels plus always the cheapest.
 */
export function cheaperModels(
  current: Model<Api>,
  available: readonly Model<Api>[],
  tokens: number,
  retention: Retention,
  limit = 4,
): { model: Model<Api>; cost: number }[] {
  const currentCost = coldCost(current, tokens, retention)
  const byPrice = new Map<string, { model: Model<Api>; cost: number }>()
  for (const model of available) {
    if (model.provider !== current.provider || model.id === current.id) continue
    if (model.contextWindow < tokens) continue
    const cost = coldCost(model, tokens, retention)
    if (cost >= currentCost) continue
    const key = cost.toFixed(6)
    const previous = byPrice.get(key)
    // Within one price level, prefer the newest ID (catalog IDs sort by version).
    if (!previous || model.id > previous.model.id) byPrice.set(key, { model, cost })
  }
  const sorted = [...byPrice.values()].sort((a, b) => b.cost - a.cost)
  return sorted.length <= limit ? sorted : [...sorted.slice(0, limit - 1), sorted[sorted.length - 1]]
}

export function formatUsd(value: number): string {
  return value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`
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
