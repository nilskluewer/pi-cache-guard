import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

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

  const refreshStatus = () => {
    const ctx = current
    if (!ctx?.hasUI) return
    const state = inspect(ctx)
    if (!state || state.status.state === "none") {
      ctx.ui.setStatus(STATUS_KEY, undefined)
      return
    }
    const { theme } = ctx.ui
    if (state.status.state === "warm") {
      const color = state.status.remainingMs < WARN_BEFORE_EXPIRY_MS ? "warning" : "dim"
      ctx.ui.setStatus(STATUS_KEY, theme.fg(color, `⏳ cache ${formatDuration(state.status.remainingMs)}`))
      return
    }
    const cost = state.tokens > 0 ? ` · next ~${formatUsd(coldCost(state.model, state.tokens, state.retention))}` : ""
    ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", `❄ cache cold${cost}`))
  }

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
      cheaperModels(model, ctx.modelRegistry.getAvailable(), tokens, retention).map((alt) => [
        `Switch to ${alt.model.name} · ~${formatUsd(alt.cost)}`,
        alt.model,
      ]),
    )
    const cancel = "Cancel (keep text in editor)"

    const choice = await ctx.ui.select(title, [send, ...alternatives.keys(), cancel])
    if (choice === send) return { action: "continue" as const }

    const alternative = choice ? alternatives.get(choice) : undefined
    if (alternative) {
      if (await pi.setModel(alternative)) return { action: "continue" as const }
      ctx.ui.notify(`Could not switch to ${alternative.name}.`, "error")
    }
    ctx.ui.setEditorText(event.text)
    return { action: "handled" as const }
  })
}
