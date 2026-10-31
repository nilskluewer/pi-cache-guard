import {
  chmodSync, closeSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

export const cacheGuardDir = (agentDir: string): string => join(resolve(agentDir), "cache-guard")

const legacyFiles = [
  ["cache-guard.json", "settings.json"],
  ["cache-guard-estimates.json", "estimates.json"],
  ["cache-guard-observations.jsonl.1", "observations.jsonl.1"],
  ["cache-guard-observations.jsonl", "observations.jsonl"],
] as const

function stat(path: string) {
  try { return lstatSync(path) } catch (error: any) { if (error.code !== "ENOENT") throw error }
}
function directory(path: string): void {
  const st = stat(path)
  if (!st?.isDirectory() || st.isSymbolicLink()) throw new Error(`Not a regular directory: ${path}`)
}
function sameFile(a: NonNullable<ReturnType<typeof stat>>, b: NonNullable<ReturnType<typeof stat>>) {
  return a.dev === b.dev && a.ino === b.ino
}

/** Exclusive publication followed by unlink. A crash between these operations is retryable. */
function moveFile(source: string, target: string): void {
  const from = stat(source)
  if (!from) return
  const to = stat(target)
  if (!from.isFile() || from.isSymbolicLink() || from.nlink !== (to && sameFile(from, to) ? 2 : 1))
    throw new Error(`Unsafe legacy file: ${source}`)
  if (to && (!to.isFile() || !sameFile(from, to))) throw new Error(`Storage conflict; both files were kept: ${source} and ${target}`)
  if (!to) linkSync(source, target) // EEXIST is atomic: never overwrite another writer.
  unlinkSync(source)
  chmodSync(target, 0o600)
}

/** A running older version may recreate legacy files after migration. Keep the
 * current layout authoritative and archive the complete incoming file group so
 * settings, salts and observations are never overwritten or mixed. */
function migrateFiles(sourceDir: string, dir: string, onBackup: (path: string) => void): void {
  const incoming = legacyFiles.filter(([name]) => stat(join(sourceDir, name)))
  if (!incoming.length) return
  const remaining = incoming.filter(([oldName, name]) => {
    const source = join(sourceDir, oldName), from = stat(source)!, to = stat(join(dir, name))
    if (!from.isFile() || from.isSymbolicLink() || from.nlink !== (to && sameFile(from, to) ? 2 : 1))
      throw new Error(`Unsafe legacy file: ${source}`)
    if (to && sameFile(from, to)) { moveFile(source, join(dir, name)); return false }
    return true
  })
  // Treat all telemetry as one salt domain, even if an incoming or current
  // generation is incomplete. Never pair another generation's logs and salt.
  const telemetryConflict = legacyFiles.slice(1).some(([, name]) => stat(join(dir, name)))
  let snapshot: string | undefined
  for (const [oldName, name] of remaining) {
    const source = join(sourceDir, oldName), target = join(dir, name)
    const conflict = name === "settings.json" ? !!stat(target) : telemetryConflict
    if (!conflict) { moveFile(source, target); continue }
    if (!snapshot) {
      const backups = join(dir, "legacy")
      try { mkdirSync(backups, { mode: 0o700 }) } catch (error: any) { if (error.code !== "EEXIST") throw error }
      directory(backups)
      chmodSync(backups, 0o700)
      snapshot = mkdtempSync(join(backups, "import-"))
    }
    // The target lives in our freshly created, private, unique directory.
    // Atomic rename has no link/unlink interruption window to recover from.
    chmodSync(source, 0o600)
    renameSync(source, join(snapshot, oldName))
  }
  if (snapshot) onBackup(snapshot)
}

/** Generic handoffs/ may belong to another extension. Adopt only our generated format. */
function ownedHandoffs(path: string): boolean {
  directory(path)
  return readdirSync(path).every(name => {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.(?:md|partial)$/i.test(name)) return false
    const file = join(path, name), st = stat(file)
    if (!st?.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 8 * 1024 * 1024) return false
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const body = readFileSync(fd, "utf8")
      const header = /^---\n([\s\S]*?)\n---\n/.exec(body)?.[1]
      if (!header) return false
      const fields = Object.fromEntries(header.split("\n").map(line => {
        const colon = line.indexOf(":")
        return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))]
      }))
      return typeof fields.source_session_id === "string" && fields.source_session_id.length > 0
        && (fields.source_leaf_id === null || typeof fields.source_leaf_id === "string")
        && typeof fields.created_at === "string" && Number.isFinite(Date.parse(fields.created_at))
    } catch { return false } finally { closeSync(fd) }
  })
}

