# AGENTS.md

`packages/scheduler` owns scheduling logic only. Keep it independent of React, Electron, SQLite
access, and UI state.

Use FSRS only for active-recall cards. Card scheduling answers: can the user recall this?

Use the attention scheduler for sources, topics, extracts, tasks, and synthesis work. Attention
scheduling answers: should the user process this again, and when?

Do not collapse the two models. Topic/extract/source scheduling should consider priority, stage,
last processed date, user action, child value produced, stagnation, and repeated postponement.

Protect high-priority fragile knowledge and avoid letting newly imported low-value material
dominate older high-value work.

Add tests for interval decisions, priority ordering, overdue behavior, suspension/dismissal, and
sibling/card edge cases when touched.
