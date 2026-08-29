# DB Prunetor (keep opencode's brain lean)

![Version](https://img.shields.io/badge/version-1.1.24-blue)
![License](https://img.shields.io/badge/license-AGPL%203.0-blue)
![OpenCode v1](https://img.shields.io/badge/OpenCode-v1-purple)

> opencode's SQLite database grows forever. Event-sourcing rows pile up from sessions you'll never reopen. Your AI should not choke on its own history.

## 💡 What it does

> Lightweight, automatic database maintenance. You do nothing.

- **Copy and it works** — single TypeScript file, native `bun:sqlite`. No npm, no node_modules, no drama.

- **Runs on startup** — maintenance fires in a detached Worker thread the moment opencode loads, fully off the main thread so startup is never blocked.

- **Integrity gate** — it first proves the database is healthy. A suspect database is never pruned.

- **Full prune, correct order** — deletes all data for sessions inactive beyond `prune_days`: parts, messages, the event journal, session metadata and the sessions themselves, plus any projects left empty. The database's own foreign keys (`ON DELETE CASCADE`) do the cascade: a single `DELETE FROM session` drags the whole subtree — parts, messages, todos, shares, inputs, context epochs — inside one transaction. Only `event_sequence` (the one child table with no FK to session) and empty projects are swept explicitly. Nothing dangles.

- **Reclaims the space** — after a real prune, the file is compacted (`VACUUM` + WAL truncate) so the freed space actually returns to disk, not just to the freelist. `VACUUM` needs an exclusive lock, so when several opencode instances share the DB it is deferred to a quiet window (typically when no other instance holds the DB) instead of failing. On a run with nothing to prune, the WAL is still truncated cheaply so it stays bounded.

## 🧠 Philosophy

Maintenance is a habit, not an emergency. A small, safe pass on every startup beats a scary 6 GB cleanup after months of neglect.

The plugin never blocks you, never touches opencode's own connection settings, and never mutates a database it cannot first prove is healthy.

## 🔄 How it works

```mermaid
flowchart TD
    A["🚀 opencode starts<br/>plugin spawns detached Worker"]
    A --> B["🗄️ Open its own connection<br/>(safe speed settings, discarded after)"]
    B --> C{"Database<br/>healthy?"}
    C -->|"❌ no"| Z["🛑 Abort — no prune"]
    C -->|"✅ yes"| G["🧹 One transaction, FK cascade:<br/>DELETE session → all children<br/>+ empty projects"]
    G --> E{"Rows<br/>deleted?"}
    E -->|"❌ no"| R["🗜️ Truncate WAL<br/>📝 Log: no prune needed"]
    R --> K
    E -->|"✅ yes"| H{"db ≥ vacuum_min_gb?"}
    H -->|"❌ no"| O["📊 PRAGMA optimize<br/>+ WAL truncate"]
    H -->|"✅ yes"| M["🗜️ VACUUM + WAL truncate"]
    M --> J["📋 Log: VACUUM + WAL checkpoint done<br/>Log report (sizes)"]
    M -->|"⚠️ DB in use"| D["📝 Log: Compaction deferred"]
    O --> K
    J --> K["🔚 Close connection"]
    D --> K

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style B fill:#0f3460,stroke:#53a8b6,color:#fff
    style C fill:#16213e,stroke:#e94560,color:#fff
    style E fill:#16213e,stroke:#e94560,color:#fff
    style G fill:#0f3460,stroke:#53a8b6,color:#fff
    style H fill:#16213e,stroke:#e94560,color:#fff
    style O fill:#0f3460,stroke:#53a8b6,color:#fff
    style M fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
    style D fill:#1a1a2e,stroke:#e94560,color:#fff
    style K fill:#1a1a2e,stroke:#e94560,color:#fff
    style R fill:#1a1a2e,stroke:#e94560,color:#fff
    style Z fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🎯 Use cases

**Disk creep.** After weeks of sessions, `opencode.db` grows as parts, messages and the event journal pile up from sessions you'll never reopen. The plugin trims the dead weight on every startup.

**Replay safety.** Event-sourcing rows are only needed to reconstruct old sessions. Once a session goes inactive, its rows are dead weight — and a session that goes inactive for good is removed entirely, along with the project that ends up empty.

**Peace of mind.** An integrity gate means a prune can never be the thing that breaks your history.

## 🚀 Installation

```bash
cp db-prunetor.ts ~/.config/opencode/plugins/db-prunetor.ts
cp db-prunetor.jsonc ~/.config/opencode/db-prunetor.jsonc
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively. Restart opencode; maintenance runs automatically on startup (in a background Worker).

## ⚙️ Configuration

Copy `db-prunetor.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,             // master switch
	"prune_days": 30,            // delete sessions inactive > N days (and all their data)
	// "db_path":                // optional override; auto-detected if omitted
	"log_level": "info",         // "silent" | "error" | "info" | "debug"
	"vacuum_min_gb": 1           // only VACUUM when db file >= N GB; 0 = always vacuum after a prune
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `prune_days` | `30` | Delete sessions inactive beyond this many days — and every table belonging to them |
| `db_path` | *auto-detected* | Optional override for opencode's database location |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |
| `vacuum_min_gb` | `1` | Only `VACUUM` when the db file is ≥ N GB; `0` = always vacuum after a prune |

**Database location is automatic.** The plugin resolves opencode's database the same way opencode itself does: it honors the `OPENCODE_DB` environment variable, and otherwise falls back to the stable default `<dataDir>/opencode.db` (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). You only set `db_path` to override when necessary.

## 🪵 Logs

`~/.config/opencode/db-prunetor.log` (append-only). Format: `[TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/db-prunetor.log
```

```log
[2026-08-25T12:39:29] [INFO]: Config loaded
[2026-08-25T12:39:29] [INFO]: Initialized
[2026-08-25T12:39:30] [INFO]: Integrity check: ok
[2026-08-25T12:39:32] [INFO]: Pruned rows total: 292947
[2026-08-25T12:39:34] [INFO]: VACUUM + WAL checkpoint done
[2026-08-25T12:39:34] [INFO]: Report — db: 636.8 MB, wal: 0 B, shm: 1.3 MB
[2026-08-25T12:39:34] [INFO]: Maintenance complete
[2026-08-25T12:45:00] [INFO]: Integrity check: ok
[2026-08-25T12:45:00] [INFO]: No prune needed
[2026-08-25T12:45:00] [INFO]: Maintenance complete
[2026-08-25T13:00:00] [INFO]: Integrity check: ok
[2026-08-25T13:00:01] [INFO]: Pruned rows total: 12345
[2026-08-25T13:00:01] [INFO]: Compaction deferred (database in use by another instance): database is locked
[2026-08-25T13:00:01] [INFO]: Maintenance complete
```

## 💬 Notes

- **Runs on startup, off the main thread** — the plugin spawns a detached Worker that prunes while you're already using opencode, so startup is never blocked.
- **Health first** — nothing is touched until the database proves it's healthy.
- **Recency matters** — a session counts as "inactive" when it hasn't been touched in `prune_days` days. Its whole subtree goes with it; recent sessions are never touched.
- **Orphaned rows go too** — parts, messages, events and todos whose session no longer exists (cleared or migrated sessions) are swept on the same run, so nothing dangles.
- **Your opencode stays untouched** — the plugin works on its own connection with sensible speed settings, discarded when the job is done. It never touches opencode's own connection.
- **Space is really reclaimed** — a real `VACUUM` runs only after a real prune, so the file actually shrinks without paying the cost on every startup; when nothing is pruned only the WAL is truncated. When several opencode instances share the DB, `VACUUM` is deferred to a quiet window (logged as `Compaction deferred`) instead of failing — a quiet window (typically when no other instance holds the DB) does the compaction.
- **Size-aware compaction** — `VACUUM` only runs when the database file is at least `vacuum_min_gb` (default `1` GB); smaller databases get a WAL checkpoint only, skipping the heavier `VACUUM` pass. Set `vacuum_min_gb: 0` to always `VACUUM` after a prune.
- **Multi-instance safe** — opencode can run several instances on the same DB over WAL. The prune's `DELETE`s are safe with concurrent readers and only touch sessions inactive beyond `prune_days` (a live instance keeps its open session's `time_updated` fresh). The cascade triggers are `TEMP`, so they never fire on a sibling instance's own deletes.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- Hy3 — assistant model during development

## 📄 License

AGPL-3.0 — version 1.1.24
