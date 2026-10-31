import { createHmac, randomBytes } from "node:crypto"
import { constants, openSync, closeSync, readFileSync, writeFileSync, fstatSync, renameSync, unlinkSync, lstatSync, mkdirSync } from "node:fs"
import { join, resolve, parse } from "node:path"

export type CacheModel = { provider: string; id: string; api: string; baseUrl?: string; compat?: { supportsLongCacheRetention?: boolean } }
type Retention = "short" | "long"
export type CacheEstimate = {
  ttlMs?: number
  source: "measured" | "family" | "learned" | "unknown"
  lastHitAfterMs?: number
  variable?: boolean
  maxHitAfterMs?: number
  earlyMisses?: number
  unobservedWrites?: boolean
}
const MINUTE = 60_000, BUCKET = 5 * MINUTE, LIMIT = 256, IMPLICIT_READ_MIN = 64
export const OBSERVATION_RETENTION_MS = 30 * 24 * 60 * MINUTE
const routes: Record<string, string> = {
  "claude-opus-5.5": "anthropic-messages", "claude-sonnet-5.5": "anthropic-messages", "claude-haiku-5.5": "anthropic-messages",
  "gpt-6.1-sol": "openai-responses", "gpt-6-luna": "openai-responses",
  "gemini-3.8-flash": "openai-completions", "gemini-4-argon": "openai-completions",
}
const providerRoutes: Record<string, Record<string, string>> = {
  "github-copilot": routes,
  anthropic: {
    "claude-opus-5-5": "anthropic-messages", "claude-sonnet-5-5": "anthropic-messages", "claude-haiku-5-5": "anthropic-messages",
  },
  "openai-codex": { "gpt-6.1-sol": "openai-codex-responses", "gpt-6-luna": "openai-codex-responses" },
  openai: { "gpt-6.1-sol": "openai-responses", "gpt-6-luna": "openai-responses" },
}
export function isSupportedCacheModel(model: CacheModel): boolean {
  if (!model || !Object.hasOwn(providerRoutes, model.provider)) return false
  const allowed = providerRoutes[model.provider]
  return Object.hasOwn(allowed, model.id) && allowed[model.id] === model.api
}
export function getSeedEstimate(model: CacheModel, retention: Retention): CacheEstimate {
  if (!isSupportedCacheModel(model)) return { source: "unknown" }
  if (model.api === "anthropic-messages") return {
    ttlMs: retention === "long" && model.compat?.supportsLongCacheRetention !== false ? 60 * MINUTE : BUCKET,
    source: model.provider !== "github-copilot" || model.id === "claude-opus-5.5" ? "family" : "measured",
  }
  if (model.id === "gpt-6.1-sol") return { ttlMs: 30 * MINUTE, source: model.provider === "github-copilot" ? "measured" : "family" }
  // Conservative seed: reproduced hits at 15 min and misses at 18.5 min.
  if (model.id === "gemini-4-argon") return { ttlMs: 15 * MINUTE, source: "measured" }
  return model.id === "gemini-3.8-flash" ? { source: "unknown", variable: true } : { source: "unknown" }
}
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const token = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
const digest = (salt: string, value: unknown) => createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex")

// Only these raw numeric counters cross the observer boundary. Snapshots replace,
// never sum: Anthropic message_delta is cumulative, not an increment.
type Counters = { read?: number; write?: number; input?: number; conflict?: boolean }
function counters(api: string, usage: unknown): Counters {
  if (!object(usage)) return {}
  const details = api === "openai-responses" || api === "openai-codex-responses" ? usage.input_tokens_details : usage.prompt_tokens_details
  const reads = (api === "anthropic-messages" ? [usage.cache_read_input_tokens]
    : [details?.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens]).filter(count)
  const write = api === "anthropic-messages" ? usage.cache_creation_input_tokens : details?.cache_write_tokens
  const input = [usage.input_tokens, usage.prompt_tokens].find(count)
  return { ...(reads.length ? { read: Math.max(...reads) } : {}), ...(count(write) ? { write } : {}),
    ...(count(input) ? { input } : {}), ...(new Set(reads).size > 1 ? { conflict: true } : {}) }
}

