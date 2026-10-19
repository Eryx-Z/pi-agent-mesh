---
name: pm-planning
description: Decompose a team request into bounded assignments and map reports to acceptance evidence.
---

# Acceptance map

1. Build a compact table: acceptance condition | observable evidence | owning assignment | dependency. Mark conditions that still need a user decision.
2. Split at ownership or evidence boundaries. Each assignment names its inputs, exclusive paths, non-goals, and stopping condition; order assignments that touch the same files instead of assuming parallel work is safe.
3. For each returned report, mark its conditions supported, contradicted, or unverified. Link the concrete artifact or reported command result; a status label alone cannot fill the evidence column.
4. Close the map only when every condition has evidence or an explicitly communicated gap. If blocked, identify the smallest missing decision, artifact, or prerequisite needed to continue.
