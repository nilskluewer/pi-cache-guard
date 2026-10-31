import { lstatSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { OBSERVATION_RETENTION_MS } from "./cache-learning.ts"

export interface CacheHistoryEntry {
  timestamp: string
  at: number
  provider: string
  model: string
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  outcome: "hit" | "write" | "miss"
  cacheReadCost: number
  cacheWriteCost: number
  inputCost: number
  totalCost: number
  session: string
}

export interface CollectCacheHistoryOptions {
  filter?: string
  now?: number
  currentEntries?: readonly any[]
  currentSessionId?: string
  limit?: number
}

const DEFAULT_LIMIT = 200
const MAX_SESSION_FILE_BYTES = 50_000_000
const DAY_MS = 24 * 60 * 60 * 1000

const finiteNonNegative = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

function parseTimestamp(entry: any, message: any): { timestamp: string; at: number } | undefined {
  let at = NaN
  let iso: string | undefined
  if (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)) {
    at = message.timestamp
    iso = new Date(at).toISOString()
  }
  if (typeof entry?.timestamp === "string" && entry.timestamp.trim()) {
    const parsed = Date.parse(entry.timestamp)
    if (Number.isFinite(parsed)) {
      if (!Number.isFinite(at)) at = parsed
      iso = new Date(parsed).toISOString()
    }
  }
  if (!Number.isFinite(at) || !iso) return undefined
  return { timestamp: iso, at }
}

function shortSessionLabel(raw: string): string {
  const base = basename(raw).replace(/\.jsonl$/i, "")
  const parts = base.split("_")
  if (parts.length > 1 && parts.at(-1)!.length >= 6) return parts.at(-1)!.slice(0, 12)
  return base.length > 20 ? base.slice(-16) : base || "session"
}

function extractEntry(rawEntry: any, sessionLabel: string): { item: CacheHistoryEntry; dedupKey: string } | undefined {
  if (!rawEntry || typeof rawEntry !== "object" || rawEntry.type !== "message") return undefined
  const message = rawEntry.message
  if (!message || typeof message !== "object" || message.role !== "assistant") return undefined
  const usage = message.usage
  if (!usage || typeof usage !== "object") return undefined

  const time = parseTimestamp(rawEntry, message)
  if (!time) return undefined

  const provider = typeof message.provider === "string" && message.provider.trim() ? message.provider.trim() : "unknown"
  const model = typeof message.model === "string" && message.model.trim() ? message.model.trim() : "unknown"
  const cacheRead = finiteNonNegative(usage.cacheRead)
  const cacheWrite = finiteNonNegative(usage.cacheWrite)
  const input = finiteNonNegative(usage.input)
  const output = finiteNonNegative(usage.output)
  const outcome: CacheHistoryEntry["outcome"] = cacheRead > 0 ? "hit" : cacheWrite > 0 ? "write" : "miss"

  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {}
  const cacheReadCost = finiteNonNegative(cost.cacheRead)
  const cacheWriteCost = finiteNonNegative(cost.cacheWrite)
  const inputCost = finiteNonNegative(cost.input)
  const totalCost = finiteNonNegative(cost.total)

  const idPart = typeof rawEntry.id === "string" && rawEntry.id ? rawEntry.id : `${time.at}:${input}:${output}`
  const dedupKey = `${provider}/${model}:${time.at}:${cacheRead}:${cacheWrite}:${idPart}`

  return {
    dedupKey,
    item: {
      timestamp: time.timestamp,
      at: time.at,
      provider,
      model,
      cacheRead,
      cacheWrite,
      input,
      output,
      outcome,
      cacheReadCost,
      cacheWriteCost,
      inputCost,
      totalCost,
      session: sessionLabel,
    },
  }
}

function scanSessionFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out
  let names: string[]
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return out
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const full = join(dir, name)
    try {
      const st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        scanSessionFiles(full, out, depth + 1)
      } else if (st.isFile() && name.endsWith(".jsonl") && st.size > 0 && st.size <= MAX_SESSION_FILE_BYTES) {
        out.push(full)
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return out
}

