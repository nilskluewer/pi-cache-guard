# @nilskluewer/pi-cache-guard

A Pi extension that prevents surprise prompt-cache costs.

Providers such as Anthropic keep a prompt cache for 5 minutes (or 1 hour with `PI_CACHE_RETENTION=long`). If you continue a session after the cache expired, the next message writes the whole context to the cache again. With a large context on an expensive model, that one message can cost more than a dollar.

This extension:

- shows a countdown in the footer: `⏳ cache 4:32`, then `❄ cache cold · next ~$0.94`
- asks before a message goes out on a cold cache, if the predicted cost is at least $0.10:

```text
Prompt cache is cold (it expired 2 h ago). This message re-sends ~150k tokens: ~$0.94 instead of ~$0.08 with a warm cache.
> Send with Claude Opus 4.8 · ~$0.94
  Switch to Claude Sonnet 5 · ~$0.56
  Switch to Claude Haiku 4.5 · ~$0.19   ← the cheapest level is always shown
  Cancel (keep text in editor)
```

## No maintenance

The extension has no price list and no per-model TTL table. It reads `model.cost` and `model.promptCache` from Pi's model catalog, which Pi updates from pi.dev (`pi update --models`). Costs use Pi's own `calculateCost`, so price tiers and 1-hour cache writes are included.

Some routes, such as GitHub Copilot, have no `promptCache` in the catalog. For these, the extension uses one lifetime per API protocol, from the provider docs (conservative end):

| API | Lifetime |
|---|---|
| `anthropic-messages` (Claude) | 5 min, or 1 h with `PI_CACHE_RETENTION=long` |
| `openai-responses` (GPT) | 5 min |

The fallback applies only when the last request reported cache tokens, so it never guesses for a route that does not cache. Other protocols (for example Gemini through `openai-completions`) show nothing. Their cache is short and a miss costs only the normal input price.

## Install

```bash
pi install npm:@nilskluewer/pi-cache-guard
```

Run `/reload` in an existing Pi session.

## Configuration

| Environment variable | Default | Effect |
|---|---|---|
| `PI_CACHE_GUARD_MIN_USD` | `0.1` | Ask only when a cold send costs at least this amount. `0` always asks. |
| `PI_CACHE_RETENTION` | – | Pi's own setting. `long` uses the 1-hour cache lifetime and price. |

## Behavior

- The cache is warm until `last request + TTL`. A request is an assistant response or one of Pi's `cache_warm` refreshes (see the `cacheWarming` setting).
- A model change always starts with a cold cache.
- After a compaction the prompt is new, so the extension does not ask.
- Only interactive input is checked. Slash commands and `!` shell commands are ignored; prompt templates and skills are checked.
- The switch options are cheaper models of the same provider that fit the current context, one per price level: the closest cheaper levels and always the cheapest one (at most 4).

## Test

```bash
npm test
```
