import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type InputEvent, type SessionEntry } from "@earendil-works/pi-coding-agent"
import type { HandoffArtifact, HandoffService } from "./handoff.ts"

const BRIDGE = "cache-guard-resume"
type Pending = Pick<InputEvent, "text" | "images">
type Draft = { sessionId: string; pending: Pending | null }

const meaningful = (entry: SessionEntry) =>
  entry.type === "message" ? entry.message.role !== "system" :
    ["custom_message", "compaction", "branch_summary", "context_edit"].includes(entry.type)

/** Compare conversation paths, not leaf equality: generation and extension metadata are not work. */
function isOlder(ctx: ExtensionContext, artifact: HandoffArtifact): boolean {
  const baseline = artifact.completedLeafId ? ctx.sessionManager.getBranch(artifact.completedLeafId) : []
  if (artifact.completedLeafId && !baseline.some((e) => e.id === artifact.completedLeafId)) return true
  const sourceIndex = baseline.findIndex((entry) => entry.id === artifact.source.leafId)
  if (artifact.source.leafId && sourceIndex < 0) return true
  const generation = new Set(baseline.slice(sourceIndex + 1).map((entry) => entry.id))
  const before = new Set(baseline.filter(meaningful).filter((e) => !generation.has(e.id)).map((e) => e.id))
  const now = new Set(ctx.sessionManager.getBranch().filter(meaningful).filter((e) => !generation.has(e.id)).map((e) => e.id))
  return before.size !== now.size || [...before].some((id) => !now.has(id))
}

/** Pi mutates its branch before writing JSONL. Memory membership (or a resolved send)
 * is not a persistence receipt. Check complete lines, including image data, only at
 * acceptance boundaries. A file-less or unreadable session cannot prove durability. */
function persisted(ctx: ExtensionContext, entries: SessionEntry[]): boolean {
  const path = ctx.sessionManager.getSessionFile()
  if (!path || !entries.length) return false
  try {
    const lines = readFileSync(path, "utf8").split("\n")
    lines.pop() // A partial final line is not a completed Pi append.
    const header = JSON.parse(lines[0])
    return header.type === "session" && header.id === ctx.sessionManager.getSessionId() &&
      entries.every((entry) => lines.includes(JSON.stringify(entry)))
  } catch { return false }
}

