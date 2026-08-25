# DB Prunetor — project guide for AI agents

## What this is

An opencode plugin that performs lightweight, automatic maintenance of opencode's
SQLite database (`~/.local/share/opencode/opencode.db`) on session close. It
verifies integrity, prunes every table belonging to inactive sessions (parts,
messages, the event journal, session metadata and the sessions themselves, plus
projects left empty) in FK order (children before parents), sweeps rows
orphaned by already-deleted sessions, rebuilds indexes, refreshes planner
statistics, and compacts the file (`VACUUM` + `wal_checkpoint(TRUNCATE)`) to
reclaim the freed space. Safe to run while opencode is live (everything goes
through the WAL); the heavy `VACUUM` only fires after a real prune.

## Source of truth

- **`db-prunetor.ts`** — single TypeScript source file. The only source of truth.
- **`db-prunetor.jsonc`** — config, goes in `~/.config/opencode/`.
- **Version:** 0.1.10
- **`~/.config/opencode/db-prunetor.log`** — append-only log.

## Mandatory skills

Siempre activos (cargados por opencode vía `instructions` en `~/.config/opencode/opencode.jsonc`, no por este plugin):

- `caveman` — respuesta tersa (sin artículos, fragmentos).
- `my-interaction-rules` — envelope `[Skills: ...]`, español con acentos, sin edits sin autorización.
- `my-coding-preferences` — estilo: tabs, Allman, `protected` por defecto, versión solo último segmento.

## Architecture

The plugin registers a single hook:

| Hook | What it does |
|---|---|
| `dispose` | Runs maintenance on session close (opencode releasing its DB connection): integrity gate → optional `VACUUM INTO` backup → single `exec` with TEMP triggers that cascade every child of a deleted session/project, so one `DELETE FROM session` drags all related rows, plus orphan + empty-project sweep in the same `BEGIN`/`COMMIT` → `PRAGMA optimize` → `VACUUM` + `wal_checkpoint(TRUNCATE)` → remove backup. No `REINDEX` (VACUUM already rebuilds indexes). Backup skipped entirely when `backup` is `false` (default). |

### Maintenance sequence (`DbPrunetor.dispose`)

```
dispose → open ephemeral RW connection to db_path
        → PRAGMA integrity_check  → if not "ok": abort (no prune)
        → gate count: eligible sessions (inactive > prune_days) + orphan rows
          (part/message/session_message/todo/event/event_sequence without session)
        → if 0: "no prune needed" (remove stale .bak only when backup=false)
        → else: optional VACUUM INTO backup (skipped when backup=false)
        → single exec (speed pragmas inline: synchronous=NORMAL, temp_store=MEMORY,
          cache_size=5000, busy_timeout=5000, foreign_keys=ON):
            CREATE TEMP TRIGGER pr_session_children BEFORE DELETE ON session
                → deletes part/message/event/event_sequence/todo/session_share/
                  session_message/session_input/session_context_epoch for OLD.id
                → UPDATE session SET parent_id=NULL WHERE parent_id=OLD.id (repair kept children)
            CREATE TEMP TRIGGER pr_project_children BEFORE DELETE ON project
                → deletes permission/workspace/project_directory for OLD.id
            BEGIN
                DELETE FROM session WHERE time_updated < cutoff   (cascades all children via trigger)
                orphan sweep: part/message/event/event_sequence/todo/session_message
                              WHERE key NOT IN (SELECT id FROM session)
                DELETE FROM project WHERE NOT EXISTS (live session)  (cascades its children via trigger)
            COMMIT
        → PRAGMA optimize  (no REINDEX — VACUUM rebuilds indexes)
        → VACUUM + wal_checkpoint(TRUNCATE)   (outside txn; reclaims freed space)
        → remove backup (if any)
        → log report (db/wal/shm/bak sizes)
        → close connection (TEMP triggers + pragmas discarded — never affect opencode's own connection)
```

## Key decisions (from session history)

