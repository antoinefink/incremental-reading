# AGENTS.md

`packages/testing` owns shared factories, fixtures, mocks, and test helpers.

Fixtures must reflect project invariants:

- every source/extract/card/task-like object is an Element or belongs to one
- extracts/cards include source lineage when applicable
- durable mutations can be represented as operation-log entries
- assets use metadata and vault-relative paths, not large inline blobs
- card schedules use FSRS fields; source/topic/extract schedules use attention fields

Prefer small composable factories with explicit overrides over large magical builders. Defaults
should be valid, realistic, and safe for persistence tests.

Keep fixtures useful for restart/persistence tests: stable IDs, stable block IDs, deterministic
timestamps, deterministic priorities, and repeatable scheduler inputs.