function matchesFilter(
  entry: CacheHistoryEntry,
  tokens: readonly string[],
  nowRef: number,
  explicitNow: boolean,
): boolean {
  if (tokens.length === 0) return true
  const fullModel = `${entry.provider}/${entry.model}`.toLowerCase()
  const modelOnly = entry.model.toLowerCase()
  const sessionLower = entry.session.toLowerCase()

  for (const token of tokens) {
    if (token === "today") {
      if (explicitNow) {
        const dayStartUtc = new Date(nowRef)
        dayStartUtc.setHours(0, 0, 0, 0)
        const within24h = entry.at >= nowRef - DAY_MS && entry.at <= nowRef + DAY_MS
        const sameLocalDay = entry.at >= dayStartUtc.getTime() && entry.at < dayStartUtc.getTime() + DAY_MS
        if (!within24h && !sameLocalDay) return false
      } else {
        const dayStart = new Date(nowRef)
        dayStart.setHours(0, 0, 0, 0)
        if (entry.at < dayStart.getTime() || entry.at >= dayStart.getTime() + DAY_MS) return false
      }
      continue
    }
    if (token === "hit" || token === "hits") {
      if (entry.outcome !== "hit") return false
      continue
    }
    if (token === "miss" || token === "misses") {
      if (entry.outcome !== "miss") return false
      continue
    }
    if (token === "write" || token === "writes") {
      if (entry.outcome !== "write") return false
      continue
    }
    if (!fullModel.includes(token) && !modelOnly.includes(token) && !sessionLower.includes(token)) {
      return false
    }
  }
  return true
}

export function collectCacheHistory(
  agentDir: string,
  options: CollectCacheHistoryOptions = {},
): CacheHistoryEntry[] {
  const byKey = new Map<string, CacheHistoryEntry>()
  const sessionsDir = join(resolve(agentDir), "sessions")
  const files = scanSessionFiles(sessionsDir)

  for (const file of files) {
    let raw: string
    try {
      raw = readFileSync(file, "utf8")
    } catch {
      continue
    }
    let sessionLabel = shortSessionLabel(file)
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed?.type === "session" && typeof parsed.id === "string" && parsed.id.trim()) {
          sessionLabel = shortSessionLabel(parsed.id.trim())
          continue
        }
        const extracted = extractEntry(parsed, sessionLabel)
        if (extracted && !byKey.has(extracted.dedupKey)) {
          byKey.set(extracted.dedupKey, extracted.item)
        }
      } catch {
        /* skip malformed JSONL line */
      }
    }
  }

  if (Array.isArray(options.currentEntries) && options.currentEntries.length > 0) {
    const label = shortSessionLabel(options.currentSessionId || "current")
    for (const rawEntry of options.currentEntries) {
      const extracted = extractEntry(rawEntry, label)
      if (extracted && !byKey.has(extracted.dedupKey)) {
        byKey.set(extracted.dedupKey, extracted.item)
      }
    }
  }

  const all = [...byKey.values()]
  if (all.length === 0) return []

  let referenceNow = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : 0
  for (const item of all) {
    if (item.at > referenceNow) referenceNow = item.at
  }
  if (referenceNow <= 0) referenceNow = Date.now()
  const cutoff = referenceNow >= OBSERVATION_RETENTION_MS ? referenceNow - OBSERVATION_RETENTION_MS : 0

  const tokens = (options.filter ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const explicitNow = typeof options.now === "number" && Number.isFinite(options.now)
  const filterRef = explicitNow ? options.now! : Date.now()

  const filtered = all
    .filter((entry) => entry.at >= cutoff && matchesFilter(entry, tokens, filterRef, explicitNow))
    .sort((a, b) => b.at - a.at)

  const limit = options.limit !== undefined && options.limit > 0 ? options.limit : undefined
  return limit !== undefined ? filtered.slice(0, limit) : filtered
}

function fmtUsdPrecise(amount: number): string {
  return `$${amount.toFixed(4)}`
}

function fmtInt(value: number): string {
  return Math.round(value).toLocaleString("en-US")
}

function fmtTimestamp(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z")
}

function renderAlignedTable(
  headers: readonly string[],
  rightAlign: readonly boolean[],
  rows: readonly (readonly string[])[],
  repeatHeaderEvery = 0,
): string[] {
  const widths = headers.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? "").length)),
  )
  const pad = (val: string, col: number) =>
    rightAlign[col] ? val.padStart(widths[col], " ") : val.padEnd(widths[col], " ")
  const headerLine = "| " + headers.map((h, i) => pad(h, i)).join(" | ") + " |"
  const sepLine =
    "| " +
    widths
      .map((w, i) => (rightAlign[i] ? "-".repeat(Math.max(1, w - 1)) + ":" : "-".repeat(w)))
      .join(" | ") +
    " |"

  const out: string[] = [headerLine, sepLine]
  for (let i = 0; i < rows.length; i++) {
    if (repeatHeaderEvery > 0 && i > 0 && i % repeatHeaderEvery === 0) {
      out.push(sepLine, headerLine, sepLine)
    }
    out.push("| " + rows[i].map((c, col) => pad(c ?? "", col)).join(" | ") + " |")
  }
  if (repeatHeaderEvery > 0 && rows.length > 1) {
    out.push(sepLine, headerLine)
  }
  return out
}

