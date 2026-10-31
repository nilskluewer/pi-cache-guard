import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { migrateCacheGuardStorage } from "./cache-storage.ts"

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"

import {
  scopedModelOptions,
  coldCost,
  findLastCacheHit,
  formatAgo,
  formatDuration,
  formatTokens,
  formatUsd,
  getCacheStatus,
  getRetention,
  parseUsd,
  warmCost,
} from "./cache-guard-logic.ts"

import { createHandoffService, type HandoffOptions } from "./handoff.ts"
import { createHandoffChooser } from "./handoff-choice.ts"
import { CacheLearner } from "./cache-learning.ts"
import { cacheLifetime, handoffPauseReason, nativeWarmingMode } from "./cache-policy.ts"
import { collectCacheHistory, formatCacheHistoryReport } from "./cache-history.ts"
import { visibleWidth } from "@earendil-works/pi-tui"
import { cacheDisplayText, layoutCacheDisplay, renderCacheBox, type CacheDisplay } from "./cache-display.ts"

export * from "./cache-guard-logic.ts"

const STATUS_KEY = "cache-guard"
const WARN_BEFORE_EXPIRY_MS = 60_000

const PLACEMENTS = ["corner", "above", "below", "footer", "off"] as const
type Placement = (typeof PLACEMENTS)[number]
const DEFAULT_PLACEMENT: Placement = "above"
const PLACEMENT_HELP: Record<Placement, string> = {
  corner: "top right corner of the session",
  above: "above the editor",
  below: "below the editor",
  footer: "footer status line (can be hidden by long statuses)",
  off: "hidden",
}
const BAR_WIDTH = 10

/** Progress bar of the remaining cache lifetime, for example `▰▰▰▰▰▰▱▱▱▱`. Returns the filled and empty parts. */
function bar(remainingMs: number, ttlMs: number): { filled: string; empty: string } {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.ceil((remainingMs / ttlMs) * BAR_WIDTH)))
  return { filled: "▰".repeat(filled), empty: "▱".repeat(BAR_WIDTH - filled) }
}

const isPlacement = (value: string): value is Placement => (PLACEMENTS as readonly string[]).includes(value)

type Settings = { placement?: Placement; budgetUsd?: number; autoHandoff?: boolean; handoffColdCostThresholdUsd?: number }

function loadSettings(settingsPath: string): Settings {
  try {
    if (!existsSync(settingsPath)) return {}
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { autoHandoff: false }
    const settings: Settings = {}
    let malformed = false
    if ("placement" in raw) {
      if (typeof raw.placement === "string" && isPlacement(raw.placement)) settings.placement = raw.placement
      else malformed = true
    }
    if ("autoHandoff" in raw) {
      if (typeof raw.autoHandoff === "boolean") settings.autoHandoff = raw.autoHandoff
      else malformed = true
    }
    for (const key of ["budgetUsd", "handoffColdCostThresholdUsd"] as const) {
      if (!(key in raw)) continue
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) settings[key] = raw[key]
      else malformed = true
    }
    // The old handoffThresholdUsd measured lifetime spending. Never use it as a prompt estimate.
    if (malformed) settings.autoHandoff = false
    return settings
  } catch {
    // A missing preference defaults on; an unreadable/malformed settings file must not.
    return { autoHandoff: false }
  }
}

function writeSettings(settingsPath: string, update: Settings) {
  writeFileSync(settingsPath, JSON.stringify({ ...loadSettings(settingsPath), ...update }, null, 2) + "\n", { mode: 0o600 })
}

const DEFAULT_HANDOFF_THRESHOLD_USD = 0.5
const DEFAULT_BUDGET_USD = 0.1
const BUDGET_PRESETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]

/** Budget: saved setting, then PI_CACHE_GUARD_MIN_USD, then $0.10. A cold send up to the budget goes out without asking. */
function loadBudget(settingsPath: string): number {
  const saved = loadSettings(settingsPath).budgetUsd
  if (saved !== undefined) return saved
  const env = process.env.PI_CACHE_GUARD_MIN_USD
  const value = env === undefined || env.trim() === "" ? NaN : Number(env)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BUDGET_USD
}

const describeBudget = (usd: number) => (usd === 0 ? "always ask" : `ask above ${formatUsd(usd)}`)

