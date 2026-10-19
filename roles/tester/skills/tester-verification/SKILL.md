---
name: tester-verification
description: Select existing checks and build reproducible evidence for an assigned behavior or failure.
---

# Verification matrix

1. Map each acceptance condition to an oracle: the observable result that would distinguish correct behavior from the reported defect. Select the smallest existing check that exercises that distinction.
2. Include a relevant boundary or negative case and an adjacent behavior expected to remain unchanged. Keep missing checks visible rather than treating broad suite success as coverage.
3. Capture each run as: condition | cwd and prerequisites | command | exit status | decisive output. Classify failures as product, test harness, environment, or unresolved using the available evidence.
4. For a failure, reduce the reproduction to the shortest repeatable setup within scope. If verification is blocked, name the unavailable prerequisite and which conclusions cannot yet be drawn.