export function formatCacheHistoryReport(
  entries: readonly CacheHistoryEntry[],
  options: { filter?: string; limit?: number } = {},
): string {
  const filter = options.filter?.trim() ?? ""
  const limit = options.limit ?? DEFAULT_LIMIT

  let totalReadTokens = 0
  let totalWriteTokens = 0
  let totalReadCost = 0
  let totalWriteCost = 0
  let totalCost = 0
  let hits = 0
  let writes = 0
  let misses = 0

  type ModelAgg = {
    key: string
    requests: number
    hits: number
    writes: number
    misses: number
    cacheRead: number
    cacheWrite: number
    readCost: number
    writeCost: number
    totalCost: number
  }
  const byModel = new Map<string, ModelAgg>()

  for (const e of entries) {
    totalReadTokens += e.cacheRead
    totalWriteTokens += e.cacheWrite
    totalReadCost += e.cacheReadCost
    totalWriteCost += e.cacheWriteCost
    totalCost += e.totalCost
    if (e.outcome === "hit") hits++
    else if (e.outcome === "write") writes++
    else misses++

    const key = `${e.provider}/${e.model}`
    const agg = byModel.get(key) ?? {
      key,
      requests: 0,
      hits: 0,
      writes: 0,
      misses: 0,
      cacheRead: 0,
      cacheWrite: 0,
      readCost: 0,
      writeCost: 0,
      totalCost: 0,
    }
    agg.requests++
    if (e.outcome === "hit") agg.hits++
    else if (e.outcome === "write") agg.writes++
    else agg.misses++
    agg.cacheRead += e.cacheRead
    agg.cacheWrite += e.cacheWrite
    agg.readCost += e.cacheReadCost
    agg.writeCost += e.cacheWriteCost
    agg.totalCost += e.totalCost
    byModel.set(key, agg)
  }

  const lines: string[] = [
    "# Cache Guard History (Last 30 Days)",
    "",
    ...(filter ? [`- **Filter**: \`${filter}\``] : []),
    `- **Requests**: ${entries.length} (hits: ${hits}, writes: ${writes}, misses: ${misses})`,
    `- **Tokens**: cacheRead=${fmtInt(totalReadTokens)}, cacheWrite=${fmtInt(totalWriteTokens)}`,
    `- **Costs**: read$=${fmtUsdPrecise(totalReadCost)}, write$=${fmtUsdPrecise(totalWriteCost)}, total$=${fmtUsdPrecise(totalCost)}`,
    "",
    "> **Note on API Values & Billing**: Token counters (`cacheRead`, `cacheWrite`) come directly from the API usage responses saved by Pi. USD amounts (`read$`, `write$`, `total$`) are calculated by Pi from model catalog rates. For implicit caches (such as Gemini or OpenAI where cache writes are discounted to $0 or not billed separately), `write=0` and `write$=$0.0000` is normal.",
    "",
  ]

  if (entries.length === 0) {
    lines.push("No matching assistant usage entries found in the last 30 days.")
    return lines.join("\n")
  }

  const sortedModels = [...byModel.values()].sort((a, b) => b.requests - a.requests || a.key.localeCompare(b.key))
  lines.push(
    "## Per-Model Summary",
    "",
    ...renderAlignedTable(
      ["Model", "Requests", "Hits", "Misses", "Cache Read", "Cache Write", "Read $", "Write $", "Total $"],
      [false, true, true, true, true, true, true, true, true],
      sortedModels.map((m) => [
        m.key,
        String(m.requests),
        String(m.hits),
        String(m.misses),
        fmtInt(m.cacheRead),
        fmtInt(m.cacheWrite),
        fmtUsdPrecise(m.readCost),
        fmtUsdPrecise(m.writeCost),
        fmtUsdPrecise(m.totalCost),
      ]),
    ),
  )

  const rows = entries.slice(0, limit)
  lines.push(
    "",
    `## Chronological Requests (Newest First${entries.length > rows.length ? `, showing ${rows.length} of ${entries.length}` : ""})`,
    "",
    ...renderAlignedTable(
      ["Timestamp", "Model", "Outcome", "Cache Read", "Cache Write", "Read $", "Write $", "Total $", "Session"],
      [false, false, false, true, true, true, true, true, false],
      rows.map((e) => [
        fmtTimestamp(e.timestamp),
        `${e.provider}/${e.model}`,
        e.outcome,
        fmtInt(e.cacheRead),
        fmtInt(e.cacheWrite),
        fmtUsdPrecise(e.cacheReadCost),
        fmtUsdPrecise(e.cacheWriteCost),
        fmtUsdPrecise(e.totalCost),
        e.session,
      ]),
      5,
    ),
  )

  return lines.join("\n")
}
