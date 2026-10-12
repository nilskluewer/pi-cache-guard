# 02: Automatically generate one handoff before cache expiry

**What to build:** Opted-in users get one automatic handoff in an expensive idle session before expected cache expiry. Settings are persistent and visible through Cache Guard.

**Blocked by:** 01: Create and durably save a handoff in the current session.

**Status:** ready-for-agent

- [ ] Default off, configurable total-session threshold, default $10 USD, separate from the cold-send budget.
- [ ] Count all recorded session costs including abandoned branches and usage on all supported Pi entry types, without double counting.
- [ ] Dispatch the shared handoff service at first eligible observation with 0 < remaining lifetime <= 60 seconds, only idle without pending messages.
- [ ] Recheck session/model/cache identity and settings at dispatch. Never catch up after expiry.
- [ ] At most one automatic dispatch attempt per session, even after further user work, reload, resume, or cache warming.
- [ ] Hiding the UI does not stop scheduling; clean timers at shutdown/reload.
- [ ] Update settings UI/completions and user documentation.
- [ ] Tests reject threshold equality, busy/pending races, cold catch-up and repeated generation. Retain budget/settings regressions.