- **Runs on `dispose`, not startup** — at close, opencode releases its DB connection, so contention is minimal and the plugin never slows session startup.
- **Compact only after a real prune** — the heavy `VACUUM` + `wal_checkpoint(TRUNCATE)` fires only when rows were actually deleted (not on "no prune needed"), so the file reclaims the freed space without paying the cost on every close.
- **`time_updated` is epoch milliseconds** — cutoff uses `strftime('%s','now','-N days') * 1000`.
- **`event.aggregate_id` = `session.id`** — verified: 172870/172970 events join to a session. Prune keys off that mapping.
- **Prunes every table, not just `event`** — the bulk of the DB lives in `part`/`message` (574+92 MB vs 477 MB in `event`, and most `event` rows belong to recent sessions). Pruning only events freed almost nothing.
- **No temp tables — cascade via TEMP triggers** — instead of materializing `prune_sessions`/`prune_projects` and issuing a DELETE per table, two `CREATE TEMP TRIGGER ... BEFORE DELETE` (on `session` and `project`) delete every child row when the parent is deleted. One `DELETE FROM session WHERE time_updated < cutoff` then drags all related rows in a single statement; `DELETE FROM project WHERE NOT EXISTS (live session)` does the same for empty projects. Triggers are `TEMP`, so they vanish when the maintenance connection closes and never alter opencode's own schema. (A `VIEW` was considered; SQLite forbids parameters in views and a view would re-evaluate per statement — the trigger freezes the cascade.)
- **`foreign_keys=ON` on the maintenance connection** — set inline in the prune `exec` (not a separate method). The `BEFORE DELETE` triggers remove children *before* the parent row goes, so the pragma never sees a dangling reference; it remains a safety net, not a crutch: if opencode adds a child table with FK to `session`/`project` in a future version, its rows cascade on the parent delete instead of silently lingering as orphans. Per-connection, never touches opencode's own connection.
- **Orphan sweep** — rows whose session/aggregate no longer exists (cleared or migrated sessions: found 50k parts, 12k messages, 279 todos, 97 events, 5 session_messages) are dead weight the session-keyed deletes never reach; swept on the same run, counted in the gate.
- **Dangling `parent_id` repaired** — the `pr_session_children` trigger runs `UPDATE session SET parent_id = NULL WHERE parent_id = OLD.id` before deleting a session, so children kept (recent sessions whose parent was pruned) become root sessions — no dangling self-references survive.
- **Empty projects pruned too** — `DELETE FROM project WHERE NOT EXISTS (live session)` fires `pr_project_children`, which deletes its `permission`/`workspace`/`project_directory` rows; opencode recreates them when the worktree reopens.
- **Integrity gate** — `PRAGMA integrity_check` must return "ok" before any mutation. A suspect DB is never pruned.
- **`db_path` is auto-detected, not configured** — the plugin resolves opencode's database the same way opencode does: it honors `process.env.OPENCODE_DB` (absolute / `:memory:` as-is, else relative to the data dir), otherwise the stable default `<dataDir>/opencode.db` where `dataDir` is `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`. The `db_path` config key is an optional override only. No fragile hardcoded path.
- **Online backup via `VACUUM INTO`** — consistent snapshot that does not lock the live database. Written to `<db_path>.bak` (same directory as the DB, derived automatically — no config) before the destructive `DELETE`. It is a temporary safety net: removed once maintenance succeeds, kept only if maintenance fails (restore point).
- **`backup` config flag (default `false`)** — the snapshot (`VACUUM INTO`) and its removal are skipped entirely when `false`: a real prune then costs a single `VACUUM` pass instead of two (roughly half the time), at the price of no restore point. Set `true` only if you want a restore point on failure. The `report()` line shows `bak: enabled` when backup is configured, `bak: none` otherwise — no sizes (the `.bak` size is irrelevant). It never reads a stale `.bak` from disk.
- **Orphan `.bak` cleanup is conditional** — in the "no prune needed" branch, a leftover `.bak` is removed only when `backup` is `false` (dead weight; the user opted out of backups). With `backup: true` it is kept: it may be the restore point of a failed prune.
- **Speed pragmas are per-connection and ephemeral** — set inline in the prune `exec` (synchronous=NORMAL, temp_store=MEMORY, cache_size=5000, busy_timeout=5000, foreign_keys=ON), discarded on `close()`. They never touch opencode's own connection settings.
- **No `REINDEX`** — `VACUUM` rebuilds the entire database file including every index, so a `REINDEX` before `VACUUM` was pure wasted work (the old code did both). Removed; only `PRAGMA optimize` refreshes planner statistics after the prune.
- **Multi-instance safe (shared DB over WAL)** — opencode can run several instances on the same DB file. The prune's `DELETE`s are safe under WAL with concurrent readers and only touch sessions inactive > N days (a live instance keeps `time_updated` fresh, so its open session is never pruned). `VACUUM` needs an exclusive lock, so it is probed with `BEGIN IMMEDIATE` (short `busy_timeout`): if the DB is quiet — typically the *last* instance closing — it compacts; if `SQLITE_BUSY` (a sibling is live), compaction is deferred (logged, never a failure) and runs on a later quiet window. TEMP triggers are per-connection, so they never fire on a sibling's own deletes.
- **`synchronous=NORMAL`, not `OFF`** — the maintenance connection performs the destructive `DELETE`; `OFF` risks corruption on power loss in WAL mode, `NORMAL` stays fast and crash-safe. `cache_size=5000` (pages, ~20 MB) is enough for a DELETE+REINDEX workload.
- **`mmap_size` intentionally omitted** — memory-mapping a third-party DB was deemed unnecessary for a DELETE+REINDEX workload.
- **Install** — just copy `db-prunetor.ts` to `~/.config/opencode/plugins/`. No package.json, no tsconfig, no build step.
- **`enabled` flag** — if `false`, the plugin returns `{}` without registering the `dispose` hook.

