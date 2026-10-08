# @nilskluewer/pi-cache-guard

A Pi extension that prevents surprise prompt-cache costs.

Providers such as Anthropic keep a prompt cache for 5 minutes (or 1 hour with `PI_CACHE_RETENTION=long`). If you continue a session after the cache expired, the next message writes the whole context to the cache again. With a large context on an expensive model, that one message can cost more than a dollar.

This extension:

- shows a countdown with a progress bar above the editor: `◷ cache ▰▰▰▰▰▰▱▱▱▱ 4:32`, then `❄ cache cold · next ~$0.94`. Use the `/cache-guard` command to move it (`above`, `below`, `corner`, `footer`) or hide it (`off`). See [Placement](#placement).
- asks before a message goes out on a cold cache, if the predicted cost is above your budget (default $0.10; change it with `/cache-guard budget 0.50`, see [Budget](#budget)):

```text
Prompt cache is cold (it expired 2 h ago). This message re-sends ~150k tokens: ~$0.94 instead of ~$0.08 with a warm cache.
> Send with Claude Opus 4.8 · ~$0.94
  Switch to anthropic-vertex/claude-sonnet-5 · ~$0.56
  Switch to anthropic-vertex/claude-haiku-4-5 · ~$0.19
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

## Longer cache lifetime

By default the cache lives 5 minutes, so the countdown is short. To get 1 hour on Anthropic models, start Pi with Pi's own setting:

```bash
export PI_CACHE_RETENTION=long   # for example in ~/.zshrc
```

Cache writes cost more with the 1-hour lifetime. The countdown and the predicted costs follow this setting. Pi documents this variable in its environment variables docs.

## Budget

A cold cache costing a few cents is fine for many people. A cold cache costing several dollars is not. The budget is the most a cold-cache send may cost before the extension asks.

```text
/cache-guard budget 0.50   ask only when a cold send costs more than $0.50
/cache-guard budget 0      always ask
/cache-guard budget        pick from a list, or enter your own amount
/cache-guard               settings menu (budget and placement)
```

Amounts are in US dollars, because Pi's model prices are in US dollars. The default is $0.10. A saved budget replaces the `PI_CACHE_GUARD_MIN_USD` environment variable, which stays as a fallback default.

## Placement

The countdown is shown above the editor by default. The bar uses Pi's accent colour and turns to the warning colour in the last minute. The footer status line can be hidden by long statuses from other extensions. Change the place with:

```text
/cache-guard            pick from a list
/cache-guard above      above the editor (default)
/cache-guard corner     top right corner, as a boxed overlay
/cache-guard below      below the editor
/cache-guard footer     footer status line
/cache-guard off        hidden
```

The choice and the budget are saved in `~/.pi/agent/cache-guard.json`.

## Configuration

| Environment variable | Default | Effect |
|---|---|---|
| `PI_CACHE_GUARD_MIN_USD` | `0.1` | Default budget: ask only when a cold send costs more than this amount. `0` always asks. A budget set with `/cache-guard budget` takes priority. |
| `PI_CACHE_RETENTION` | – | Pi's own setting. `long` uses the 1-hour cache lifetime and price. |

## Behavior

- The cache is warm until `last request + TTL`. A request is an assistant response or one of Pi's `cache_warm` refreshes (see the `cacheWarming` setting).
- A model change always starts with a cold cache.
- After a compaction the prompt is new, so the extension does not ask.
- Only interactive input is checked. Slash commands and `!` shell commands are ignored; prompt templates and skills are checked.
- Switch options come only from the session's `/scoped-models`, including models from other providers. All cheaper scoped models that fit the context are shown; there is no catalog fallback or price-level substitution. The scoped thinking level is applied on switching. If no models are scoped, only Send and Cancel are offered.

## Test

```bash
npm test
```

## License

MIT
