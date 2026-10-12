# 03: Choose a linked fresh session with handoff at cold-cache input

**What to build:** Existing expensive cold-cache confirmation offers a new session with a verified saved handoff, or the full old session at estimated prompt cost, preserving the user's pending request.

**Blocked by:** 01: Create and durably save a handoff in the current session.

**Status:** ready-for-agent

- [ ] Keep existing cold-send budget and interactive input eligibility; retain scoped cheaper-model choices and thinking levels.
- [ ] Offer handoff only when the durable artifact is verified and still readable; show creation time and warn if meaningful conversation work occurred afterward.
- [ ] Continue old session without compaction or replacement and label cost as estimated prompt/cache cost.
- [ ] Use supported command-context session replacement with fresh replacement context and parent-session link.
- [ ] Deliver verified handoff and pending user text/images once in the new session.
- [ ] Cancel or failures preserve input and do not silently lose the original session.
- [ ] Verify minimum Pi compatibility, raising the minimum if required, and document the feature.
- [ ] Tests exercise registered command/input boundaries, missing files, staleness, parent link, fresh context, images, and cancellation.
- [ ] Add/extend an automated real-Pi controlled-provider smoke test if feasible without running a paid live handoff.