## Coding conventions

- Tabs for indentation
- Allman braces
- `satisfies Plugin` on the default export
- `as const` for const objects
- `Bun.JSONC.parse()` for config reading
- Inline comments where they clarify non-obvious logic
- All error handlers use `catch { /* non-fatal */ }` pattern
- Config accessed via `this.config`; internal state held in instance fields
- `resolvePath()` expands a leading `~` to the user's home directory
- Docblock header: `@name` / `@version` / `@author` / `@assistant` / `@license` (in that order)
- Docblock lines: `*` at column 0, no leading space. When inserting lines into an existing block, copy the exact style of the neighboring lines — never re-type the block in the generic JSDoc style (leading-space ` *`), it creates a mixed docblock. Verified by Testing step 0.

## Testing

No formal test framework. Verify by:
0. `grep -n '^ \*' db-prunetor.ts` — must return **zero** matches (docblock hygiene: no leading-space star lines). Any match means the docblock was re-typed in generic JSDoc style; fix before building.
1. `bun build --target bun db-prunetor.ts` — must compile (plain `bun build` fails: `bun:sqlite` is a Bun builtin).
2. `cp db-prunetor.ts ~/.config/opencode/plugins/` and restart opencode.
3. Close opencode, then inspect `~/.config/opencode/db-prunetor.log` for:
    - `Integrity check: ok`
    - `Pruned rows total: N` / `no prune needed`
    - `Report — db: ... wal: ... shm: ... bak: ...`
4. Confirm opencode still loads old sessions correctly after a prune.
5. Confirm `opencode.db.bak` does **not** exist after a successful prune (it is removed). If maintenance fails, the `.bak` is kept as a restore point.

## Changelog

### v0.1.10
- Removed the redundant `backedUp` instance flag — `report()` now derives the `bak:` line directly from `config.backup` (`enabled` / `none`). The flag only ever mirrored the config.
- Dropped the dead hardcoded `CONFIG.db_path` default (it was always overwritten by `resolveDbPath()` in `loadConfig()` and ignored `OPENCODE_DB`/`XDG_DATA_HOME`). The default is now auto-resolved via `resolveDbPath()`, with the jsonc `db_path` override keeping priority.
- Docblock accuracy: removed the stale "rebuilds indexes" claim (the `REINDEX` step was already gone — `VACUUM` rebuilds indexes).

