import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { collectCacheHistory, formatCacheHistoryReport } from "../extensions/cache-history.ts"
import { OBSERVATION_RETENTION_MS } from "../extensions/cache-learning.ts"

function makeAssistantLine({
  id,
  at,
  provider = "github-copilot",
  model = "gemini-4-argon",
  input = 1000,
  output = 200,
  cacheRead = 0,
  cacheWrite = 0,
  inputCost = 0.002,
  cacheReadCost = 0,
  cacheWriteCost = 0,
  totalCost = 0.004,
}) {
  return JSON.stringify({
    type: "message",
    id,
    timestamp: new Date(at).toISOString(),
    message: {
      role: "assistant",
      provider,
      model,
      timestamp: at,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: inputCost,
          output: Math.max(0, totalCost - inputCost - cacheReadCost - cacheWriteCost),
          cacheRead: cacheReadCost,
          cacheWrite: cacheWriteCost,
          total: totalCost,
        },
      },
    },
  })
}

test("collectCacheHistory and formatCacheHistoryReport extract hits, explicit writes, and misses across nested sessions", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "cache-history-test-"))
  try {
    const subA = join(agentDir, "sessions", "--project-a--")
    const subB = join(agentDir, "sessions", "--project-b--", "nested")
    mkdirSync(subA, { recursive: true })
    mkdirSync(subB, { recursive: true })

    const now = Date.parse("2026-04-19T12:00:00.000Z")
    const t1 = now - 30 * 60_000
    const t2 = now - 20 * 60_000
    const t3 = now - 10 * 60_000

    writeFileSync(
      join(subA, "2026-04-19T11-30-00_sessA123456.jsonl"),
      [
        JSON.stringify({ type: "session", id: "sessA123456", timestamp: new Date(t1).toISOString() }),
        makeAssistantLine({
          id: "m1",
          at: t1,
          provider: "github-copilot",
          model: "gemini-4-argon",
          input: 12000,
          cacheRead: 0,
          cacheWrite: 0,
          inputCost: 0.024,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          totalCost: 0.03,
        }),
        makeAssistantLine({
          id: "m2",
          at: t2,
          provider: "github-copilot",
          model: "gemini-4-argon",
          input: 500,
          cacheRead: 12000,
          cacheWrite: 0,
          inputCost: 0.001,
          cacheReadCost: 0.0024,
          cacheWriteCost: 0,
          totalCost: 0.0054,
        }),
      ].join("\n") + "\n",
    )

    writeFileSync(
      join(subB, "2026-04-19T11-50-00_sessB789012.jsonl"),
      [
        JSON.stringify({ type: "session", id: "sessB789012", timestamp: new Date(t3).toISOString() }),
        makeAssistantLine({
          id: "m3",
          at: t3,
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          input: 100,
          cacheRead: 0,
          cacheWrite: 8000,
          inputCost: 0.0003,
          cacheReadCost: 0,
          cacheWriteCost: 0.03,
          totalCost: 0.035,
        }),
      ].join("\n") + "\n",
    )

    // Symlinks must be ignored safely
    const outside = join(agentDir, "outside.jsonl")
    writeFileSync(outside, makeAssistantLine({ id: "bad", at: now, model: "leaked-model", cacheRead: 99999 }) + "\n")
    symlinkSync(outside, join(subA, "symlink.jsonl"))

    const entries = collectCacheHistory(agentDir, { now })
    assert.equal(entries.length, 3)
    assert.deepEqual(
      entries.map((e) => ({ model: `${e.provider}/${e.model}`, outcome: e.outcome, read: e.cacheRead, write: e.cacheWrite })),
      [
        { model: "anthropic/claude-sonnet-5-5", outcome: "write", read: 0, write: 8000 },
        { model: "github-copilot/gemini-4-argon", outcome: "hit", read: 12000, write: 0 },
        { model: "github-copilot/gemini-4-argon", outcome: "miss", read: 0, write: 0 },
      ],
    )

    const report = formatCacheHistoryReport(entries)
    assert.match(report, /# Cache Guard History \(Last 30 Days\)/)
    assert.match(report, /Requests\*\*: 3 \(hits: 1, writes: 1, misses: 1\)/)
    assert.match(report, /cacheRead=12,000, cacheWrite=8,000/)
    assert.match(report, /read\$=\$0\.0024, write\$=\$0\.0300, total\$=\$0\.0704/)
    assert.match(report, /github-copilot\/gemini-4-argon/)
    assert.match(report, /anthropic\/claude-sonnet-5-5/)
    assert.match(report, /implicit caches/i)
    const chronoLines = report.slice(report.indexOf("## Chronological Requests")).split("\n").filter((l) => l.startsWith("|"))
    assert.ok(chronoLines[0].includes("Timestamp") && chronoLines[0].includes("Cache Read"), "top header row present")
    assert.ok(chronoLines.at(-1).includes("Timestamp") && chronoLines.at(-1).includes("Cache Read"), "bottom header row present so column names stay visible at bottom of editor")
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test("collectCacheHistory supports filtering by model, outcome (hit/miss), and today, plus 30-day pruning", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "cache-history-filter-"))
  try {
    const sessDir = join(agentDir, "sessions", "--work--")
    mkdirSync(sessDir, { recursive: true })

    const now = Date.parse("2026-04-19T15:00:00.000Z")
    const todayHit = now - 2 * 60 * 60_000
    const threeDaysAgoMiss = now - 3 * 24 * 60 * 60_000
    const expiredFortyDaysAgo = now - OBSERVATION_RETENTION_MS - 10 * 24 * 60 * 60_000

    writeFileSync(
      join(sessDir, "session1.jsonl"),
      [
        makeAssistantLine({
          id: "old",
          at: expiredFortyDaysAgo,
          provider: "github-copilot",
          model: "gemini-4-argon",
          cacheRead: 5000,
          cacheReadCost: 0.01,
          totalCost: 0.01,
        }),
        makeAssistantLine({
          id: "miss-3d",
          at: threeDaysAgoMiss,
          provider: "github-copilot",
          model: "gemini-4-argon",
          cacheRead: 0,
          cacheWrite: 0,
          totalCost: 0.02,
        }),
        makeAssistantLine({
          id: "hit-today",
          at: todayHit,
          provider: "github-copilot",
          model: "gpt-6.1-sol",
          cacheRead: 9000,
          cacheReadCost: 0.0045,
          totalCost: 0.009,
        }),
      ].join("\n") + "\n",
    )

    // 30-day pruning excludes the 40-day-old entry
    const allRecent = collectCacheHistory(agentDir, { now })
    assert.equal(allRecent.length, 2)

    // Filter by model
    const argonOnly = collectCacheHistory(agentDir, { now, filter: "gemini-4-argon" })
    assert.equal(argonOnly.length, 1)
    assert.equal(argonOnly[0].model, "gemini-4-argon")
    assert.equal(argonOnly[0].outcome, "miss")

    // Filter by outcome
    const hitsOnly = collectCacheHistory(agentDir, { now, filter: "hit" })
    assert.equal(hitsOnly.length, 1)
    assert.equal(hitsOnly[0].model, "gpt-6.1-sol")
    assert.equal(hitsOnly[0].outcome, "hit")

    const missesOnly = collectCacheHistory(agentDir, { now, filter: "miss" })
    assert.equal(missesOnly.length, 1)
    assert.equal(missesOnly[0].outcome, "miss")

    // Filter by today
    const todayOnly = collectCacheHistory(agentDir, { now, filter: "today" })
    assert.equal(todayOnly.length, 1)
    assert.equal(todayOnly[0].model, "gpt-6.1-sol")
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
