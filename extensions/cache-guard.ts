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
  warmCost,
} from "./cache-guard-logic.ts"

export * from "./cache-guard-logic.ts"

const STATUS_KEY = "cache-guard"
const WARN_BEFORE_EXPIRY_MS = 60_000

const PLACEMENTS = ["above", "below", "footer", "off"] as const
type Placement = (typeof PLACEMENTS)[number]
const DEFAULT_PLACEMENT: Placement = "above"
const PLACEMENT_HELP: Record<Placement, string> = {
  above: "above the editor",
  below: "below the editor",
  footer: "footer status line (can be hidden by long statuses)",
  off: "hidden",
}
const isPlacement = (value: string): value is Placement => (PLACEMENTS as readonly string[]).includes(value)

const settingsPath = () => join(getAgentDir(), "cache-guard.json")

function loadPlacement(): Placement {
  try {
    if (existsSync(settingsPath())) {
      const value = JSON.parse(readFileSync(settingsPath(), "utf8"))?.placement
      if (typeof value === "string" && isPlacement(value)) return value
    }
  } catch {}
  return DEFAULT_PLACEMENT
}

function savePlacement(placement: Placement) {
  writeFileSync(settingsPath(), JSON.stringify({ placement }, null, 2) + "\n")
}

/** Ask before a cold send that costs at least this much. Override with PI_CACHE_GUARD_MIN_USD. */
function minUsd(): number {
  const value = Number(process.env.PI_CACHE_GUARD_MIN_USD)
  return Number.isFinite(value) && value >= 0 ? value : 0.1
}

function inspect(ctx: ExtensionContext) {
  const model = ctx.model
  if (!model) return undefined
  const retention = getRetention()
  const hit = findLastCacheHit(ctx.sessionManager.getBranch())
  const status = getCacheStatus(model, hit, retention, Date.now())
  const tokens = ctx.getContextUsage()?.tokens ?? hit?.promptTokens ?? 0
  return { model, retention, hit, status, tokens }
}

export default function cacheGuardExtension(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined
  let current: ExtensionContext | undefined
  let placement = loadPlacement()

  /** Show `text` at the chosen place and clear every other place. */
  const show = (ctx: ExtensionContext, text: string | undefined) => {
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
      const color = state.status.remainingMs < WARN_BEFORE_EXPIRY_MS ? "warning" : "dim"
      show(ctx, theme.fg(color, `⏳ cache ${formatDuration(state.status.remainingMs)}`))
      return
    }
    const cost = state.tokens > 0 ? ` · next ~${formatUsd(coldCost(state.model, state.tokens, state.retention))}` : ""
    show(ctx, theme.fg("dim", `❄ cache cold${cost}`))
  }

  pi.registerCommand("cache-guard", {
    description: "Choose where the cache countdown is shown: above, below, footer, off",
    getArgumentCompletions: (prefix) => {
      const items = PLACEMENTS.filter((p) => p.startsWith(prefix.trim())).map((p) => ({ value: p, label: p, description: PLACEMENT_HELP[p] }))
      return items.length ? items : null
    },
    handler: async (args, ctx) => {
      let choice = args.trim()
      if (!choice) {
        const options = PLACEMENTS.map((p) => `${p} · ${PLACEMENT_HELP[p]}${p === placement ? " (current)" : ""}`)
        const picked = await ctx.ui.select("Cache countdown placement", options)
        choice = picked?.split(" ", 1)[0] ?? ""
        if (!choice) return
      }
      if (!isPlacement(choice)) {
        ctx.ui.notify(`Unknown placement "${choice}". Use: ${PLACEMENTS.join(", ")}.`, "error")
        return
      }
      placement = choice
      try {
        savePlacement(choice)
      } catch {
        ctx.ui.notify("Could not save the setting. It applies to this session only.", "warning")
      }
      current = ctx
      refreshStatus()
      ctx.ui.notify(`Cache countdown: ${PLACEMENT_HELP[choice]}.`, "info")
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
    if (timer) clearInterval(timer)
    if (ctx.hasUI) {
      timer = setInterval(refreshStatus, 1000)
      timer.unref?.()
    }
    refreshStatus()
  })

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer)
    timer = undefined
    current = undefined
  })

  pi.on("model_select", (_event, ctx) => {
    current = ctx
    refreshStatus()
  })

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || event.streamingBehavior || !ctx.hasUI) return { action: "continue" as const }
    if (!reachesModel(event.text)) return { action: "continue" as const }

    const state = inspect(ctx)
    if (!state || state.status.state !== "cold" || state.tokens <= 0) return { action: "continue" as const }
    const { model, retention, tokens, status } = state
    const cost = coldCost(model, tokens, retention)
    if (cost < minUsd()) return { action: "continue" as const }

    const reason =
      status.expiredForMs === undefined ? "the model changed" : `it expired ${formatAgo(status.expiredForMs)}`
    const title =
      `Prompt cache is cold (${reason}). This message re-sends ~${formatTokens(tokens)} tokens: ` +
      `~${formatUsd(cost)} instead of ~${formatUsd(warmCost(model, tokens))} with a warm cache.`

    const send = `Send with ${model.name} · ~${formatUsd(cost)}`
    const alternatives = new Map(
      cheaperModels(model, ctx.scopedModels.map((entry) => entry.model), tokens, retention).map((alt) => [
        `Switch to ${alt.model.provider}/${alt.model.id} · ~${formatUsd(alt.cost)}`,
        alt.model,
      ]),
    )
    const cancel = "Cancel (keep text in editor)"

    const choice = await ctx.ui.select(title, [send, ...alternatives.keys(), cancel])
    if (choice === send) return { action: "continue" as const }

    const alternative = choice ? alternatives.get(choice) : undefined
    if (alternative) {
      if (await pi.setModel(alternative)) {
        const scoped = ctx.scopedModels.find((entry) => entry.model.provider === alternative.provider && entry.model.id === alternative.id)
        if (scoped?.thinkingLevel) pi.setThinkingLevel(scoped.thinkingLevel)
        return { action: "continue" as const }
      }
      ctx.ui.notify(`Could not switch to ${alternative.name}.`, "error")
    }
    ctx.ui.setEditorText(event.text)
    return { action: "handled" as const }
  })
}