function inspectState(ctx: ExtensionContext, learner: CacheLearner) {
  const model = ctx.model
  if (!model) return undefined
  const retention = getRetention()
  const hit = findLastCacheHit(ctx.sessionManager.getBranch())
  const estimate = cacheLifetime(model, retention, learner.estimate(model, retention))
  const effectiveHit = hit && !hit.cached && estimate.ttlMs !== undefined && model.api !== "anthropic-messages"
    ? { ...hit, cached: true }
    : hit
  const status = estimate.ttlMs === undefined ? { state: "unknown" as const }
    : getCacheStatus(model, effectiveHit, retention, Date.now(), estimate.ttlMs)
  const currentTokens = ctx.getContextUsage()?.tokens
  // Historical usage can inform a warning, but must not authorize automatic spending.
  const tokens = currentTokens ?? hit?.promptTokens ?? 0
  return { model, retention, hit, status, tokens, currentTokens, estimate }
}

export default function cacheGuardExtension(pi: ExtensionAPI, options: { handoff?: HandoffOptions } = {}) {
  const agentDir = options.handoff?.agentDir ?? getAgentDir()
  const storageBackups: string[] = []
  const storageDir = migrateCacheGuardStorage(agentDir, path => storageBackups.push(path))
  const settingsPath = join(storageDir, "settings.json")
  const saveSettings = (update: Settings) => writeSettings(settingsPath, update)
  const learner = new CacheLearner(storageDir)
  const inspect = (ctx: ExtensionContext) => inspectState(ctx, learner)
  const handoffPause = () => handoffPauseReason(nativeWarmingMode(agentDir, pi.getSettings?.() ?? {}))
  const handoff = createHandoffService(pi, { ...options.handoff, agentDir })
  const chooser = createHandoffChooser(pi, handoff, agentDir)
  let timer: ReturnType<typeof setInterval> | undefined
  let current: ExtensionContext | undefined
  let placement = loadSettings(settingsPath).placement ?? DEFAULT_PLACEMENT
  let budget = loadBudget(settingsPath)
  let autoHandoff = loadSettings(settingsPath).autoHandoff ?? true
  let handoffThreshold = loadSettings(settingsPath).handoffColdCostThresholdUsd ?? DEFAULT_HANDOFF_THRESHOLD_USD
  let sessionId: string | undefined
  type Display = () => CacheDisplay
  type Corner = { content: Display; width: number; close: () => void; tui?: { requestRender(): void } }
  let corner: Corner | undefined

  /** Pi resolves overlay options once. Reopen only when the preferred width changes;
   * normal redraws and terminal resizes use render(width) without stealing focus. */
  const showCorner = (ctx: ExtensionContext, content: Display | undefined) => {
    if (!content) { closeCorner(); return }
    const width = visibleWidth(cacheDisplayText(content())) + 4
    if (corner?.width === width) {
      corner.content = content
      corner.tui?.requestRender()
      return
    }
    closeCorner()
    const state: Corner = { content, width, close: () => {} }
    corner = state
    void ctx.ui
      .custom<void>(
        (tui, _theme, _kb, done) => {
          state.tui = tui
          state.close = () => done()
          return { render: (availableWidth: number) => renderCacheBox(state.content(), availableWidth), invalidate() {} }
        },
        {
          overlay: true,
          overlayOptions: () => ({ anchor: "top-right", width: state.width, margin: { top: 1, right: 3 }, nonCapturing: true }),
        },
      )
      .catch(() => {})
      .finally(() => {
        if (corner === state) corner = undefined
      })
  }

  const closeCorner = () => {
    corner?.close()
    corner = undefined
  }

  /** Widgets wrap at their allocated width; footer statuses must stay one line. */
  const show = (ctx: ExtensionContext, content: Display | undefined) => {
    if (placement === "corner" && ctx.mode === "tui") showCorner(ctx, content)
    else closeCorner()
    ctx.ui.setStatus(STATUS_KEY, placement === "footer" && content ? cacheDisplayText(content(), false) : undefined)
    const widget = content ? ctx.mode === "tui"
      ? () => ({ render: (width: number) => layoutCacheDisplay(content(), width), invalidate() {} })
      : [cacheDisplayText(content(), false)] : undefined
    ctx.ui.setWidget(STATUS_KEY, placement === "above" ? widget : undefined, { placement: "aboveEditor" })
    ctx.ui.setWidget(`${STATUS_KEY}-below`, placement === "below" ? widget : undefined, { placement: "belowEditor" })
  }

  const refreshStatus = () => {
    const ctx = current
    if (!ctx?.hasUI) return
    const state = inspect(ctx)
    if (!state || state.status.state === "none") {
      show(ctx, undefined)
      return
    }
    if (state.status.state === "unknown") {
      const maxHit = state.estimate.maxHitAfterMs !== undefined ? formatDuration(state.estimate.maxHitAfterMs)
        : state.estimate.lastHitAfterMs !== undefined ? formatDuration(state.estimate.lastHitAfterMs) : undefined
      const detail = [
        maxHit ? `hits up to ${maxHit}` : undefined,
        state.estimate.earlyMisses ? `early misses (${state.estimate.earlyMisses})` : undefined,
        state.estimate.unobservedWrites ? "writes unconfirmed" : undefined,
      ].filter(Boolean).join(" · ")
      show(ctx, () => ({
        primary: ctx.ui.theme.fg("muted", state.estimate.variable ? "cache duration variable" : "cache duration unknown"),
        compactPrimary: ctx.ui.theme.fg("muted", state.estimate.variable ? "cache variable" : "cache unknown"),
        ...(detail ? {
          secondary: ctx.ui.theme.fg("muted", detail),
          inlineSecondary: ctx.ui.theme.fg("muted", detail),
          compactSecondary: ctx.ui.theme.fg("muted", maxHit ? `hits ≤${maxHit}` : detail),
        } : {}),
      }))
      return
    }
    if (state.status.state === "warm") {
      const { remainingMs, ttlMs } = state.status
      const { filled, empty } = bar(remainingMs, ttlMs)
      const time = formatDuration(remainingMs)
      const color = remainingMs < WARN_BEFORE_EXPIRY_MS ? "warning" : "accent"
      const minutes = Math.ceil(ttlMs / 60_000)
      const qualifier = state.estimate.source === "declared" ? "(declared est.)"
        : state.estimate.source === "family" ? "(family est.)" : "(est.)"
      const notes = [
        state.estimate.source === "declared" && state.estimate.variable ? "local duration variable" : undefined,
        state.estimate.source === "declared" && state.estimate.observedTtlMs !== undefined && state.estimate.observedTtlMs !== ttlMs
          ? `local est. ${formatDuration(state.estimate.observedTtlMs)}` : undefined,
        state.estimate.maxHitAfterMs !== undefined ? `hits ≤${formatDuration(state.estimate.maxHitAfterMs)}` : undefined,
        state.estimate.earlyMisses ? `${state.estimate.earlyMisses} early miss${state.estimate.earlyMisses === 1 ? "" : "es"}` : undefined,
        state.estimate.unobservedWrites ? "writes $0/unreported" : undefined,
      ].filter(Boolean).join(", ")
      show(ctx, () => {
        const { theme } = ctx.ui
        const baseDetail = theme.fg(color, filled) + theme.fg("borderMuted", empty) + theme.fg(color, " " + time + " " + qualifier)
        const fullDetail = notes ? baseDetail + theme.fg("muted", " · " + notes) : baseDetail
        return {
          primary: theme.fg(color, `◷ ~${minutes}m`),
          compactPrimary: theme.fg(color, `◷ ~${minutes}m`),
          secondary: fullDetail,
          inlineSecondary: fullDetail,
          compactSecondary: theme.fg(color, time + " " + qualifier),
          separator: " ",
        }
      })
      return
    }
    const cost = state.tokens > 0 ? "~" + formatUsd(coldCost(state.model, state.tokens, state.retention)) : undefined
    show(ctx, () => ({
      primary: ctx.ui.theme.fg("error", "◷ cache est. ended"),
      compactPrimary: ctx.ui.theme.fg("error", "◷ past estimate"),
      secondary: cost ? ctx.ui.theme.fg("error", "On a miss: " + cost) : undefined,
      inlineSecondary: cost ? ctx.ui.theme.fg("error", "miss " + cost) : undefined,
      compactSecondary: cost ? ctx.ui.theme.fg("error", "miss " + cost) : undefined,
    }))
  }

  const eligibleContextCost = (state: NonNullable<ReturnType<typeof inspect>>) => {
    const tokens = state.currentTokens
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return false
    const cost = coldCost(state.model, tokens, state.retention)
    return Number.isFinite(cost) && cost >= 0 && cost > handoffThreshold
  }

  /** No queued deadline job: each tick uses current policy and cache state, never a cold catch-up.
   * This path is synchronous through start(), which persists the sole lifetime dispatch guard. */
  const scheduleHandoff = () => {
    const ctx = current
    if (!ctx || ctx.mode !== "tui" || !autoHandoff || ctx.sessionManager.getSessionId() !== sessionId || handoffPause()) return
    const observed = inspect(ctx)
    if (!observed || observed.status.state !== "warm" || observed.status.remainingMs > WARN_BEFORE_EXPIRY_MS) return
    const leaf = ctx.sessionManager.getLeafId()
    if (handoff.getState(ctx) || !eligibleContextCost(observed)) return
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return

    // Re-read after eligibility checks. A lifecycle/model/branch change must not use the old observation.
    const latest = inspect(ctx)
    if (current !== ctx || !autoHandoff || handoffPause() || ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.sessionManager.getLeafId() !== leaf || !latest || latest.model.provider !== observed.model.provider ||
        latest.model.id !== observed.model.id || latest.retention !== observed.retention || latest.hit?.at !== observed.hit?.at ||
        latest.status.state !== "warm" || latest.status.remainingMs > WARN_BEFORE_EXPIRY_MS ||
        !eligibleContextCost(latest)) return
    handoff.start(ctx) // Rechecks idle/pending and the session-wide guard immediately before dispatch.
  }

  const tick = () => {
    scheduleHandoff()
    refreshStatus()
  }

  const save = (ctx: ExtensionContext, update: Settings) => {
    try {
      saveSettings(update)
    } catch {
      ctx.ui.notify("Could not save the setting. It applies to this session only.", "warning")
    }
  }

  const setPlacement = (ctx: ExtensionContext, choice: Placement) => {
    placement = choice
    save(ctx, { placement: choice })
    current = ctx
    refreshStatus()
    ctx.ui.notify(`Cache countdown: ${PLACEMENT_HELP[choice]}.`, "info")
  }

  const setBudget = (ctx: ExtensionContext, usd: number) => {
    budget = usd
    save(ctx, { budgetUsd: usd })
    ctx.ui.notify(
      usd === 0
        ? "Cache budget: $0. Every cold-cache send asks first."
        : `Cache budget: ${formatUsd(usd)}. A cold-cache send up to this cost goes out without asking.`,
      "info",
    )
  }

  const describeHandoff = () => `${autoHandoff ? "on" : "off"}${autoHandoff && handoffPause() ? ` · ${handoffPause()}` : ""} · estimated current-context cold cost > ${formatUsd(handoffThreshold)}`

  const setHandoff = (ctx: ExtensionContext, enabled: boolean) => {
    autoHandoff = enabled
    save(ctx, { autoHandoff: enabled })
    ctx.ui.notify(enabled
      ? `Automatic handoff: on (default) above ${formatUsd(handoffThreshold)} estimated current-context cold prompt/cache cost. ${handoffPause() ? `${handoffPause()}. ` : ""}Runs once near cache expiry when Pi native idle warming is not enabled; generation and tools incur costs and enter the conversation. This is not a cache refresh. Warm cache is not guaranteed.`
      : "Automatic handoff: off.", "info")
  }

  const setHandoffThreshold = (ctx: ExtensionContext, usd: number) => {
    handoffThreshold = usd
    save(ctx, { handoffColdCostThresholdUsd: usd })
    ctx.ui.notify(`Automatic handoff threshold: estimated current-context cold prompt/cache cost must exceed ${formatUsd(usd)}. Cold-send budget is unchanged.`, "info")
  }

  const pickHandoffThreshold = async (ctx: ExtensionContext) => {
    const typed = await ctx.ui.input("Automatic handoff: estimated current-context cold prompt/cache cost threshold in USD", String(handoffThreshold))
    if (typed === undefined) return
    const usd = parseUsd(typed)
    if (usd === undefined) ctx.ui.notify(`"${typed}" is not a valid amount.`, "error")
    else setHandoffThreshold(ctx, usd)
  }

  const editBudget = async (ctx: ExtensionContext) => {
    const typed = await ctx.ui.input("Cold-send warning budget in USD", String(budget))
    if (typed === undefined) return
    const usd = parseUsd(typed)
    if (usd === undefined) ctx.ui.notify(`"${typed}" is not a valid amount.`, "error")
    else setBudget(ctx, usd)
  }

  const pickBudget = async (ctx: ExtensionContext) => {
    const amounts = [0, ...BUDGET_PRESETS]
    const label = (usd: number) => (usd === 0 ? "Always ask ($0)" : formatUsd(usd))
    const options = amounts.map((usd) => label(usd) + (usd === budget ? " (current)" : ""))
    const custom = "Custom amount…"
    const picked = await ctx.ui.select(`Cache budget: ask before a cold send above this cost (now ${describeBudget(budget)})`, [...options, custom])
    if (!picked) return
    if (picked === custom) return editBudget(ctx)
    const usd = amounts[options.indexOf(picked)]
    if (usd !== undefined) setBudget(ctx, usd)
  }

  const showInfo = async (ctx: ExtensionContext) => {
    const text = [
      "# Prompt Cache Mechanics in Pi Cache Guard",
      "",
      "## 1. How is the cache status calculated?",
      "- The countdown anchors to the start time of the last request that touched the cache.",
      "- Remaining time = request_start + estimated_ttl - now.",
      "- Pi's model.promptCache[active retention tier], including models.json overrides, is the countdown baseline.",
      "- Local seeds and learning are fallback estimates only when that tier has no valid declaration.",
      "- Learned evidence stays separate and cannot extend or shorten a declared lifetime.",
      "- When remaining time > 0, status is 'warm' with live countdown.",
      "- When remaining time <= 0, status is 'cache est. ended' (estimate ended, not confirmed cold).",
      "- If model changes or context is compacted, cache resets.",
      "",
      "## 2. Fallback seeds when the active tier has no declaration",
      "- GitHub Copilot:",
      "  • Claude Sonnet 5.5 & Haiku 5.5: 5 min short / 60 min long (measured seeds).",
      "  • Claude Opus 5.5: 5 min / 60 min (family estimate seed, learns independently).",
      "  • GPT-6.1 Sol: 30 min (measured seed).",
      "  • GPT-6 Luna: unknown initially until learned.",
      "  • Gemini 4 Argon: conservative 15 min (measured seed).",
      "  • Gemini 3.8 Flash: unknown/variable (opportunistic reuse).",
      "- Anthropic subscription: 5 min / 60 min family estimate seeds.",
      "- OpenAI Codex subscription: 30 min family estimate seed.",
      "- Each provider route, model, and retention mode maintains its own independent profile.",
      "",
      "## 3. How do we count a hit?",
      "- A request is a qualified hit when:",
      "  • The reusable prefix exactly matches the previous request's cacheable prefix.",
      "  • Model, provider, API, tools, and system prompt match.",
      "  • Reported cached tokens >= 95% of previous cacheable tokens.",
      "- 3 substantial hits at a longer interval (5-min buckets) promote the local estimate.",
      "- 3 qualified explicit zero readings can lower the local estimate, not the declared baseline.",
      "",
      "## 4. Why do we know it is a hit returned from the API?",
      "- Pi's Extension Harness provides the `provider_stream_event` hook.",
      "- We inspect the raw provider SSE event payload directly before normalization:",
      "  • Anthropic Messages: `usage.cache_read_input_tokens`",
      "  • OpenAI Responses & Codex: `usage.input_tokens_details.cached_tokens`",
      "  • OpenAI Completions: `usage.prompt_tokens_details.cached_tokens`",
      "- We never infer a hit or miss from response latency, clock expiry, or cost.",
      "- Only explicit raw numbers count; absent counters remain unknown.",
      "",
      "## 5. Native warming versus handoff generation",
      "- Pi cacheWarming is global-only: off, streaming (default), or idle.",
      "- Native warming requires a declared lifetime and at least $0.05 estimated avoided miss cost.",
      "- Native refresh usage counts toward session totals, but does not enter model context. /session shows Pi's decision.",
      "- Cache Guard does not override cache_warming_decision or change Pi's economics or safety limits.",
      "- With native idle warming enabled, automatic handoff is paused, even if Pi declines or fails a refresh.",
      "- Off/streaming keeps the separate handoff policy. Handoff generation incurs costs and enters the conversation.",
      "",
      "## 6. Pi Harness Connection",
      "- `before_provider_request`: Captures salted prefix fingerprints & request start time.",
      "- `provider_stream_event`: Listens for raw usage events from the provider gateway.",
      "- `message_end`: Finalizes turn observation and updates local persistent estimates.",
      "- Implicit/zero-cost cache writes (such as Gemini where write counters are omitted) are accounted for without treating missing write counters as uncached.",
      "- Observation history is pruned to at most 30 days.",
      "- Use `/cache-guard history` (or select History in `/cache-guard`) to inspect cache hits, misses, and catalog-calculated costs across sessions.",
      "- Telemetry is bounded, private, and stored only in `~/.pi/agent/cache-guard/` without prompts.",
    ].join("\n")

    if (ctx.hasUI) {
      await ctx.ui.editor("Cache Guard Mechanics & Info", text)
    }
  }

  const showHistory = async (ctx: ExtensionContext, filter = "") => {
    const entries = collectCacheHistory(agentDir, {
      filter,
      currentEntries: ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.(),
      currentSessionId: ctx.sessionManager.getSessionId?.(),
    })
    const report = formatCacheHistoryReport(entries, { filter })
    if (ctx.hasUI) {
      await ctx.ui.editor("Cache Guard History", report)
    }
  }

  const showSettings = async (ctx: ExtensionContext) => {
    const infoItem = "ℹ Info · How cache & learning are calculated"
    const historyItem = "◷ History · View cache hits, misses & costs across sessions"
    const budgetItem = `Cold-send budget · ${formatUsd(budget)}${budget === 0 ? " (always ask)" : ""} (edit amount)`
    const handoffItem = `Automatic handoff · ${autoHandoff ? `on (turn off)${handoffPause() ? ` · ${handoffPause()}` : ""}` : "off (turn on)"}`
    const thresholdItem = `Handoff threshold · ${formatUsd(handoffThreshold)} estimated cold cost (edit amount)`
    const placements = new Map(PLACEMENTS.map((p) => [
      `Countdown · ${p}${p === placement ? " (current)" : ""} · ${PLACEMENT_HELP[p]}`,
      p,
    ]))
    const picked = await ctx.ui.select("Cache guard settings", [infoItem, historyItem, budgetItem, handoffItem, thresholdItem, ...placements.keys()])
    if (picked === infoItem) await showInfo(ctx)
    else if (picked === historyItem) await showHistory(ctx)
    else if (picked === budgetItem) await editBudget(ctx)
    else if (picked === handoffItem) setHandoff(ctx, !autoHandoff)
    else if (picked === thresholdItem) await pickHandoffThreshold(ctx)
    else {
      const nextPlacement = picked ? placements.get(picked) : undefined
      if (nextPlacement) setPlacement(ctx, nextPlacement)
    }
  }

  pi.registerCommand("cache-guard", {
    description: "Cache guard settings: history [filter] | budget <usd> | handoff on (default), off, threshold <usd> (current-context cold cost) | above, below, corner, footer, off",
    getArgumentCompletions: (prefix) => {
      const [first = "", second] = prefix.trimStart().split(/\s+/, 2)
      if (second !== undefined || /\s$/.test(prefix)) {
        if (first === "handoff") {
          // Do not replace a threshold amount with its parent subcommand.
          if (/^handoff\s+\S+\s/.test(prefix.trimStart())) return null
          const typed = (second ?? "").toLowerCase()
          const items = [
            { value: "handoff on", label: "on", description: "enable one automatic handoff (default; incurs costs)" },
            { value: "handoff off", label: "off", description: "disable automatic handoff" },
            { value: "handoff threshold", label: "threshold", description: `estimated current-context cold prompt/cache USD threshold (now ${formatUsd(handoffThreshold)})` },
          ].filter((item) => item.label.startsWith(typed))
          return items.length ? items : null
        }
        if (first !== "budget") return null
        const typed = (second ?? "").toLowerCase()
        const items = [0, ...BUDGET_PRESETS]
          .map((usd) => ({ value: `budget ${usd}`, label: String(usd), description: describeBudget(usd) }))
          .filter((item) => item.label.startsWith(typed))
        return items.length ? items : null
      }
      const items = [
        { value: "history", label: "history", description: "view cache hits, misses & costs across all Pi sessions" },
        { value: "budget", label: "budget", description: `cost limit before asking (now ${describeBudget(budget)})` },
        { value: "handoff", label: "handoff", description: `automatic handoff (${describeHandoff()})` },
        ...PLACEMENTS.map((p) => ({ value: p, label: p, description: PLACEMENT_HELP[p] })),
      ].filter((item) => item.label.startsWith(first))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const [first = "", ...rest] = args.trim().split(/\s+/)
      if (!first) return showSettings(ctx)
      if (first === "history") return showHistory(ctx, rest.join(" "))
      if (first === "budget") {
        if (rest.length === 0) return pickBudget(ctx)
        const usd = parseUsd(rest.join(" "))
        if (usd === undefined) ctx.ui.notify(`"${rest.join(" ")}" is not a valid amount. Example: /cache-guard budget 0.50`, "error")
        else setBudget(ctx, usd)
        return
      }
      if (first === "handoff") {
        if (rest.length === 0) return showSettings(ctx)
        if (rest.length === 1 && (rest[0] === "on" || rest[0] === "off")) return setHandoff(ctx, rest[0] === "on")
        if (rest[0] === "threshold") {
          if (rest.length === 1) return pickHandoffThreshold(ctx)
          const usd = parseUsd(rest.slice(1).join(" "))
          if (usd !== undefined) return setHandoffThreshold(ctx, usd)
        }
        ctx.ui.notify("Use: /cache-guard handoff on | off | threshold <usd> (finite, nonnegative USD).", "error")
        return
      }
      if (isPlacement(first)) return setPlacement(ctx, first)
      ctx.ui.notify(`Unknown option "${first}". Use: history [filter], budget <usd>, handoff on | off | threshold <usd>, ${PLACEMENTS.join(", ")}.`, "error")
    },
  })

  /** Slash commands and shell commands do not reach the model; prompt templates and skills do. */
  const reachesModel = (text: string): boolean => {
    const trimmed = text.trimStart()
    if (trimmed.startsWith("!")) return false
    if (!trimmed.startsWith("/")) return true
    const name = trimmed.slice(1).split(/\s+/, 1)[0]
    return pi.getCommands().some((c) => c.name === name && (c.source === "prompt" || c.source === "skill"))
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI && storageBackups.length) {
      ctx.ui.notify(`Cache Guard kept the current settings and estimates. Conflicting legacy files were saved in: ${storageBackups.splice(0).join(", ")}. Stop old Pi processes if legacy files reappear.`, "warning")
    }
    learner.reset()
    current = ctx
    sessionId = ctx.sessionManager.getSessionId()
    if (timer) clearInterval(timer)
    timer = undefined
    if (ctx.hasUI) {
      timer = setInterval(tick, 1000)
      timer.unref?.()
    }
    refreshStatus()
  })

  pi.on("session_shutdown", () => {
    learner.reset()
    closeCorner()
    if (timer) clearInterval(timer)
    timer = undefined
    current = undefined
    sessionId = undefined
  })

  // Each event supplies the current context, not a command context retained from an old session.
  const updateContext = (_event: unknown, ctx: ExtensionContext) => {
    current = ctx
    refreshStatus()
  }
  const resetCacheContext = (event: unknown, ctx: ExtensionContext) => {
    learner.reset()
    updateContext(event, ctx)
  }
  pi.on("model_select", resetCacheContext)
  pi.on("thinking_level_select", resetCacheContext)
  pi.on("session_tree", resetCacheContext)
  pi.on("session_compact", resetCacheContext)
  pi.on("agent_start", updateContext)
  pi.on("agent_end", updateContext)

  // Native refreshes reuse provider callbacks but have no message_end and can
  // overlap a running turn. Drop the ambiguous learning sample until the next
  // normal turn rather than attach refresh counters to an assistant response.
  let observingNativeRefresh = false
  pi.on("turn_start", () => { observingNativeRefresh = false })
  pi.on("cache_warming_decision", () => {
    observingNativeRefresh = true
    learner.reset()
    // Notification only: never override Pi's warm/stop decision.
  })

  // Raw presence matters: normalized zeroes may mean the provider omitted the field.
  // These observers are read-only and never dispatch inference or modify messages.
  pi.on("before_provider_request", (event, ctx) => {
    // Native refreshes replay the request outside the agent lifecycle and have no
    // message_end. Do not mix their payload/counters into a normal learning anchor.
    if (observingNativeRefresh || ctx.isIdle()) { learner.reset(); return }
    if (ctx.model) learner.begin(event.payload, ctx.model, getRetention())
    else learner.reset()
  })
  pi.on("provider_stream_event", (event, ctx) => {
    if (!observingNativeRefresh && ctx.model?.provider === event.provider && ctx.model.id === event.model) learner.observe(event.api, event.data)
  })
  pi.on("message_end", (event) => {
    if (!observingNativeRefresh && event.message.role === "assistant") learner.finish(event.message)
  })

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || event.streamingBehavior || !ctx.hasUI) return { action: "continue" as const }
    if (!reachesModel(event.text)) return { action: "continue" as const }

    const pending = chooser.prepare(event, ctx)
    const proceed = () => chooser.continue(event, pending, ctx)
    const state = inspect(ctx)
    if (!state || state.status.state !== "cold" || state.tokens <= 0) return proceed()
    const { model, retention, tokens, status } = state
    const cost = coldCost(model, tokens, retention)
    if (cost <= budget) return proceed()

    const reason =
      status.expiredForMs === undefined ? "the model changed" : `the estimated window ended ${formatAgo(status.expiredForMs)}`
    const title =
      `Prompt cache may need rebuilding (${reason}). On a miss, this message re-sends ~${formatTokens(tokens)} tokens: ` +
      `~${formatUsd(cost)} instead of ~${formatUsd(warmCost(model, tokens))} with a full cache hit. This is an estimate.`

    const saved = chooser.offer(ctx)
    const send = `Continue with ${model.name} · estimated prompt/cache cost ~${formatUsd(cost)} (${model.provider}/${model.id})`
    const alternatives = new Map(
      scopedModelOptions(ctx.scopedModels.map((entry) => entry.model), tokens, retention)
        // The current model is already represented by Continue; never list it twice.
        .filter((alt) => alt.model.provider !== model.provider || alt.model.id !== model.id)
        .map((alt) => [
          `Switch to ${alt.model.provider}/${alt.model.id} · ~${formatUsd(alt.cost)}${alt.unavailable ? ` (${alt.unavailable})` : ""}`,
          alt,
        ]),
    )
    const cancel = "Cancel (keep text in editor)"

    let choice: string | undefined
    try {
      // Pi's standard selector has no disabled-row API. Keep unavailable models
      // visible, explain a blocked selection, and reopen without consuming input.
      while (true) {
        choice = await ctx.ui.select(title, [...(saved ? [saved.label] : []), send, ...alternatives.keys(), cancel])
        const unavailable = choice ? alternatives.get(choice)?.unavailable : undefined
        if (!unavailable) break
        ctx.ui.notify(`Cannot switch: ${unavailable}. Choose another option.`, "warning")
      }
    } catch {
      chooser.cancel(ctx, pending)
      return { action: "handled" as const }
    }
    if (choice === send) return proceed()
    if (saved && choice === saved.label) {
      chooser.replace(ctx, pending, saved.artifact)
      return { action: "handled" as const }
    }

    const alternative = choice ? alternatives.get(choice)?.model : undefined
    if (alternative) {
      try {
        if (await pi.setModel(alternative)) {
          const scoped = ctx.scopedModels.find((entry) => entry.model.provider === alternative.provider && entry.model.id === alternative.id)
          if (scoped?.thinkingLevel) pi.setThinkingLevel(scoped.thinkingLevel)
          return proceed()
        }
      } catch { /* Preserve the pending request on a failed model switch too. */ }
      ctx.ui.notify(`Could not switch to ${alternative.name}.`, "error")
    }
    chooser.cancel(ctx, pending)
    return { action: "handled" as const }
  })

  // Pi ignores the factory result; the harness uses this narrow service contract.
  return handoff
}
