---
name: reviewer-audit
description: Trace requirement-to-code behavior and turn suspected review issues into evidence-backed counterexamples.
---

# Counterexample audit

1. Identify the review baseline, target paths, and required invariants from the assignment and primary materials. Separate known facts from missing inputs.
2. Follow changed inputs through validation, state changes, and error or cleanup paths. Inspect relevant callers to test assumptions at module boundaries.
3. For each suspected mismatch, construct a concrete input or state and trace it to an observable violation. Check for an existing guard or caller constraint that disproves the counterexample before reporting it.
4. Group supported findings by impact. Tie each to the violated requirement and precise location; label unresolved hypotheses separately and finish with inspected scope and evidence gaps.