/** The command bridge is the only session-replacement boundary. Never retain a command context. */
export function createHandoffChooser(pi: ExtensionAPI, handoff: HandoffService, agentDir = getAgentDir()) {
  const transitions = new Map<string, { sessionId: string; pending: Pending; artifact: HandoffArtifact }>()
  const memoryDrafts = new Map<string, Pending>()
  const draftsDir = join(agentDir, "cache-guard-drafts")
  const draftPath = (sessionId: string) => join(draftsDir, createHash("sha256").update(sessionId).digest("hex") + ".json")
  const readDraft = (ctx: ExtensionContext): Pending | undefined => {
    const sessionId = ctx.sessionManager.getSessionId?.()
    if (!sessionId) return undefined
    if (memoryDrafts.has(sessionId)) return memoryDrafts.get(sessionId)
    try {
      const draft = JSON.parse(readFileSync(draftPath(sessionId), "utf8")) as Draft
      return draft.sessionId === sessionId && typeof draft.pending?.text === "string" ? draft.pending : undefined
    } catch { return undefined }
  }
  const saveDraft = (ctx: ExtensionContext, pending: Pending | null) => {
    const sessionId = ctx.sessionManager.getSessionId?.()
    if (!sessionId) return true
    if (pending) memoryDrafts.set(sessionId, pending)
    else memoryDrafts.delete(sessionId)
    try {
      if (!pending) { rmSync(draftPath(sessionId), { force: true }); return true }
      mkdirSync(draftsDir, { recursive: true, mode: 0o700 })
      const staging = join(draftsDir, randomUUID() + ".partial")
      let owned = false
      try {
        writeFileSync(staging, JSON.stringify({ sessionId, pending } satisfies Draft), { flag: "wx", mode: 0o600 })
        owned = true
        renameSync(staging, draftPath(sessionId))
      } finally { if (owned) rmSync(staging, { force: true }) }
      return true
    } catch {
      ctx.ui.notify("Could not save recovery data. Keep this session open; images are retained in memory only.", "error")
      return false
    }
  }
  const restore = (ctx: ExtensionContext, pending: Pending) => {
    const saved = saveDraft(ctx, pending)
    ctx.ui.setEditorText(pending.text)
    if (pending.images?.length && saved) ctx.ui.notify("Images retained for the next model-bound input (including after reload).", "info")
    return saved
  }
  type Acceptance = { pending: Pending; prompt?: string; message?: unknown }
  const accepting = new Map<string, Acceptance>()
  pi.on("before_agent_start", (event, ctx) => {
    const attempt = accepting.get(ctx.sessionManager.getSessionId())
    if (!attempt) return
    // Capture template/skill expansion, but do not consume the draft: image processing
    // and user-message persistence still follow this hook.
    if (JSON.stringify(event.images ?? []) !== JSON.stringify(attempt.pending.images ?? [])) return
    attempt.prompt = event.prompt
  })
  pi.on("message_end", (event, ctx) => {
    const attempt = accepting.get(ctx.sessionManager.getSessionId())
    if (attempt?.prompt === undefined || event.message.role !== "user") return
    const text = typeof event.message.content === "string" ? event.message.content :
      event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
    // Pi can append image-normalization hints to the expanded prompt.
    if (text === attempt.prompt || text.startsWith(attempt.prompt + "\n\n")) attempt.message = event.message
  })
  const clearAccepted = (_event: unknown, ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId()
    const attempt = accepting.get(id)
    if (!attempt?.message) return
    // message_end handlers precede appendMessage; appendMessage can then fail AFTER
    // adding the entry in memory. Confirm this exact message, including images, on disk.
    const entry = ctx.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message === attempt.message)
    if (!entry || !persisted(ctx, [entry])) return
    accepting.delete(id)
    if (JSON.stringify(readDraft(ctx)) === JSON.stringify(attempt.pending)) saveDraft(ctx, null)
  }
  pi.on("turn_end", clearAccepted)
  pi.on("agent_end", clearAccepted)
  pi.on("agent_settled", clearAccepted)
  pi.on("session_start", (_event, ctx) => {
    accepting.delete(ctx.sessionManager.getSessionId())
    if (!ctx.hasUI) return
    const pending = readDraft(ctx)
    if (!pending) return
    if (!ctx.ui.getEditorText?.().trim()) ctx.ui.setEditorText(pending.text)
    if (pending.images?.length) ctx.ui.notify("Recovered pending request. Images will follow the next model-bound input.", "info")
  })

  const available = (ctx: ExtensionContext) => {
    // Incomplete contexts (for example older hosts) cannot offer a replacement.
    try { return handoff.getAvailable(ctx) } catch { return undefined }
  }

  pi.registerCommand(BRIDGE, {
    description: "Internal Cache Guard session-choice bridge (no handoff generation)",
    handler: async (token, ctx) => {
      const transition = transitions.get(token)
      transitions.delete(token) // Consume before any await: duplicate invocation cannot send twice.
      if (!transition) return
      const { pending, artifact, sessionId } = transition
      if (ctx.sessionManager.getSessionId() !== sessionId) {
        ctx.ui.notify("The source session changed. The pending request remains saved in that session.", "warning")
        return
      }
      let replaced = false
      try {
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Session is busy")
        const verified = available(ctx)
        if (!verified || verified.path !== artifact.path || verified.sha256 !== artifact.sha256) throw new Error("Saved handoff is no longer available")
        const body = readFileSync(verified.path, "utf8")
        if (createHash("sha256").update(body).digest("hex") !== verified.sha256) throw new Error("Saved handoff changed")
        // All source-session data is captured before replacement invalidates ctx and pi.
        const parentSession = ctx.sessionManager.getSessionFile()
        const content = [{ type: "text" as const, text: pending.text }, ...(pending.images ?? [])]
        const result = await ctx.newSession({
          parentSession,
          withSession: async (fresh) => {
            replaced = true
            const before = new Set(fresh.sessionManager.getBranch().map((entry) => entry.id))
            try {
              await fresh.sendMessage({ customType: "cache-guard.handoff-context", content: body, display: true }, { triggerTurn: false })
              // Expand the pending request on its own, so skill/template commands retain their meaning.
              await fresh.sendUserMessage(content, { expandPromptTemplates: true })
            } catch (error) {
              // No use of the stale source ctx. Roll back using the supported fresh command boundary.
              if (parentSession) {
                const rollback = await fresh.switchSession(parentSession, { withSession: async (source) => { restore(source, pending) } })
                if (!rollback.cancelled) return
              }
              // File-less sessions have no resumable parent. Keep handoff + request in the fresh draft.
              restore(fresh, { ...pending, text: `## Saved handoff\n\n${body}\n\n## Pending request\n\n${pending.text}` })
              fresh.ui.notify(`Could not send the request: ${String(error)}. Draft retained.`, "error")
              return
            }
            // A send can resolve after input was handled without a user message, or
            // with only in-memory state. Verify the new request and handoff on disk.
            const added = fresh.sessionManager.getBranch().filter((entry) => !before.has(entry.id))
            const user = added.find((entry) => entry.type === "message" && entry.message.role === "user")
            const context = added.find((entry) => entry.type === "custom_message" &&
              entry.customType === "cache-guard.handoff-context" && entry.content === body)
            if (!user || !context || !persisted(fresh, [user, context])) {
              fresh.ui.notify("Destination request is not confirmed on disk. The source recovery draft was retained.", "warning")
              return
            }
            // Source ctx/pi are invalid. Clear recovery data using only the captured session ID.
            memoryDrafts.delete(sessionId)
            try { rmSync(draftPath(sessionId), { force: true }) } catch {
              fresh.ui.notify("Request sent, but the source recovery draft could not be cleared.", "warning")
            }
          },
        })
        if (result.cancelled) restore(ctx, pending)
      } catch (error) {
        // Pi tears down the source before runtime creation. If it fails there, ctx can already be
        // stale; the pre-switch private draft still protects the request when resuming the source.
        if (!replaced) {
          try { restore(ctx, pending); ctx.ui.notify(`Could not start the handoff session: ${String(error)}. Draft retained.`, "error") } catch { /* source draft was saved before dispatch */ }
        }
      }
    },
  })

  return {
    prepare(event: InputEvent, ctx: ExtensionContext): Pending {
      const draft = readDraft(ctx)
      const images = [...(draft?.images ?? []), ...(event.images ?? [])]
      const unique = images.filter((image, index) => images.findIndex((other) => other.data === image.data && other.mimeType === image.mimeType) === index)
      return { text: event.text, ...(unique.length ? { images: unique } : {}) }
    },
    continue(event: InputEvent, pending: Pending, ctx: ExtensionContext) {
      if (readDraft(ctx)) {
        // Keep edited text and merged images recoverable if preflight rejects the send.
        saveDraft(ctx, pending)
        accepting.set(ctx.sessionManager.getSessionId(), { pending })
      }
      return JSON.stringify(event.images ?? []) === JSON.stringify(pending.images ?? []) ?
        { action: "continue" as const } : { action: "transform" as const, ...pending }
    },
    offer(ctx: ExtensionContext) {
      const artifact = available(ctx)
      if (!artifact) return undefined
      return { artifact, label: `New session with saved handoff · ${artifact.createdAt}${isOlder(ctx, artifact) ? " · older state: later or different branch work is not included" : ""}` }
    },
    cancel: restore,
    replace(ctx: ExtensionContext, pending: Pending, artifact: HandoffArtifact) {
      // Save text AND images before dispatch; survives cancellation, reload, or runtime failure.
      if (!restore(ctx, pending)) return // Do not replace a session without a durable recovery draft.
      const token = randomUUID()
      transitions.set(token, { sessionId: ctx.sessionManager.getSessionId(), pending, artifact })
      try { pi.sendUserMessage(`/${BRIDGE} ${token}`, { expandPromptTemplates: true }) } catch (error) {
        transitions.delete(token)
        ctx.ui.notify(`Could not dispatch session choice: ${String(error)}. Draft retained.`, "error")
      }
    },
  }
}
