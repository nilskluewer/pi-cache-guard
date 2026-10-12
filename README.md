# @nilskluewer/pi-cache-guard

A Pi extension that prevents surprise prompt-cache costs.

Providers such as Anthropic keep a prompt cache for 5 minutes (or 1 hour with `PI_CACHE_RETENTION=long`). If you continue a session after the cache expired, the next message writes the whole context to the cache again. With a large context on an expensive model, that one message can cost more than a dollar.

This extension:

- shows a countdown with a progress bar above the editor: `◷ cache ▰▰▰▰▰▰▱▱▱▱ 4:32`, then `❄ cache cold · next ~$0.94`. Use the `/cache-guard` command to move it (`above`, `below`, `corner`, `footer`) or hide it (`off`). See [Placement](#placement).
- asks before a message goes out on a cold cache, if the predicted cost is above your budget (default $0.10; change it with `/cache-guard budget 0.50`, see [Budget](#budget)):

```text
Prompt cache is cold (it expired 2 h ago). This message re-sends ~150k tokens: ~$0.94 instead of ~$0.08 with a warm cache.
> Continue with Claude Opus 4.8 · estimated prompt/cache cost ~$0.94
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

## Automatic handoff scheduling

Automatic handoff is **off by default**. Enable it only if you want Pi to spend money on one visible handoff turn in a costly session:

```text
/cache-guard handoff on              enable automatic generation
/cache-guard handoff off             disable automatic generation (default)
/cache-guard handoff threshold 10    require recorded session total > $10 (default)
/cache-guard handoff                 settings menu: on/off and threshold
```

The threshold accepts finite, nonnegative USD amounts. It is separate from the cold-send budget. The total includes all recorded costs in the current session, including abandoned branches, tools, compactions, branch summaries, and cache refreshes. It does not read parent sessions or reconstruct missing usage as billed cost.

In an interactive terminal session, the extension checks once per second. It starts at the first eligible check with **more than zero and at most 60 seconds** of estimated cache lifetime left, only when Pi is idle and has no pending messages. It uses the current model, the normal tools, and the original handoff prompt. It does not compact, change models, or switch sessions. The generated document is verified and copied to an agent-owned `handoffs` directory outside the workspace, with source-session metadata.

Generation, output, and tool follow-up requests still incur costs. The 60-second lead does not guarantee a warm-cache hit or completion before expiry. If Pi is busy through the warm window, closed, or asleep until the cache is cold, there is **no automatic cold-cache catch-up**. Hiding the countdown with `/cache-guard off` does not disable enabled scheduling.

There is at most one automatic dispatch attempt per session, including failed attempts. The guard survives cache refreshes, further work, branch changes, reloads, and resumes. Failures are reported without an automatic retry. The enabled flag and threshold are saved with the budget and placement in `~/.pi/agent/cache-guard.json`.

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
- Switch options come only from the session's `/scoped-models`, including models from other providers. All cheaper scoped models that fit the context are shown; there is no catalog fallback or price-level substitution. The scoped thinking level is applied on switching. If no models are scoped, Continue and Cancel are offered, plus the saved-handoff choice when available.

## Continue with a saved handoff

When automatic handoff has saved a verified document, the existing expensive cold-cache dialog also offers:

```text
> New session with saved handoff · 2026-01-02T03:04:05.000Z
  Continue with Claude Opus 4.8 · estimated prompt/cache cost ~$0.94
  Switch to anthropic-vertex/claude-sonnet-5 · ~$0.56
  Cancel (keep text in editor)
```

- **New session** starts a linked, fresh session with the saved document and your pending text and images. It does not copy the old history or compact it. Prompt templates and skills still expand for the pending request.
- **Continue** keeps the full old conversation. The estimate covers prompt input/cache cost, not the complete next turn or guaranteed savings. Scoped cheaper models and their thinking levels remain available.
- The creation time is shown. Later task work or a different conversation branch adds an **older state** warning. The handoff's own generation and extension metadata do not make it older. No new document is generated by this choice.
- Missing or changed files are not offered. The file is checked again before session replacement.
- Cancel or a failed transition keeps the pending request. Pi has no extension API to restore image attachments to the editor, so Cache Guard retains images for the next model-bound input, including edited text. Shell and slash commands do not consume that draft.

Recovery drafts contain your pending text and images. They are stored locally under `~/.pi/agent/cache-guard-drafts/` (or Pi's configured agent directory), outside the workspace, with private file permissions where supported. They survive reload and session resume and are removed when consumed. Do not share these files without review. If saving fails, Cache Guard refuses the session replacement and retains the draft in memory; keep Pi open.

Pi's runtime invalidates the old context during replacement. If sending fails after a linked replacement, Cache Guard uses the fresh command context to return to the source session. A file-less source has no resumable parent: its request and handoff stay as a draft in the new session. If Pi itself fails while creating the replacement runtime, reopen the source session to recover the saved request and images. No automatic retry occurs.

The declared minimum remains Pi **1.0.0**: its published API includes the command-dispatch and fresh `withSession` APIs. The real-runtime test uses installed Pi **1.1.0**. `/cache-guard-resume` is an internal, single-use command bridge, not a command to generate handoffs.

## Test

```bash
npm test
```

## License

MIT
