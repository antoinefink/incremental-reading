# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Local Durability

### Local backup

A restore-ready copy of the user's local application data, covering both the canonical local database and the filesystem-owned asset vault.

### Automatic backup

A local backup created quietly by the desktop app lifecycle rather than by a direct user command.

Automatic backups are owned by automatic retention and may be thinned or deleted by that policy. They are distinct from manual backups, even when both use the same restore-ready backup format.

### Manual backup

A local backup explicitly created by the user.

Manual backups may satisfy an automatic due check because they prove the data was recently backed up, but automatic retention must not prune them.

### Asset vault

The filesystem-owned store for large user data such as source files, media, and exports, with the local database retaining metadata and references.

### Restore-ready backup

A backup artifact whose structure and manifest are sufficient for a restore flow to verify and rebuild the local store.

### Automatic retention

The policy that thins automatic backups over time and enforces a storage cap while preserving manual backups.
