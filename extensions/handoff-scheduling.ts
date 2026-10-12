import type { SessionEntry } from "@earendil-works/pi-coding-agent"

/** Pi's getSessionStats semantics: raw entries across the whole session, not model context.
 * Nested tool usage is already included in the outer tool result; never walk details.
 * Missing recorded costs cannot be reconstructed from today's catalog prices. */
export function sessionCostUsd(entries: readonly SessionEntry[]): number {
  let total = 0
  for (const entry of entries) {
    let cost: number | undefined
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      cost = entry.usage?.cost?.total
    } else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      cost = entry.message.usage?.cost?.total
    }
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) total += cost
  }
  return total
}