type Prefix = { settings: string; affinity: string; parts: string[] }
function fingerprint(payload: unknown, salt: string): Prefix | undefined {
  if (!object(payload)) return
  let nodes = 0
  const controls: unknown[] = []
  function clean(value: any, depth = 0): any {
    if (++nodes > 40_000 || depth > 40) throw new Error("payload too large")
    if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value
    if (Array.isArray(value)) return value.map(v => clean(v, depth + 1))
    if (!object(value)) throw new Error("non-JSON payload")
    const result: Record<string, any> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      if (key === "cache_control") { controls.push(value[key]); continue }
      result[key] = clean(value[key], depth + 1)
    }
    return result
  }
  try {
    const p = clean(payload)
    if (JSON.stringify(p).length > 4_000_000) return
    const input = p.messages ?? p.input
    const messages = typeof input === "string" ? [input] : input
    if (!Array.isArray(messages) || !messages.length || messages.length > 4096) return
    const settings = { ...p }
    for (const field of ["tools", "system", "messages", "instructions", "input"]) delete settings[field]
    // Session/account affinity must match within a trial, but cannot prevent
    // aggregate learning from independent sessions with otherwise equal settings.
    const affinity: Record<string, unknown> = {}
    for (const field of ["prompt_cache_key", "user", "metadata", "safety_identifier", "previous_response_id"]) {
      if (Object.hasOwn(settings, field)) affinity[field] = settings[field]
      delete settings[field]
    }
    // Cache controls affect retention but are not part of the prompt prefix.
    settings.cacheControls = [...new Set(controls.map(v => JSON.stringify(v)))].sort()
    let chain = digest(salt, [p.tools ?? null, p.system ?? null, p.instructions ?? null])
    const parts = [chain]
    for (const message of messages) { chain = digest(salt, [chain, message]); parts.push(chain) }
    return { settings: digest(salt, settings), affinity: digest(salt, affinity), parts }
  } catch { return }
}

type RecordEntry = {
  v: 1; profile: string; route: string; provider?: string; model: string; api: string; retention: Retention; long: boolean;
  at: number; outcome: "hit" | "miss" | "unknown"; read?: number; write?: number;
  elapsed?: number; qualified: boolean; substantial: boolean;
}
type Anchor = { profile: string; affinity: string; at: number; parts: string[]; cacheable: number; writeKnown: boolean }
type Request = { model: CacheModel; retention: Retention; at: number; prefix?: Prefix; profile: string; usage: Counters; previous?: Anchor }