/** Move the directory, retaining old absolute artifact paths via one compatibility link.
 * The marker precedes rename so an interrupted migration can recreate the link next start. */
function migrateHandoffs(agentDir: string, dir: string): void {
  const source = join(agentDir, "handoffs"), target = join(dir, "handoffs")
  const marker = join(dir, ".legacy-handoffs")
  const from = stat(source), to = stat(target)
  if (from?.isSymbolicLink()) {
    if (resolve(dirname(source), readlinkSync(source)) !== target) throw new Error(`Unexpected handoff link: ${source}`)
    directory(target)
    return
  }
  if (from) {
    if (!ownedHandoffs(source)) return // Leave unrelated files and their directory untouched.
    if (to) throw new Error(`Storage conflict; both handoff directories were kept: ${source} and ${target}`)
    if (!stat(marker)) closeSync(openSync(marker, "wx", 0o600))
    renameSync(source, target)
    chmodSync(target, 0o700)
  }
  if (stat(marker)) {
    const st = stat(marker)!
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error(`Unsafe migration marker: ${marker}`)
    directory(target)
    symlinkSync(process.platform === "win32" ? target : relative(agentDir, target), source, process.platform === "win32" ? "junction" : "dir")
  }
}

/** Synchronous startup migration, before any settings, learner or recovery state is read.
 * All writers in this version use dir. Old Pi processes must be stopped before upgrade. */
export function migrateCacheGuardStorage(agentRoot: string, onBackup: (path: string) => void = () => {}): string {
  const agentDir = resolve(agentRoot), dir = cacheGuardDir(agentDir)
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  try { mkdirSync(dir, { mode: 0o700 }) } catch (error: any) { if (error.code !== "EEXIST") throw error }
  directory(dir)
  chmodSync(dir, 0o700)
  const lock = join(dir, ".migration.lock")
  let fd: number | undefined
  const writerLocks: { path: string; fd: number }[] = []
  try {
    fd = openSync(lock, "wx", 0o600)
    // Cooperate with old learners too: checking for a lock without taking it
    // would let an old writer replace a file in the middle of its move.
    for (const root of [agentDir, dir]) {
      const path = join(root, "cache-guard-observations.lock")
      try { writerLocks.push({ path, fd: openSync(path, "wx", 0o600) }) }
      catch (error: any) {
        if (error.code !== "EEXIST") throw error
        throw new Error(`Legacy observations lock exists: ${path}. Stop all old Pi sessions before migrating; remove the lock only if it is stale`)
      }
    }
    for (const [, name] of legacyFiles) {
      const target = join(dir, name), st = stat(target)
      // A two-link file is allowed only while recovering an interrupted move.
      if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink > 2)) throw new Error(`Unsafe storage file: ${target}`)
    }
    for (const name of ["drafts", "handoffs"]) if (stat(join(dir, name))) directory(join(dir, name))
    migrateFiles(agentDir, dir, onBackup)
    // Also collect prefixed files written by an intermediate version inside the namespace.
    migrateFiles(dir, dir, onBackup)
    for (const [, name] of legacyFiles) {
      const st = stat(join(dir, name))
      if (st && st.nlink !== 1) throw new Error(`Unsafe hard-linked storage file: ${join(dir, name)}`)
    }
    const drafts = join(agentDir, "cache-guard-drafts"), newDrafts = join(dir, "drafts")
    if (stat(drafts)) {
      directory(drafts)
      if (stat(newDrafts)) throw new Error(`Storage conflict; both draft directories were kept: ${drafts} and ${newDrafts}`)
      renameSync(drafts, newDrafts)
      chmodSync(newDrafts, 0o700)
    }
    migrateHandoffs(agentDir, dir)
    return dir
  } catch (error) {
    throw new Error(`Cache Guard storage migration failed: ${error instanceof Error ? error.message : String(error)}. No conflicting data was overwritten. Resolve the cause and restart Pi.`)
  } finally {
    for (const owned of writerLocks.reverse()) { closeSync(owned.fd); unlinkSync(owned.path) }
    if (fd !== undefined) { closeSync(fd); unlinkSync(lock) }
  }
}
