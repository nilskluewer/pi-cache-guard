import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync, closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"

export const HANDOFF_ENTRY_TYPE = "cache-guard.handoff"
export const HANDOFF_PROMPT = `Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS ($TMPDIR, else /tmp; %TEMP% on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.`

export type HandoffSource = { sessionId: string; sessionFile?: string; leafId: string | null }
/** completedLeafId is the post-generation baseline for later freshness checks. */
export type HandoffArtifact = {
  path: string; sha256: string; source: HandoffSource; createdAt: string; completedLeafId: string | null
}
type Run = { version: 1; runId: string; source: HandoffSource; startedAt: string }
export type HandoffState = Run & (
  | { status: "dispatched" }
  | { status: "ready"; artifact: HandoffArtifact; completedLeafId: string | null }
  | { status: "failed"; error: string }
)
/** Directory overrides for isolated tests; production uses the OS temp directory and getAgentDir(). */
export type HandoffOptions = { tempDir?: string; agentDir?: string }
export interface HandoffService {
  /** Caller owns scheduling policy. Rechecks idle/pending and the lifetime session guard.
   * True means dispatched, NOT saved; use getState/getAvailable to observe completion. */
  start(ctx: ExtensionContext): boolean
  /** Session-wide state, including entries on abandoned branches. No model-context messages. */
  getState(ctx: ExtensionContext): HandoffState | undefined
  /** Revalidates the private durable file; never returns an unverified or missing artifact. */
  getAvailable(ctx: ExtensionContext): HandoffArtifact | undefined
}

const MAX_BYTES = 8 * 1024 * 1024
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex")
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

/** Resolve existing parents too, so a not-yet-created directory cannot hide a workspace symlink. */
function canonical(path: string): string {
  const absolute = resolve(path)
  try { return realpathSync(absolute) } catch {
    const parent = dirname(absolute)
    return parent === absolute ? absolute : join(canonical(parent), basename(absolute))
  }
}

/** No symlinks, special files, empty output, or oversized reads. */
function readMarkdown(path: string): { body: Buffer; sha256: string; birthtimeMs: number } {
  if (extname(path).toLowerCase() !== ".md" || lstatSync(path).isSymbolicLink()) throw new Error("Not a regular Markdown file")
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) throw new Error("Empty, oversized, or non-regular handoff")
    const body = readFileSync(fd)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body)
    if (body.length > MAX_BYTES || !text.trim() || text.includes("\0")) throw new Error("Empty, binary, or oversized handoff")
    return { body, sha256: hash(body), birthtimeMs: stat.birthtimeMs }
  } finally {
    closeSync(fd)
  }
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