function validRecord(r: any): r is RecordEntry {
  return object(r) && Object.keys(r).every(k => ["v", "profile", "route", "provider", "model", "api", "retention", "long", "at", "outcome", "read", "write", "elapsed", "qualified", "substantial"].includes(k))
    && r.v === 1 && token(r.profile) && token(r.route) && isSupportedCacheModel({ provider: r.provider ?? "github-copilot", id: r.model, api: r.api })
    && ["short", "long"].includes(r.retention) && typeof r.long === "boolean" && count(r.at)
    && ["hit", "miss", "unknown"].includes(r.outcome) && typeof r.qualified === "boolean" && typeof r.substantial === "boolean"
    && [r.read, r.write, r.elapsed].every(v => v === undefined || count(v))
    && (r.outcome === "hit" ? count(r.read) && r.read > 0 : r.outcome === "miss" ? r.read === 0 : r.read === undefined)
    && (!r.qualified || (count(r.elapsed) && r.outcome !== "unknown"))
}
function modelFor(r: RecordEntry): CacheModel {
  return { provider: r.provider ?? "github-copilot", id: r.model, api: r.api, compat: { supportsLongCacheRetention: r.long } }
}
type SavedEstimate = CacheEstimate & { profile: string; route: string; at?: number }
function savedEstimate(value: any): SavedEstimate | undefined {
  if (!object(value) || !token(value.profile) || !token(value.route)
    || !["measured", "family", "learned", "unknown"].includes(value.source)
    || (value.ttlMs !== undefined && (!count(value.ttlMs) || value.ttlMs <= 0 || value.ttlMs > 24 * 60 * MINUTE || value.ttlMs % BUCKET !== 0))
    || (value.lastHitAfterMs !== undefined && !count(value.lastHitAfterMs))
    || (value.maxHitAfterMs !== undefined && !count(value.maxHitAfterMs))
    || (value.earlyMisses !== undefined && (!count(value.earlyMisses) || value.earlyMisses <= 0))
    || (value.unobservedWrites !== undefined && typeof value.unobservedWrites !== "boolean")
    || (value.at !== undefined && !count(value.at))
    || (value.variable !== undefined && typeof value.variable !== "boolean")) return
  return { profile: value.profile, route: value.route, source: value.source,
    ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
    ...(value.lastHitAfterMs !== undefined ? { lastHitAfterMs: value.lastHitAfterMs } : {}),
    ...(value.maxHitAfterMs !== undefined ? { maxHitAfterMs: value.maxHitAfterMs } : {}),
    ...(value.earlyMisses !== undefined ? { earlyMisses: value.earlyMisses } : {}),
    ...(value.unobservedWrites !== undefined ? { unobservedWrites: value.unobservedWrites } : {}),
    ...(value.at !== undefined ? { at: value.at } : {}),
    ...(value.variable !== undefined ? { variable: value.variable } : {}) }
}
function asEstimate(value?: SavedEstimate): CacheEstimate | undefined {
  if (!value) return
  return { source: value.source,
    ...(value.ttlMs !== undefined ? { ttlMs: value.ttlMs } : {}),
    ...(value.lastHitAfterMs !== undefined ? { lastHitAfterMs: value.lastHitAfterMs } : {}),
    ...(value.maxHitAfterMs !== undefined ? { maxHitAfterMs: value.maxHitAfterMs } : {}),
    ...(value.earlyMisses !== undefined ? { earlyMisses: value.earlyMisses } : {}),
    ...(value.unobservedWrites !== undefined ? { unobservedWrites: value.unobservedWrites } : {}),
    ...(value.variable !== undefined ? { variable: value.variable } : {}) }
}
function retentionCutoff(records: RecordEntry[], saved?: Iterable<SavedEstimate>, referenceAt?: number): number | undefined {
  let maxAt = referenceAt && count(referenceAt) ? referenceAt : 0
  for (const r of records) if (r.at > maxAt) maxAt = r.at
  if (saved) for (const s of saved) if (s.at !== undefined && s.at > maxAt) maxAt = s.at
  return maxAt >= OBSERVATION_RETENTION_MS ? maxAt - OBSERVATION_RETENTION_MS : undefined
}
function derive(records: RecordEntry[], model: CacheModel, retention: Retention, previous?: CacheEstimate): CacheEstimate {
  const baseSeed = getSeedEstimate(model, retention)
  // Logs rotate; a busy session must not erase a previously learned window.
  const seed: CacheEstimate = previous?.source === "learned" && previous.ttlMs !== undefined
    ? previous : previous?.variable && previous.ttlMs === undefined && baseSeed.ttlMs === undefined
    ? { source: "unknown", variable: true } : baseSeed
  const hits = records.filter(r => r.qualified && r.substantial && r.outcome === "hit")
  const misses = records.filter(r => r.qualified && r.outcome === "miss")
  const lastHitAfterMs = hits.at(-1)?.elapsed ?? previous?.lastHitAfterMs
  const hitMax = hits.length ? Math.max(...hits.map(h => h.elapsed!)) : undefined
  const maxHitAfterMs = hitMax !== undefined ? Math.max(hitMax, previous?.maxHitAfterMs ?? 0) : previous?.maxHitAfterMs
  const earlyMisses = maxHitAfterMs !== undefined
    ? misses.filter(m => m.elapsed! <= maxHitAfterMs).length || previous?.earlyMisses
    : previous?.earlyMisses
  const writeObserved = records.some(r => (r.write ?? 0) > 0)
  const unobservedWrites = (misses.length > 0 && !writeObserved) || (!records.length && !!previous?.unobservedWrites)
  const hitBuckets = new Map<number, number>()
  for (const h of hits) {
    const bucket = Math.max(BUCKET, Math.ceil(h.elapsed! / BUCKET) * BUCKET)
    hitBuckets.set(bucket, (hitBuckets.get(bucket) ?? 0) + 1)
  }
  const missBuckets = new Map<number, number>()
  for (const m of misses) {
    const bucket = Math.max(BUCKET, Math.ceil(m.elapsed! / BUCKET) * BUCKET)
    missBuckets.set(bucket, (missBuckets.get(bucket) ?? 0) + 1)
  }
  // A bucket is hit-supported when >= 3 substantial hits exist and outnumber misses in that bucket at least 2:1.
  const supported = [...hitBuckets]
    .filter(([b, n]) => n >= 3 && n >= (missBuckets.get(b) ?? 0) * 2)
    .map(([b]) => b)
    .sort((a, b) => b - a)
  const promoted = supported[0]
  const maxHitBucket = maxHitAfterMs !== undefined ? Math.max(BUCKET, Math.ceil(maxHitAfterMs / BUCKET) * BUCKET) : undefined
  const hasEarlyMiss = hits.some(h => misses.some(m => m.elapsed! <= h.elapsed!))

  // Without a hit-supported bucket or a known seed (or when unexplained misses reach 3 without hit support),
  // a shorter miss alongside a longer hit cannot establish a stable TTL.
  if (hasEarlyMiss && promoted === undefined && (seed.ttlMs === undefined || misses.length >= 3)) {
    return {
      source: "unknown",
      variable: true,
      ...(lastHitAfterMs !== undefined ? { lastHitAfterMs } : {}),
      ...(maxHitAfterMs !== undefined ? { maxHitAfterMs } : {}),
      ...(earlyMisses ? { earlyMisses } : {}),
      ...(unobservedWrites ? { unobservedWrites: true } : {}),
    }
  }

  let ttl = seed.ttlMs
  if (promoted !== undefined && (ttl === undefined || promoted > ttl)) ttl = promoted

  // Three misses in buckets above the hit-supported horizon lower an earlier window,
  // or converge a higher static seed down to the observed hit horizon.
  const nonSupportedMisses = misses.filter(m => {
    const b = Math.max(BUCKET, Math.ceil(m.elapsed! / BUCKET) * BUCKET)
    return !supported.includes(b)
  })
  const sortedMissWindows = [...new Set(nonSupportedMisses.map(m => Math.max(BUCKET, Math.ceil(m.elapsed! / BUCKET) * BUCKET)))].sort((a, b) => a - b)
  for (const window of sortedMissWindows) {
    if (nonSupportedMisses.filter(m => m.elapsed! <= window).length >= 3) {
      const floor = promoted !== undefined ? Math.max(promoted, maxHitBucket ?? promoted) : 0
      const lower = Math.max(floor, window - BUCKET)
      if (ttl !== undefined && lower < ttl) ttl = lower || undefined
      break
    }
  }
  if (promoted !== undefined && misses.length >= 3 && maxHitBucket !== undefined && ttl !== undefined && maxHitBucket < ttl) {
    ttl = Math.max(promoted, maxHitBucket)
  }

  const telemetryExtras = (misses.length > 0 || (ttl === undefined && hits.length >= 2 && lastHitAfterMs !== undefined && maxHitAfterMs !== undefined && maxHitAfterMs > lastHitAfterMs))
    ? {
        ...(maxHitAfterMs !== undefined ? { maxHitAfterMs } : {}),
        ...(earlyMisses ? { earlyMisses } : {}),
        ...(unobservedWrites ? { unobservedWrites: true } : {}),
      }
    : {}
  const baseResult: CacheEstimate = {
    ...seed,
    ...(lastHitAfterMs !== undefined ? { lastHitAfterMs } : {}),
    ...telemetryExtras,
  }
  return ttl !== seed.ttlMs
    ? { ...baseResult, ttlMs: ttl, source: ttl === undefined ? "unknown" : "learned", ...(ttl !== undefined && baseResult.variable ? { variable: false } : {}) }
    : baseResult
}

