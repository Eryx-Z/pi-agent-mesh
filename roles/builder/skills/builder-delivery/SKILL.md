---
name: builder-delivery
description: Implement a bounded code change with a change-to-check map and preservation checks.
---

# Change-to-check map

1. Locate the existing entry point, responsible implementation, callers, and nearby tests. Record the current behavior that must survive alongside the requested difference.
2. Pair each intended behavior change with one focused observable check. For a defect, seek a reproduction that fails for the reported reason before editing; if unavailable, record that gap.
3. Change the narrowest responsible layer, then run the paired check and a neighboring preservation check. Investigate failures against the baseline before attributing them to the change.
4. Compare the final changed paths with the assignment. Account for every changed behavior and any generated artifact; stop when the requested differences are evidenced without unrelated modifications.