/** Paths must be named by this run's tools. Never search nearby temp files. */
function namedPaths(value: unknown, temp: string): string[] {
  const paths = new Set<string>()
  for (const raw of strings(value)) {
    const text = raw.replace(/\$\{TMPDIR\}|\$TMPDIR|%TEMP%/g, temp)
    if (isAbsolute(text) && extname(text).toLowerCase() === ".md") paths.add(resolve(text))
    // Quoted paths permit spaces. Unquoted shell/JS/Markdown paths stop at delimiters.
    for (const match of text.matchAll(/["'`]([^"'`\r\n]+\.md)["'`]|((?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|;(){}\[\],]+\.md)/gi)) {
      const path = match[1] ?? match[2]
      if (isAbsolute(path)) paths.add(resolve(path))
    }
  }
  return [...paths]
}

export function createHandoffService(pi: ExtensionAPI, options: HandoffOptions = {}): HandoffService {
  const temp = resolve(options.tempDir ?? (process.platform === "win32" ? process.env.TEMP ?? tmpdir() : process.env.TMPDIR || "/tmp"))
  const durableDir = join(resolve(options.agentDir ?? getAgentDir()), "handoffs")
  const memory = new Map<string, HandoffState>()
  type Active = {
    state: HandoffState; started: boolean; evidence: Map<string, string>; existingTempNames: Set<string>
    calls: Map<string, Map<string, string | undefined>>
  }
  let active: Active | undefined
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined
  const clearConfirmation = () => {
    if (confirmationTimer) clearTimeout(confirmationTimer)
    confirmationTimer = undefined
  }

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "error") => ctx.ui.notify(message, level)
  const getState = (ctx: ExtensionContext): HandoffState | undefined => {
    const id = ctx.sessionManager.getSessionId()
    let state = memory.get(id)
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== HANDOFF_ENTRY_TYPE) continue
      const data = entry.data as HandoffState | undefined
      if (data?.version === 1 && data.source?.sessionId === id && typeof data.runId === "string" &&
          ["dispatched", "ready", "failed"].includes(data.status)) state = data
    }
    // A local failure to persist must not expose an earlier successful state.
    return memory.get(id)?.status === "failed" ? memory.get(id) : state
  }
  const persist = (state: HandoffState) => {
    memory.set(state.source.sessionId, state)
    pi.appendEntry(HANDOFF_ENTRY_TYPE, state)
  }
  const fail = (ctx: ExtensionContext, state: HandoffState, reason: string) => {
    clearConfirmation()
    active = undefined
    const failed: HandoffState = { ...state, status: "failed", error: reason }
    try { persist(failed) } catch { memory.set(state.source.sessionId, failed) }
    notify(ctx, `Handoff failed: ${reason}. No automatic retry.`, "error")
  }
  const belongs = (ctx: ExtensionContext) => active?.state.source.sessionId === ctx.sessionManager.getSessionId()
  const tempPath = (ctx: ExtensionContext, path: string) => {
    try {
      const real = realpathSync(path)
      return within(realpathSync(temp), real) && !within(canonical(ctx.cwd), real)
    } catch { return false }
  }

  const service: HandoffService = {
    getState,
    getAvailable(ctx) {
      const state = getState(ctx)
      if (state?.status !== "ready") return undefined
      try {
        const path = state.artifact.path
        if (!within(realpathSync(durableDir), realpathSync(path)) || within(canonical(ctx.cwd), realpathSync(path))) return undefined
        if (readMarkdown(path).sha256 !== state.artifact.sha256) return undefined
        return state.artifact
      } catch { return undefined }
    },
    start(ctx) {
      if (active || getState(ctx) || !ctx.model || !ctx.isIdle() || ctx.hasPendingMessages()) return false
      const state: HandoffState = {
        version: 1, runId: randomUUID(), status: "dispatched", startedAt: new Date().toISOString(),
        source: { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId() },
      }
      try {
        // Only inventory names, never copy nearby files. Output-only fallback must not adopt an existing file.
        const existingTempNames = new Set(readdirSync(temp))
        persist(state) // Guard BEFORE dispatch. Failure here spends nothing.
        active = { state, started: false, evidence: new Map(), calls: new Map(), existingTempNames }
        // The void Pi API reports async rejection itself. Bound the wait for lifecycle confirmation too.
        confirmationTimer = setTimeout(() => {
          if (active?.state.runId === state.runId && belongs(ctx)) fail(ctx, state, "Dispatch was not confirmed within 30 seconds")
        }, 30_000)
        confirmationTimer.unref?.()
        pi.sendUserMessage(HANDOFF_PROMPT, { expandPromptTemplates: false })
        return true
      } catch (error) {
        fail(ctx, state, error instanceof Error ? error.message : String(error))
        return false
      }
    },
  }

  pi.on("session_start", (_event, ctx) => {
    clearConfirmation()
    active = undefined
    const state = getState(ctx)
    if (state?.status === "dispatched") fail(ctx, state, "Previous generation was interrupted or dispatch was not confirmed")
  })
  pi.on("session_shutdown", (_event, ctx) => {
    clearConfirmation()
    if (active && belongs(ctx)) fail(ctx, active.state, "Generation interrupted by session shutdown")
    active = undefined
  })
  pi.on("session_tree", (_event, ctx) => {
    if (active && belongs(ctx)) fail(ctx, active.state, "Conversation branch changed during generation")
  })
  pi.on("before_agent_start", (event, ctx) => {
    if (!active || !belongs(ctx)) return
    if (event.prompt !== HANDOFF_PROMPT || active.started) {
      fail(ctx, active.state, "Another request interrupted generation")
      return
    }
    clearConfirmation()
    active.started = true
  })
  pi.on("tool_call", (event, ctx) => {
    if (!active?.started || !belongs(ctx)) return
    const before = new Map<string, string | undefined>()
    for (const path of namedPaths(event.input, temp)) {
      try { before.set(path, readMarkdown(path).sha256) } catch { before.set(path, undefined) }
    }
    active.calls.set(event.toolCallId, before)
  })
  pi.on("tool_result", (event, ctx) => {
    if (!active?.started || !belongs(ctx)) return
    const before = active.calls.get(event.toolCallId)
    active.calls.delete(event.toolCallId)
    if (!before || event.isError || !["write", "edit", "bash", "powershell", "codemode"].includes(event.toolName)) return
    for (const path of new Set([...before.keys(), ...namedPaths(event.content, temp)])) {
      if (!tempPath(ctx, path)) continue
      try {
        const file = readMarkdown(path)
        // Named before execution: must have changed. Output-only fallback is limited to new files in the temp root.
        // Birth time alone cannot distinguish a pre-existing file in the same clock millisecond.
        const newlyCreated = canonical(dirname(path)) === canonical(temp) && !active.existingTempNames.has(basename(path)) &&
          file.birthtimeMs >= Date.parse(active.state.startedAt)
        const changed = before.has(path) ? file.sha256 !== before.get(path) : newlyCreated
        if (changed) active.evidence.set(path, file.sha256)
      } catch { /* A path mention is not success. */ }
    }
  })
  pi.on("agent_end", (event, ctx) => {
    if (!active || !belongs(ctx)) return
    const run = active
    clearConfirmation()
    active = undefined
    const last = event.messages.filter((message) => message.role === "assistant").at(-1)
    if (!run.started || !last || last.stopReason === "error" || last.stopReason === "aborted") {
      fail(ctx, run.state, "Generation failed or was aborted")
      return
    }
    let published: string | undefined
    let staging: string | undefined
    try {
      const verified = [...run.evidence].flatMap(([path, sha256]) => {
        try {
          const file = readMarkdown(path)
          return tempPath(ctx, path) && file.sha256 === sha256 ? [file] : []
        } catch { return [] }
      })
      if (verified.length !== 1) throw new Error(verified.length ? "Multiple verified outputs; cannot identify the handoff" : "No verified nonempty temporary Markdown output")
      const workspace = canonical(ctx.cwd)
      if (within(workspace, canonical(durableDir))) throw new Error("Durable handoff directory is inside the workspace")
      mkdirSync(durableDir, { recursive: true, mode: 0o700 })
      if (lstatSync(durableDir).isSymbolicLink()) throw new Error("Durable handoff directory is a symlink")
      if (within(workspace, realpathSync(durableDir))) throw new Error("Durable handoff directory is inside the workspace")
      chmodSync(durableDir, 0o700)
      const createdAt = new Date().toISOString()
      const completedLeafId = ctx.sessionManager.getLeafId()
      const source = run.state.source
      const metadata = {
        source_session_id: source.sessionId, ...(source.sessionFile ? { source_session_file: source.sessionFile } : {}),
        source_leaf_id: source.leafId, created_at: createdAt,
      }
      // JSON-quoted scalars are valid YAML 1.2; never interpolate unescaped metadata.
      const header = "---\n" + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join("") + "---\n"
      const body = Buffer.concat([Buffer.from(header), verified[0].body])
      const path = join(durableDir, `${run.state.runId}.md`)
      const stagingPath = join(durableDir, `${run.state.runId}.partial`)
      const fd = openSync(stagingPath, "wx", 0o600)
      staging = stagingPath // Cleanup owns this file only after the exclusive open succeeds.
      try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
      linkSync(staging, path) // Atomic exclusive publication; never overwrite an existing file.
      published = path
      unlinkSync(staging)
      staging = undefined
      const sha256 = hash(body)
      if (readMarkdown(path).sha256 !== sha256) throw new Error("Durable file verification failed")
      const artifact: HandoffArtifact = { path, sha256, source, createdAt, completedLeafId }
      persist({ ...run.state, status: "ready", artifact, completedLeafId })
      notify(ctx, `Handoff saved: ${path}`, "info")
    } catch (error) {
      for (const path of [staging, published]) {
        if (path) { try { unlinkSync(path) } catch { /* Never remove unrelated files. */ } }
      }
      fail(ctx, run.state, error instanceof Error ? error.message : String(error))
    }
  })
  return service
}