// Refuse symlink components, special files, oversized inputs, and hard-linked data.
function safeDirectory(dir: string, create = false): boolean {
  const root = parse(dir).root
  let path = root
  for (const part of dir.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    path = join(path, part)
    try { lstatSync(path) }
    catch (error: any) {
      if (!create || error.code !== "ENOENT") throw error
      try { mkdirSync(path, { mode: 0o700 }) } catch (race: any) { if (race.code !== "EEXIST") throw race }
    }
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
  }
  return true
}
function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1 || st.size > 1_000_000) throw new Error("unsafe cache file")
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}
function atomic(path: string, contents: string): void {
  try { const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("unsafe target") }
  catch (error: any) { if (error.code !== "ENOENT") throw error }
  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, contents); closeSync(fd); renameSync(temp, path) }
  catch (error) { try { closeSync(fd) } catch {} ; try { unlinkSync(temp) } catch {} ; throw error }
}

/** Passive raw-telemetry learner. No model calls, timers, prompts, or event storage. */
export class CacheLearner {
  private dir: string
  private salt = randomBytes(32).toString("hex")
  private records: RecordEntry[] = []
  private saved = new Map<string, SavedEstimate>()
  private request?: Request
  private anchor?: Anchor
  private latest = new Map<string, string>()
  /** storageDir is the package-owned directory, prepared by startup migration. */
  constructor(storageDir: string) {
    this.dir = resolve(storageDir)
    try { if (safeDirectory(this.dir)) this.reload() } catch { /* unavailable storage */ }
  }
  private route(model: CacheModel, retention: Retention): string {
    return digest(this.salt, [model.provider, model.api, model.id, model.baseUrl ?? null, retention, model.compat?.supportsLongCacheRetention !== false])
  }
  private reload(): void {
    try {
      const state = JSON.parse(readPrivate(join(this.dir, "estimates.json")))
      if (state.v === 1 && token(state.salt)) {
        this.salt = state.salt
        this.saved.clear()
        if (Array.isArray(state.estimates)) for (const entry of state.estimates.slice(-LIMIT)) {
          const estimate = savedEstimate(entry)
          if (estimate) this.saved.set(estimate.profile, estimate)
        }
      }
    } catch { /* corrupted/missing derived state */ }
    const records: RecordEntry[] = []
    for (const name of ["observations.jsonl.1", "observations.jsonl"]) {
      try {
        for (const line of readPrivate(join(this.dir, name)).split("\n")) {
          try { const r = JSON.parse(line); if (validRecord(r)) records.push(r) } catch { /* skip malformed line */ }
        }
      } catch { /* fail open */ }
    }
    // A crash between the two atomic log replacements can leave overlapping
    // generations. Never count one observation twice after recovery.
    const deduped = [...new Map(records.map(r => [JSON.stringify(r), r])).values()]
    const cutoff = retentionCutoff(deduped, this.saved.values())
    this.records = (cutoff !== undefined ? deduped.filter(r => r.at >= cutoff) : deduped).slice(-LIMIT * 2)
    if (cutoff !== undefined) {
      const activeProfiles = new Set(this.records.map(r => r.profile))
      for (const [profile, saved] of this.saved) {
        if (!activeProfiles.has(profile) && (saved.at === undefined || saved.at < cutoff)) this.saved.delete(profile)
      }
    }
    this.latest.clear()
    for (const estimate of this.saved.values()) this.latest.set(estimate.route, estimate.profile)
    for (const r of this.records) this.latest.set(r.route, r.profile)
  }
  begin(payload: unknown, model: CacheModel, retention: Retention, at = Date.now()): void {
    if (this.request) this.anchor = undefined
    this.request = undefined
    if (!isSupportedCacheModel(model) || !count(at)) { this.anchor = undefined; return }
    const prefix = fingerprint(payload, this.salt)
    const profile = digest(this.salt, [this.route(model, retention), prefix?.settings ?? "invalid"])
    this.request = { model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
      compat: { supportsLongCacheRetention: model.compat?.supportsLongCacheRetention } }, retention, at, prefix, profile, usage: {}, previous: this.anchor }
    this.latest.set(this.route(model, retention), profile)
  }
  observe(api: string, data: unknown): void {
    try {
      const r = this.request
      if (!r || r.model.api !== api || !object(data)) return
      let usage: unknown
      if (api === "anthropic-messages") usage = data.type === "message_start" ? data.message?.usage : data.type === "message_delta" ? data.usage : undefined
      else if (api === "openai-responses" || api === "openai-codex-responses") usage = data.response?.usage
      else if (api === "openai-completions") usage = data.usage ?? data.choices?.[0]?.usage
      const next = counters(api, usage)
      const previous = r.usage
      r.usage = { ...previous, ...next }
      if (next.read !== undefined && previous.read !== undefined && next.read < previous.read) {
        r.usage.read = previous.read // A reported positive read can never become a raw miss.
        r.usage.conflict = true
      }
    } catch { /* instrumentation must never affect requests */ }
  }
  finish(message: { role: string; provider: string; model: string; api: string; timestamp: number; stopReason: string; usage?: unknown }): void {
    const r = this.request
    this.request = undefined
    this.anchor = undefined
    if (!r || message.role !== "assistant" || message.provider !== r.model.provider || message.model !== r.model.id || message.api !== r.model.api
      || !["stop", "length", "toolUse"].includes(message.stopReason)) return
    const prior = r.previous
    const elapsed = prior ? r.at - prior.at : undefined
    const { read, write, input } = r.usage
    const prefixMatch = !!r.prefix && !!prior && prior.profile === r.profile && prior.affinity === r.prefix.affinity
      && prior.parts.length <= r.prefix.parts.length && prior.parts.every((p, i) => r.prefix!.parts[i] === p)
      && count(elapsed) && elapsed <= 24 * 60 * MINUTE && !r.usage.conflict
    // When the prior turn had read=0 and no positive write counter (e.g. free/implicit cache fill on Gemini/OpenAI),
    // a subsequent positive read (>= IMPLICIT_READ_MIN) proves the prior turn populated the cache.
    const implicitHit = prefixMatch && prior!.cacheable === 0 && !prior!.writeKnown && read !== undefined && read >= IMPLICIT_READ_MIN
    const comparable = prefixMatch && (prior!.cacheable > 0 || implicitHit)
    const substantial = comparable && read !== undefined && read > 0 && (prior!.cacheable > 0 ? read >= prior!.cacheable * 0.95 : implicitHit)
    const record: RecordEntry = {
      v: 1, profile: r.profile, route: this.route(r.model, r.retention), provider: r.model.provider, model: r.model.id, api: r.model.api, retention: r.retention,
      long: r.model.compat?.supportsLongCacheRetention !== false, at: r.at,
      outcome: read === undefined ? "unknown" : read > 0 ? "hit" : "miss",
      ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}),
      ...(count(elapsed) ? { elapsed } : {}), qualified: comparable && read !== undefined,
      substantial,
    }
    const explicitCacheable = (read ?? 0) + (write ?? 0)
    const implicitCacheable = read === 0 && (write ?? 0) === 0 && r.model.api !== "anthropic-messages"
      ? (input !== undefined && input >= IMPLICIT_READ_MIN ? input : 0)
      : 0
    const writeKnown = (write ?? 0) > 0 || r.model.api === "anthropic-messages"
    if (r.prefix && !r.usage.conflict && (explicitCacheable > 0 || (read === 0 && !writeKnown))) {
      this.anchor = { profile: r.profile, affinity: r.prefix.affinity, parts: r.prefix.parts, at: r.at,
        cacheable: explicitCacheable > 0 ? explicitCacheable : implicitCacheable, writeKnown }
    }
    const merged = [...this.records, record]
    const cutoff = retentionCutoff(merged, this.saved.values(), record.at)
    this.records = (cutoff !== undefined ? merged.filter(e => e.at >= cutoff) : merged).slice(-LIMIT * 2)
    this.persist(record)
  }
  reset(): void { this.request = undefined; this.anchor = undefined }
  estimate(model: CacheModel, retention: Retention): CacheEstimate {
    if (!isSupportedCacheModel(model)) return { source: "unknown" }
    const profile = this.latest.get(this.route(model, retention))
    const saved = profile ? this.saved.get(profile) : undefined
    return derive(this.records.filter(r => r.profile === profile), model, retention, asEstimate(saved))
  }
  private persist(record: RecordEntry): void {
    let fd: number | undefined
    const lock = join(this.dir, "observations.lock")
    try {
      if (!safeDirectory(this.dir, true)) return
      fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const salt = this.salt
      this.reload() // Merge under the lock; never overwrite another process's evidence.
      if (salt !== this.salt) { this.reset(); return } // A concurrent first writer chose another salt.
      const merged = [...this.records, record]
      const cutoff = retentionCutoff(merged, this.saved.values(), record.at)
      this.records = (cutoff !== undefined ? merged.filter(r => r.at >= cutoff) : merged).slice(-LIMIT * 2)
      if (cutoff !== undefined) {
        const activeProfiles = new Set(this.records.map(r => r.profile))
        for (const [profile, saved] of this.saved) {
          if (!activeProfiles.has(profile) && (saved.at === undefined || saved.at < cutoff)) this.saved.delete(profile)
        }
      }
      this.latest.set(record.route, record.profile)
      const older = this.records.slice(0, Math.max(0, this.records.length - LIMIT))
      const newer = this.records.slice(-LIMIT)
      atomic(join(this.dir, "observations.jsonl.1"), older.map(r => JSON.stringify(r)).join("\n") + (older.length ? "\n" : ""))
      atomic(join(this.dir, "observations.jsonl"), newer.map(r => JSON.stringify(r)).join("\n") + "\n")
      const profiles = [...new Set([...this.saved.keys(), ...this.records.map(r => r.profile)])].slice(-LIMIT)
      const estimates = profiles.map(profile => {
        const rs = this.records.filter(r => r.profile === profile), last = rs.at(-1), saved = this.saved.get(profile)
        if (!last) return saved!
        const estimate: SavedEstimate = { profile, route: last.route, at: last.at, ...derive(rs, modelFor(last), last.retention, asEstimate(saved)) }
        this.saved.set(profile, estimate)
        return estimate
      })
      atomic(join(this.dir, "estimates.json"), JSON.stringify({ v: 1, salt: this.salt, estimates }) + "\n")
    } catch { /* Disk errors/lock contention must not block a model request. */ }
    finally { if (fd !== undefined) { try { closeSync(fd) } catch {} ; try { unlinkSync(lock) } catch {} } }
  }
}
