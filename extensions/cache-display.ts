import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"

/** Essential status and detail stay visible; optional evidence is first to go. */
export type CacheDisplay = {
  primary: string
  secondary?: string
  inlineSecondary?: string
  compactPrimary?: string
  compactSecondary?: string
  separator?: string
  optional?: string
}

export function cacheDisplayText(content: CacheDisplay, includeOptional = true): string {
  const detail = content.inlineSecondary ?? content.secondary
  return content.primary + (detail ? (content.separator ?? " · ") + detail : "")
    + (includeOptional && content.optional ? " · " + content.optional : "")
}

/** Width comes from Pi's renderer, not process.stdout or JavaScript string length. */
export function layoutCacheDisplay(content: CacheDisplay, width: number): string[] {
  width = Math.max(0, Math.floor(width))
  if (!width) return []
  const full = cacheDisplayText(content)
  if (visibleWidth(full) <= width) return [full]
  const essential = cacheDisplayText(content, false)
  if (visibleWidth(essential) <= width) return [essential]

  const primary = visibleWidth(content.primary) > width ? content.compactPrimary ?? content.primary : content.primary
  const detail = content.secondary
  const secondary = detail && visibleWidth(detail) > width ? content.compactSecondary ?? detail : detail
  return [primary, ...(secondary ? [secondary] : [])]
    .flatMap(line => wrapTextWithAnsi(line, width))
    // A double-width glyph cannot fit a one-column viewport. Never overflow it.
    .map(line => truncateToWidth(line, width, ""))
}

/** Border colour: RGB 39, 59, 72. */
const border = (s: string) => "\x1b[38;2;39;59;72m" + s + "\x1b[39m"

export function renderCacheBox(content: CacheDisplay, width: number): string[] {
  width = Math.max(0, Math.floor(width))
  // Borders and two padding cells would consume the entire tiny viewport.
  if (width < 5) return layoutCacheDisplay(content, width)
  const lines = layoutCacheDisplay(content, width - 4)
  const inner = Math.max(...lines.map(visibleWidth))
  const left = " ".repeat(width - inner - 4)
  return [
    left + border("▛" + "▀".repeat(inner + 2) + "▜"),
    ...lines.map(line => left + border("▌") + " " + line + " ".repeat(inner - visibleWidth(line) + 1) + border("▐")),
    left + border("▙" + "▄".repeat(inner + 2) + "▟"),
  ]
}