### v0.1.9
- Prune rewritten around TEMP `BEFORE DELETE` triggers: `pr_session_children` (cascades `part`/`message`/`event`/`event_sequence`/`todo`/`session_share`/`session_message`/`session_input`/`session_context_epoch` + repairs dangling `parent_id`) and `pr_project_children` (cascades `permission`/`workspace`/`project_directory`). One `DELETE FROM session` now drags every related row; empty projects swept by `DELETE FROM project WHERE NOT EXISTS (live session)`. No more temp tables, no per-table `run()` calls — the whole prune is a single `exec` inside one `BEGIN`/`COMMIT`.
- `REINDEX` removed: `VACUUM` already rebuilds the entire file including every index, so `REINDEX` before it was wasted work. Only `PRAGMA optimize` refreshes planner statistics now.
- `backup` default flipped to `false`: a real prune costs a single `VACUUM` pass instead of two (`VACUUM INTO` + `VACUUM`), roughly halving maintenance time. Set `true` for a restore point on failure.
- Speed pragmas (`synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size=5000`, `busy_timeout=5000`, `foreign_keys=ON`) moved inline into the prune `exec`; `applySpeedPragmas()` and the per-table `pruneAll`/`buildEligibleSets`/`count*`/`optimize`/`compact` helpers deleted.
- Total deleted rows reported via `total_changes()` delta (no per-table breakdown).
- Multi-instance safe: `VACUUM` is probed with `BEGIN IMMEDIATE` (short `busy_timeout`) and deferred with a clear log if the DB is in use by another opencode instance (`SQLITE_BUSY`); the data prune still happens, compaction just waits for a quiet window (typically the last instance closing). Never logs "Maintenance failed" for a deferred VACUUM.

### v0.1.8
- Full-table prune: every table belonging to inactive sessions is now deleted — `part`, `message`, `event`, `event_sequence`, `todo`, `session_share`, `session_message`, `session_input`, `session_context_epoch`, `session`, plus empty `project` (with `permission`/`workspace`/`project_directory`). Ordered FK-wise (children before parents) inside a single transaction. Before, only `event` was pruned — the bulk of the DB (`part`/`message`) never shrank.
- Gate reworked: counts eligible *sessions* + orphan rows (previously eligible *events*). Orphan sweep extended to `todo` (found 279) alongside `part`/`message`/`session_message`/`event`/`event_sequence`.
- Eligible set materialized once into `prune_sessions`/`prune_projects` temp tables (consistent snapshot, oldest-first), shared by every DELETE.
- Dangling `session.parent_id` repaired (`NULL` for children whose parent was pruned).
- `PRAGMA foreign_keys = ON` added to the maintenance connection as a safety net (deletes stay explicit and FK-ordered).
- Dry-run verified on a copy of the real DB: 292,947 rows removed, `integrity_check: ok`, `foreign_key_check` clean, 1.14 GB → 636 MB.

### v0.1.7
- `report()` simplified: `bak:` is now a boolean — `written this run` / `none` (backed by the `backedUp` flag only). Dropped the `bak:` size reporting from 0.1.6 and the `backedUpSize` field from the first 0.1.7 draft: the backup's size is irrelevant, only whether this run generated it. No disk reads in `report()`.

### v0.1.6
- New `backup` config flag (default `true`): when `false`, the pre-prune `VACUUM INTO` snapshot and its removal are skipped — a real prune costs a single `VACUUM` pass instead of two, roughly halving maintenance time. Tradeoff: no restore point on failure.
- New `backedUp` instance flag: `report()` shows the `.bak` size only when this run actually wrote a backup (`bak: n/a (not backed up this run)` otherwise). No more logs claiming a backup exists on runs that did nothing.
- "No prune needed" branch now removes leftover `.bak` files when `backup` is `false` (dead weight); with `backup: true` a leftover `.bak` is kept as a possible restore point from a failed run.

### v0.1.5
- Credit `Hy3` as assistant model in docblock and README.
- `db-prunetor.jsonc` example aligned with the docblock. README config example updated to match.

### v0.1.4

### v0.1.3
- Prune now actually reclaims disk space: after `DELETE` + `REINDEX` + `PRAGMA optimize`, the maintenance connection runs `VACUUM` followed by `wal_checkpoint(TRUNCATE)` (compaction only fires when a real prune happened). The DB file shrinks instead of leaving freed pages in the freelist.
- Docblock formatting unified (`*` at column 0, no leading space).

### v0.1.2
- `db_path` is now auto-detected the same way opencode resolves it: honors `OPENCODE_DB`, else the stable default `<dataDir>/opencode.db` (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). The `db_path` config key is now an optional override only — no fragile hardcoded path.

### v0.1.1
- Backup is now temporary and automatic: written to `<db_path>.bak` before the prune, removed on success, kept only on failure as a restore point.
- Removed `backup` and `backup_path` config keys — no user-facing knobs for the safety net.
- Removed unused `ctx` parameter from the plugin factory.

### v0.1.0
- Initial release: integrity gate, online `VACUUM INTO` backup, event prune by inactive-session age, `REINDEX`, `PRAGMA optimize`, all on `dispose`.
