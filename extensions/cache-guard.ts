import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"

import {
  cheaperModels,
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
import { sessionCostUsd } from "./handoff-scheduling.ts"
import { createHandoffChooser } from "./handoff-choice.ts"

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

/** Border colour of the corner box: RGB 39, 59, 72. */
const border = (s: string) => "\x1b[38;2;39;59;72m" + s + "\x1b[39m"

/** Draw text (visible width `width`) in a rounded box. */
function box(text: string, width: number): string[] {
  // Block characters sit flush with the cell edge; line-drawing glyphs sit mid-cell and leave a visible gap.
  const inner = width + 2
  return [
    border("▛" + "▀".repeat(inner) + "▜"),
    border("▌") + " " + text + " " + border("▐"),
    border("▙" + "▄".repeat(inner) + "▟"),
  ]
}

/** Progress bar of the remaining cache lifetime, for example `▰▰▰▰▰▰▱▱▱▱`. Returns the filled and empty parts. */
function bar(remainingMs: number, ttlMs: number): { filled: string; empty: string } {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.ceil((remainingMs / ttlMs) * BAR_WIDTH)))
  return { filled: "▰".repeat(filled), empty: "▱".repeat(BAR_WIDTH - filled) }
}

const isPlacement = (value: string): value is Placement => (PLACEMENTS as readonly string[]).includes(value)

const settingsPath = () => join(getAgentDir(), "cache-guard.json")

type Settings = { placement?: Placement; budgetUsd?: number; autoHandoff?: boolean; handoffThresholdUsd?: number }

function loadSettings(): Settings {
  try {
    if (!existsSync(settingsPath())) return {}
    const raw = JSON.parse(readFileSync(settingsPath(), "utf8"))
    const settings: Settings = {}
    if (typeof raw?.placement === "string" && isPlacement(raw.placement)) settings.placement = raw.placement
    if (typeof raw?.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 0) settings.budgetUsd = raw.budgetUsd
    if (typeof raw?.autoHandoff === "boolean") settings.autoHandoff = raw.autoHandoff
    if (typeof raw?.handoffThresholdUsd === "number" && Number.isFinite(raw.handoffThresholdUsd) && raw.handoffThresholdUsd >= 0) {
      settings.handoffThresholdUsd = raw.handoffThresholdUsd
    }
    return settings
  } catch {
    return {}
  }
}

function saveSettings(update: Settings) {
  writeFileSync(settingsPath(), JSON.stringify({ ...loadSettings(), ...update }, null, 2) + "\n")
}

const DEFAULT_HANDOFF_THRESHOLD_USD = 10
const DEFAULT_BUDGET_USD = 0.1
const BUDGET_PRESETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5]

/** Budget: saved setting, then PI_CACHE_GUARD_MIN_USD, then $0.10. A cold send up to the budget goes out without asking. */
function loadBudget(): number {
  const saved = loadSettings().budgetUsd
  if (saved !== undefined) return saved
  const env = process.env.PI_CACHE_GUARD_MIN_USD
  const value = env === undefined || env.trim() === "" ? NaN : Number(env)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BUDGET_USD
}

const describeBudget = (usd: number) => (usd === 0 ? "always ask" : `ask above ${formatUsd(usd)}`)

function inspect(ctx: ExtensionContext) {
  const model = ctx.model
  if (!model) return undefined
  const retention = getRetention()
  const hit = findLastCacheHit(ctx.sessionManager.getBranch())
  const status = getCacheStatus(model, hit, retention, Date.now())
  const tokens = ctx.getContextUsage()?.tokens ?? hit?.promptTokens ?? 0
  return { model, retention, hit, status, tokens }
}

