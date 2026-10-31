# Patch notes

All notable changes to `@nilskluewer/pi-cache-guard` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.1] - 2026-10-31

### Changed

- Use Pi's declared `promptCache` lifetime for the active retention tier as the countdown baseline, including custom models and `models.json` overrides. Keep local duration evidence separate; use it as a fallback only when a declaration is absent.
- Pause automatic handoff while Pi's native `cacheWarming: "idle"` is enabled. Keep the saved handoff preference, show the pause in settings, and do not override Pi's warming economics or safety limits.
- Exclude native-refresh callbacks and overlapping ambiguous samples from normal duration learning. Continue to use persisted native refresh usage for accounting and the countdown.
- Verify coordination with real Pi runtime regression tests and an opt-in, bounded live-provider session check.
- Group settings, cache-learning data, handoff documents, and recovery drafts under `<agentDir>/cache-guard/`.
- Automatically migrate old files on extension startup without overwriting conflicting data. Keep current settings and learning files authoritative, and archive conflicting legacy files under `cache-guard/legacy/import-*/` instead of blocking startup. Preserve old absolute handoff paths through a compatibility link. Leave mixed or unrecognized legacy handoff directories untouched.
- Test migration through fresh, isolated Pi CLI processes, including a second startup, and keep the packed-package smoke test isolated from the user's live agent directory.

## [0.6.0] - 2026-10-27

### Added

- Added cross-session cache usage history via `/cache-guard history [filter]` and the `◷ History · View cache hits, misses & costs across sessions` option in the `/cache-guard` menu, showing aligned tables with always-visible column headers (`Timestamp`, `Model`, `Outcome`, `Cache Read`, `Cache Write`, `Read $`, `Write $`, `Total $`, `Session`).
- Added implicit/zero-cost cache-write anchoring in `CacheLearner` so routes that omit or zero out `cache_write_tokens` (such as Gemini 4 Argon) qualify subsequent positive `cached_tokens` reads and start warm countdowns after cold turns.
- Added 30-day automatic retention pruning (`OBSERVATION_RETENTION_MS`) for local observation logs and stale saved estimates so user machines stay clean.

### Changed

- Updated `CacheLearner` bucket evaluation so isolated opportunistic early misses in hit-supported buckets (`hits >= 3` and `hits >= misses * 2`) converge on the supported hit horizon instead of collapsing the route into a bare `cache duration variable` state.
- Updated warm and variable/unknown status displays to surface observed read-hit horizons and uncertainty details (`hits ≤...`, `early misses`, `writes $0/unreported`).

## [0.5.2] - 2026-10-26

### Added

- Added the package preview screenshot (`assets/cache-guard-preview.png`) and `pi.image` manifest entry for `pi.dev`.
- Added `PATCH_NOTES.md` and inline release history in `README.md` covering all published versions (`0.1.0` through `0.5.2`).

## [0.5.1] - 2026-10-26

### Added

- Added the `ℹ Info · How cache & learning are calculated` option to the `/cache-guard` settings menu to explain countdown calculation, model/route differences, hit classification, raw `provider_stream_event` inspection, and Pi harness hooks.

### Changed

- Simplified the active countdown display from `◷ cache ~5min (estimate) ▰▰▰▰▰▰▰▰▰▱ 4:10` to `◷ ~5m ▰▰▰▰▰▰▰▰▰▱ 4:10 (est.)` (or `(family est.)` for family seeds), removing the trailing `last hit after Xmin` text for a cleaner layout.

## [0.5.0] - 2026-10-23

