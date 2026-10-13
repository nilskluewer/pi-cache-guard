# Handoff review fixes: verification

## Scope and oracle

Branch: `fix/handoff-review`, based on integration commit `d3b1a05`.
Oracle: `docs/specs/automatic-session-handoff.md`, particularly pending-input recovery,
verified durable output, and one automatic dispatch per session. Pi-owned retries are
part of that dispatch, not another Cache Guard dispatch.

Installed Pi documentation: `docs/extensions.md`, `docs/sdk.md`,
`docs/custom-provider.md`, and session/message documentation. Runtime source confirms
that extension `message_end` handlers precede message persistence and that
`agent_end` precedes retry/recovery and actionable settlement boundaries.

| Claim | Falsifier and pass criterion |
| --- | --- |
| Rejected Continue retains recovery data | Cancel an image request in real Pi, remove offline credentials, Continue with edited text. Auth rejection must leave one recovery file and make zero provider requests. |
| Image preflight is not acceptance | Inject a rejection in Pi's image-normalization method after `before_agent_start`. Recovery must remain. Restore normalization; the persisted edited user message and provider context must contain one image, not two. The next request must have no replayed image. |
| Recovery cleanup is request-specific | Unrelated persisted user message cannot clear recovery. An older accepted request cannot clear a newer cancelled draft. |
| Retry completion is final | Offline provider returns 503, then a real built-in bash tool call writes Markdown. Final state must be ready, with one original handoff request, three provider requests, one saved notification, and no failure notification. |
| Extension continuation is not final | First write a draft with the real write tool; request continuation at `agent_before_settle`; update the same file. Save only the final body, with no early saved notification. |
| Exhausted retries fail once | Three local 503 responses exhaust two retries. One dispatch guard, one final failure notification, no saved notification. |
| Raw temp expansion preserves separators | Real bash executes `printf '# Handoff\\n' > "${TMPDIR}handoff.md"` with trailing-slash TMPDIR. Durable output must end with the exact generated body. Separate override checks cover `${TMPDIR}`, `$TMPDIR/`, and `%TEMP%`, including bounds without a separator. |

## Executed red / green

Before source changes:

```sh
node --experimental-strip-types --test tests/handoff-lifecycle-pi.test.mjs
```

All three original runtime checks failed for the reported behavior: both valid-output
cases had `failed` instead of `ready`; the auth rejection removed recovery (`0`
instead of `1`). The initial harness left scheduler resources open after failure;
explicit `session_shutdown` cleanup corrected that test-harness issue.

Red was repeated to completion against untouched `d3b1a05` source in an isolated
copy, using the final regression tests:

```sh
node --experimental-strip-types --test \
  --test-name-pattern='shell TMPDIR concatenation|503 retry|auth rejection' \
  .scratch/review-red/tests/handoff-lifecycle-pi.test.mjs
```

Result: **0 pass / 3 fail**, exit 1, with the same three assertions.
Log: `/tmp/handoff-review-red-complete.log`.

Green on installed Pi coding-agent **1.1.0**:

```sh
npm test
```

Result: **100 pass / 0 fail**, including five offline real-Pi lifecycle tests and
the existing real-Pi session-replacement test.
Log: `/tmp/handoff-review-final-1.1.log`.

Compatibility run on Pi coding-agent **1.0.0**:

```sh
node --experimental-strip-types --test .scratch/review-compat/tests/*.test.mjs
```

Result: **100 pass / 0 fail**. The isolated copy used the previously extracted npm
1.0.0 package, with installed shared dependencies, including **pi-ai 1.1.0**.
This verifies the coding-agent minimum, not a fully pinned historical dependency
matrix. Log: `/tmp/handoff-review-final-1.0.log`. Temporary copies were removed.

Packed-tarball load in the real Pi RPC process, without model requests:

```sh
npm_config_offline=true npm_config_legacy_peer_deps=true npm run smoke
```

Result: `smoke ok: @nilskluewer/pi-cache-guard loads in Pi from the packed tarball`.
`legacy_peer_deps` prevents offline npm from trying to resolve host-supplied peers.
An initial offline attempt without it could not install the tarball.
A combined red/smoke command later hit the harness command timeout during smoke;
the same standalone smoke command passed again on the final source.
Final log: `/tmp/handoff-review-smoke-final.log`. `git diff --check` also passes.

## Compatibility and limits

- Keep the declared `>=1.0.0` minimum. Both versions provide `agent_settled`.
- Pi 1.0 does not supply `agent_settled.aborted`; retain the last assistant stop reason
  and use the new abort flag only when present.
- Settlement writes only non-context extension metadata and files. It does not
  append model context or request a continuation.
- Auth rejection is real runtime behavior. Image-processing rejection is a controlled
  fault at the real runtime boundary, not a claim about a particular corrupt image.
- No live provider, paid handoff, or native Windows shell was used. `%TEMP%` expansion
  was tested by substituting its override before POSIX execution, not by running cmd.exe.
- UI callbacks drive the real SDK runtime; these are not rendered terminal/pixel tests.
- The path recognizer remains evidence-based and bounded, not a general shell parser.