export default function cacheGuardExtension(pi: ExtensionAPI, options: { handoff?: HandoffOptions } = {}) {
  const handoff = createHandoffService(pi, options.handoff)
  const chooser = createHandoffChooser(pi, handoff, options.handoff?.agentDir)
  let timer: ReturnType<typeof setInterval> | undefined
  let current: ExtensionContext | undefined
  let placement = loadSettings().placement ?? DEFAULT_PLACEMENT
  let budget = loadBudget()
  let autoHandoff = loadSettings().autoHandoff ?? false
  let handoffThreshold = loadSettings().handoffThresholdUsd ?? DEFAULT_HANDOFF_THRESHOLD_USD
  let sessionId: string | undefined
  type Corner = { text: string; width: number; close: () => void; tui?: { requestRender(): void } }
  let corner: Corner | undefined

  /** Top right overlay. It never takes keyboard focus; its width follows the text. */
  const showCorner = (ctx: ExtensionContext, text: string | undefined, width: number) => {
    if (corner) {
      corner.text = text ?? ""
      corner.width = width
      corner.tui?.requestRender()
      return
    }
    if (!text) return
    const state: Corner = { text, width, close: () => {} }
    corner = state
    void ctx.ui
      .custom<void>(
        (tui, _theme, _kb, done) => {
          state.tui = tui
          state.close = () => done()
          return { render: () => (state.text ? box(state.text, state.width) : []), invalidate() {} }
        },
        {
          overlay: true,
          overlayOptions: () => ({ anchor: "top-right", width: Math.max(1, state.width + 4), margin: { top: 1, right: 3 }, nonCapturing: true }),
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

  /** Show `text` at the chosen place and clear every other place. */
  const show = (ctx: ExtensionContext, text: string | undefined, width = 0) => {
    if (placement === "corner") showCorner(ctx, text, width)
    else closeCorner()
    ctx.ui.setStatus(STATUS_KEY, placement === "footer" ? text : undefined)
    ctx.ui.setWidget(STATUS_KEY, placement === "above" && text ? [text] : undefined, { placement: "aboveEditor" })
    ctx.ui.setWidget(`${STATUS_KEY}-below`, placement === "below" && text ? [text] : undefined, { placement: "belowEditor" })
  }

  const refreshStatus = () => {
    const ctx = current
    if (!ctx?.hasUI) return
    const state = inspect(ctx)
    if (!state || state.status.state === "none") {
      show(ctx, undefined)
      return
    }
    const { theme } = ctx.ui
    if (state.status.state === "warm") {
      const { remainingMs, ttlMs } = state.status
      const { filled, empty } = bar(remainingMs, ttlMs)
      const time = formatDuration(remainingMs)
      const color = remainingMs < WARN_BEFORE_EXPIRY_MS ? "warning" : "accent"
      const label = "◷ cache "
      const text = theme.fg(color, label + filled) + theme.fg("borderMuted", empty) + theme.fg(color, " " + time)
      show(ctx, text, label.length + BAR_WIDTH + 1 + time.length)
      return
    }
    const cost = state.tokens > 0 ? " · next ~" + formatUsd(coldCost(state.model, state.tokens, state.retention)) : ""
    const plain = "❄ cache cold" + cost
    show(ctx, theme.fg("error", plain), [...plain].length)
  }

  /** No queued deadline job: each tick uses current policy and cache state, never a cold catch-up.
   * This path is synchronous through start(), which persists the sole lifetime dispatch guard. */
  const scheduleHandoff = () => {
    const ctx = current
    if (!ctx || ctx.mode !== "tui" || !autoHandoff || ctx.sessionManager.getSessionId() !== sessionId) return
    const observed = inspect(ctx)
    if (!observed || observed.status.state !== "warm" || observed.status.remainingMs > WARN_BEFORE_EXPIRY_MS) return
    const leaf = ctx.sessionManager.getLeafId()
    if (handoff.getState(ctx) || sessionCostUsd(ctx.sessionManager.getEntries()) <= handoffThreshold) return
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return

    // Re-read after eligibility checks. A lifecycle/model/branch change must not use the old observation.
    const latest = inspect(ctx)
    if (current !== ctx || !autoHandoff || ctx.sessionManager.getSessionId() !== sessionId ||
        ctx.sessionManager.getLeafId() !== leaf || !latest || latest.model.provider !== observed.model.provider ||
        latest.model.id !== observed.model.id || latest.retention !== observed.retention || latest.hit?.at !== observed.hit?.at ||
        latest.status.state !== "warm" || latest.status.remainingMs > WARN_BEFORE_EXPIRY_MS ||
        sessionCostUsd(ctx.sessionManager.getEntries()) <= handoffThreshold) return
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

  const describeHandoff = () => `${autoHandoff ? "on" : "off"} · session total > ${formatUsd(handoffThreshold)}`

  const setHandoff = (ctx: ExtensionContext, enabled: boolean) => {
    autoHandoff = enabled
    save(ctx, { autoHandoff: enabled })
    ctx.ui.notify(enabled
      ? `Automatic handoff: on above ${formatUsd(handoffThreshold)} recorded session cost. Runs once near cache expiry; generation and tools incur costs. Warm cache is not guaranteed.`
      : "Automatic handoff: off.", "info")
  }

  const setHandoffThreshold = (ctx: ExtensionContext, usd: number) => {
    handoffThreshold = usd
    save(ctx, { handoffThresholdUsd: usd })
    ctx.ui.notify(`Automatic handoff threshold: recorded session total must exceed ${formatUsd(usd)}. Cold-send budget is unchanged.`, "info")
  }

  const pickHandoffThreshold = async (ctx: ExtensionContext) => {
    const typed = await ctx.ui.input("Automatic handoff: total session cost threshold in USD", String(handoffThreshold))
    if (typed === undefined) return
    const usd = parseUsd(typed)
    if (usd === undefined) ctx.ui.notify(`"${typed}" is not a valid amount.`, "error")
    else setHandoffThreshold(ctx, usd)
  }

  const pickHandoff = async (ctx: ExtensionContext) => {
    const on = "On · one automatic run; generation and tools incur costs"
    const off = "Off · no automatic generation"
    const threshold = `Threshold · session total > ${formatUsd(handoffThreshold)}`
    const picked = await ctx.ui.select(`Automatic handoff: ${describeHandoff()} (warm cache is not guaranteed)`, [on, off, threshold])
    if (picked === on) setHandoff(ctx, true)
    else if (picked === off) setHandoff(ctx, false)
    else if (picked === threshold) await pickHandoffThreshold(ctx)
  }

  const pickPlacement = async (ctx: ExtensionContext) => {
    const options = PLACEMENTS.map((p) => `${p} · ${PLACEMENT_HELP[p]}${p === placement ? " (current)" : ""}`)
    const picked = await ctx.ui.select("Cache countdown placement", options)
    const choice = picked?.split(" ", 1)[0]
    if (choice && isPlacement(choice)) setPlacement(ctx, choice)
  }

  const pickBudget = async (ctx: ExtensionContext) => {
    const amounts = [0, ...BUDGET_PRESETS]
    const label = (usd: number) => (usd === 0 ? "Always ask ($0)" : formatUsd(usd))
    const options = amounts.map((usd) => label(usd) + (usd === budget ? " (current)" : ""))
    const custom = "Custom amount…"
    const picked = await ctx.ui.select(`Cache budget: ask before a cold send above this cost (now ${describeBudget(budget)})`, [...options, custom])
    if (!picked) return
    if (picked === custom) {
      const typed = await ctx.ui.input("Budget in USD", "for example 0.50")
      if (typed === undefined) return
      const usd = parseUsd(typed)
      if (usd === undefined) ctx.ui.notify(`"${typed}" is not a valid amount.`, "error")
      else setBudget(ctx, usd)
      return
    }
    const usd = amounts[options.indexOf(picked)]
    if (usd !== undefined) setBudget(ctx, usd)
  }

  pi.registerCommand("cache-guard", {
    description: "Cache guard settings: budget <usd> | handoff on, off, threshold <usd> | above, below, corner, footer, off",
    getArgumentCompletions: (prefix) => {
      const [first = "", second] = prefix.trimStart().split(/\s+/, 2)
      if (second !== undefined || /\s$/.test(prefix)) {
        if (first === "handoff") {
          // Do not replace a threshold amount with its parent subcommand.
          if (/^handoff\s+\S+\s/.test(prefix.trimStart())) return null
          const typed = (second ?? "").toLowerCase()
          const items = [
            { value: "handoff on", label: "on", description: "enable one automatic handoff (incurs costs)" },
            { value: "handoff off", label: "off", description: "disable automatic handoff (default)" },
            { value: "handoff threshold", label: "threshold", description: `total session USD threshold (now ${formatUsd(handoffThreshold)})` },
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
        { value: "budget", label: "budget", description: `cost limit before asking (now ${describeBudget(budget)})` },
        { value: "handoff", label: "handoff", description: `automatic handoff (${describeHandoff()})` },
        ...PLACEMENTS.map((p) => ({ value: p, label: p, description: PLACEMENT_HELP[p] })),
      ].filter((item) => item.label.startsWith(first))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      const [first = "", ...rest] = args.trim().split(/\s+/)
      if (!first) {
        const placementItem = `Placement · ${PLACEMENT_HELP[placement]}`
        const budgetItem = `Budget · ${describeBudget(budget)}`
        const handoffItem = `Automatic handoff · ${describeHandoff()}`
        const picked = await ctx.ui.select("Cache guard settings", [budgetItem, placementItem, handoffItem])
        if (picked === budgetItem) await pickBudget(ctx)
        else if (picked === placementItem) await pickPlacement(ctx)
        else if (picked === handoffItem) await pickHandoff(ctx)
        return
      }
      if (first === "budget") {
        if (rest.length === 0) return pickBudget(ctx)
        const usd = parseUsd(rest.join(" "))
        if (usd === undefined) ctx.ui.notify(`"${rest.join(" ")}" is not a valid amount. Example: /cache-guard budget 0.50`, "error")
        else setBudget(ctx, usd)
        return
      }
      if (first === "handoff") {
        if (rest.length === 0) return pickHandoff(ctx)
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
      ctx.ui.notify(`Unknown option "${first}". Use: budget <usd>, handoff on | off | threshold <usd>, ${PLACEMENTS.join(", ")}.`, "error")
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
  pi.on("model_select", updateContext)
  pi.on("session_tree", updateContext)
  pi.on("session_compact", updateContext)
  pi.on("agent_start", updateContext)
  pi.on("agent_end", updateContext)

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
      status.expiredForMs === undefined ? "the model changed" : `it expired ${formatAgo(status.expiredForMs)}`
    const title =
      `Prompt cache is cold (${reason}). This message re-sends ~${formatTokens(tokens)} tokens: ` +
      `~${formatUsd(cost)} instead of ~${formatUsd(warmCost(model, tokens))} with a warm cache.`

    const saved = chooser.offer(ctx)
    const send = `Continue with ${model.name} · estimated prompt/cache cost ~${formatUsd(cost)}`
    const alternatives = new Map(
      cheaperModels(model, ctx.scopedModels.map((entry) => entry.model), tokens, retention).map((alt) => [
        `Switch to ${alt.model.provider}/${alt.model.id} · ~${formatUsd(alt.cost)}`,
        alt.model,
      ]),
    )
    const cancel = "Cancel (keep text in editor)"

    let choice: string | undefined
    try {
      choice = await ctx.ui.select(title, [...(saved ? [saved.label] : []), send, ...alternatives.keys(), cancel])
    } catch {
      chooser.cancel(ctx, pending)
      return { action: "handled" as const }
    }
    if (choice === send) return proceed()
    if (saved && choice === saved.label) {
      chooser.replace(ctx, pending, saved.artifact)
      return { action: "handled" as const }
    }

    const alternative = choice ? alternatives.get(choice) : undefined
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