With contributions from [@paulrohde675](https://github.com/paulrohde675).

### Added

- Added passive local cache-duration learning (`extensions/cache-learning.ts`) driven by raw `provider_stream_event` usage payloads (`cache_read_input_tokens`, `cached_tokens`) and salted prefix fingerprints (`before_provider_request`, `message_end`).
- Added route- and model-specific initial cache estimates for GitHub Copilot (Claude 5.5 family, GPT-6.1 Sol, GPT-6 Luna, Gemini 4 Argon, Gemini 3.8 Flash), Anthropic (Claude 5.5 family), and OpenAI / Codex subscription (`gpt-6.1-sol`, `gpt-6-luna`).
- Added private, bounded, rotated local observation logs (`cache-guard-observations.jsonl`, `.jsonl.1`) and derived route estimates (`cache-guard-estimates.json`) in `~/.pi/agent/`.
- Added width-aware responsive countdown and cold-cache display formatting (`extensions/cache-display.ts`) that wraps cleanly in narrow terminals while preserving the countdown and miss cost.
- Added documentation on `PI_CACHE_RETENTION=long`, GitHub Copilot cache behavior, and passive learning mechanics.

### Changed

- Changed expired-window wording from `❄ cache cold · next ~$0.94` to `◷ cache est. ended · miss ~$0.18` to reflect that countdowns are estimates rather than live provider status checks.
- Updated minimum peer dependency for `@earendil-works/pi-coding-agent` to `>=1.3.0` (for `provider_stream_event`) and added `@earendil-works/pi-tui` to `peerDependencies`.

## [0.4.0] - 2026-10-13

### Added

- Added automatic session handoff scheduling (`extensions/handoff-scheduling.ts`, `extensions/handoff.ts`) that prepares a verified handoff document near cache expiry (`<= 60s` remaining while idle) when the estimated cold cost of the current context exceeds the threshold (default `$0.50`, enabled by default).
- Added `/cache-guard handoff on|off|threshold <usd>` commands and integrated handoff controls into the flat `/cache-guard` settings menu.
- Added the **New session with saved handoff** option to the cold-cache cost dialog (`extensions/handoff-choice.ts`), starting a linked fresh session with the verified handoff document and the user's pending text and image attachments.
- Added crash- and reload-safe local recovery drafts (`~/.pi/agent/cache-guard-drafts/`) so pending prompts and images are never lost if session replacement is cancelled or fails.
- Added CI workflow and packed-tarball smoke test (`scripts/smoke.mjs`).

### Changed

- Updated the cold-cache dialog to list all models from the session's `/scoped-models` in scope order (including equal-price, higher-price, and cross-provider models), showing estimated cold prompt/cache costs and context-fit reasons (`context too large for model: …`).

## [0.3.1] - 2026-10-08

### Fixed

- Fixed runtime module resolution in Pi by importing `calculateCost` from `@earendil-works/pi-ai` root instead of `@earendil-works/pi-ai/models`.

## [0.3.0] - 2026-10-08

### Added

- Added configurable cold-cache cost budget via `/cache-guard budget [usd]` and the `/cache-guard` settings menu.
- Persisted the user's cost budget alongside countdown placement in `~/.pi/agent/cache-guard.json` (overriding the `PI_CACHE_GUARD_MIN_USD` fallback default).

## [0.2.0] - 2026-10-08

### Added

- Added visual progress bar (`▰▰▰▰▰▰▱▱▱▱`) to the countdown timer, shifting from Pi's accent colour to warning colour in the final minute.
- Added top-right boxed overlay placement (`/cache-guard corner`) with a flush block border and margin.
- Added documentation for 1-hour cache retention via `PI_CACHE_RETENTION=long`.

### Changed

- Styled cold-cache status in Pi's `error` theme colour.
- Made `above` (above the editor) the default countdown placement and documented `/cache-guard` placement options (`above`, `corner`, `below`, `footer`, `off`).

## [0.1.0] - 2026-10-08

### Added

- Initial release of `@nilskluewer/pi-cache-guard`.
- Added live prompt-cache countdown and cold-cache cost estimate display.
- Added interactive pre-send confirmation dialog when sending on an expired cache would exceed the cost threshold (`PI_CACHE_GUARD_MIN_USD`, default `$0.10`).
- Added one-step model switching in the cold-cache dialog using the session's `/scoped-models` and thinking levels, powered by Pi's `model.cost` and `calculateCost`.
- Added protocol-level cache lifetime fallbacks for `anthropic-messages` (5 min / 1 h with `PI_CACHE_RETENTION=long`) and `openai-responses` (5 min) when catalog `promptCache` metadata is absent.
