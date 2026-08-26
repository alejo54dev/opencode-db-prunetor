# DB Prunetor (keep opencode's brain lean)

![Version](https://img.shields.io/badge/version-0.1.13-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode v1](https://img.shields.io/badge/OpenCode-v1-purple)

> opencode's SQLite database grows forever. Event-sourcing rows pile up from sessions you'll never reopen. Your AI should not choke on its own history.

## 💡 What it does

> Lightweight, automatic database maintenance. You do nothing.

- **Copy and it works** — single TypeScript file, native `bun:sqlite`. No npm, no node_modules, no drama.

- **Runs on close** — maintenance fires on session `dispose`, when opencode releases its database connection. Zero startup cost, minimal contention.

- **Integrity gate** — it first proves the database is healthy. A suspect database is never pruned.

- **Safe online backup** — when `backup: true`, a consistent snapshot is written before any destructive change (default `false` for speed — a single `VACUUM` pass, no restore point). No lock on the live database.

- **Full prune, correct order** — deletes all data for sessions inactive beyond `prune_days`: parts, messages, the event journal, session metadata and the sessions themselves, plus any projects left empty. Two `TEMP` `BEFORE DELETE` triggers cascade every child of a deleted session/project, so one `DELETE FROM session` drags the whole subtree inside a single transaction — nothing dangles, and the triggers vanish when the connection closes (they never touch opencode's own schema).

- **Orphan sweep** — rows left behind when opencode itself deletes sessions (cleared or migrated) are dead weight; they get swept on the same run.

- **Reclaims the space** — after a real prune, the file is compacted (`VACUUM` + WAL truncate) so the freed space actually returns to disk, not just to the freelist. `VACUUM` needs an exclusive lock, so when several opencode instances share the DB it is deferred to a quiet window (typically the last instance to close) instead of failing.

## 🧠 Philosophy

Maintenance is a habit, not an emergency. A small, safe pass on every session close beats a scary 6 GB cleanup after months of neglect.

The plugin never blocks you, never touches opencode's own connection settings, and never mutates a database it cannot first prove is healthy.

## 🔄 How it works

```mermaid
flowchart TD
    A["🔌 Session closes<br/>dispose hook fires"]
    A --> B["🗄️ Open its own connection<br/>(safe speed settings, discarded after)"]
    B --> C{"Database<br/>healthy?"}
    C -->|"❌ no"| Z["🛑 Abort — no prune"]
    C -->|"✅ yes"| D["📋 Snapshot eligible sets<br/>sessions inactive > prune_days<br/>+ orphan rows"]
    D --> E{"Eligible sessions<br/>or orphans?"}
    E -->|"❌ no"| R["📝 Log: no prune needed"]
    E -->|"✅ yes"| F["💾 Online backup<br/>(if backup enabled)"]
    F --> G["🧹 One transaction, TEMP triggers cascade:<br/>DELETE session → all children<br/>+ orphan sweep + empty projects"]
    G --> I["📊 Refresh planner stats (PRAGMA optimize)"]
    I --> M["🗜️ Compact (VACUUM + WAL truncate)<br/>deferred if DB in use"]
    M --> L["🗑️ Remove backup<br/>(success)"]
    R --> J["📋 Log report (sizes)"]
    L --> J
    J --> K["🔚 Close connection"]

    style A fill:#1a1a2e,stroke:#e94560,color:#fff
    style B fill:#0f3460,stroke:#53a8b6,color:#fff
    style C fill:#16213e,stroke:#e94560,color:#fff
    style D fill:#0f3460,stroke:#53a8b6,color:#fff
    style E fill:#16213e,stroke:#e94560,color:#fff
    style F fill:#0f3460,stroke:#53a8b6,color:#fff
    style G fill:#0f3460,stroke:#53a8b6,color:#fff
    style I fill:#0f3460,stroke:#53a8b6,color:#fff
    style M fill:#0f3460,stroke:#53a8b6,color:#fff
    style L fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
    style K fill:#1a1a2e,stroke:#e94560,color:#fff
    style R fill:#1a1a2e,stroke:#e94560,color:#fff
    style Z fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🎯 Use cases

**Disk creep.** After weeks of sessions, `opencode.db` grows as parts, messages and the event journal pile up from sessions you'll never reopen. The plugin trims the dead weight on every close.

**Replay safety.** Event-sourcing rows are only needed to reconstruct old sessions. Once a session goes inactive, its rows are dead weight — and a session that goes inactive for good is removed entirely, along with the project that ends up empty.

**Peace of mind.** An integrity gate plus an automatic online backup means a prune can never be the thing that breaks your history.

## 🚀 Installation

```bash
cp db-prunetor.ts ~/.config/opencode/plugins/db-prunetor.ts
cp db-prunetor.jsonc ~/.config/opencode/db-prunetor.jsonc
```

No npm, no build step, no dependencies. OpenCode runs TypeScript natively. Restart opencode; maintenance runs automatically on close.

## ⚙️ Configuration

Copy `db-prunetor.jsonc` (included in this repo) to `~/.config/opencode/` and edit:

```jsonc
{
	"enabled": true,             // master switch
	"prune_days": 30,            // delete sessions inactive > N days (and all their data)
	"backup": false,             // pre-prune snapshot (<db_path>.bak); false = faster (single VACUUM), no restore point
	// "db_path":                // optional override; auto-detected if omitted
	"log_level": "info"          // "silent" | "error" | "info" | "debug"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `prune_days` | `30` | Delete sessions inactive beyond this many days — and every table belonging to them |
| `backup` | `false` | Pre-prune snapshot at `<db_path>.bak`. `true` = restore point on failure, but prune + compact costs two `VACUUM` passes (roughly twice the time). `false` = single `VACUUM` pass |
| `db_path` | *auto-detected* | Optional override for opencode's database location |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |

**Database location is automatic.** The plugin resolves opencode's database the same way opencode itself does: it honors the `OPENCODE_DB` environment variable, and otherwise falls back to the stable default `<dataDir>/opencode.db` (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). You only set `db_path` to override when necessary.

The pre-prune backup is written automatically to `<db_path>.bak` (same directory as the database). It is a temporary safety net: kept only if maintenance fails, removed once the prune succeeds. No configuration needed — unless you want speed over safety: with `"backup": false` the snapshot is skipped entirely and a prune costs a single `VACUUM` pass instead of two.

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
[2026-08-25T12:39:34] [INFO]: Vacuum + wal checkpoint done
[2026-08-25T12:39:34] [INFO]: Report — db: 636.8 MB, wal: 0 B, shm: 1.3 MB, bak: none
[2026-08-25T12:39:34] [INFO]: Disposed
[2026-08-25T12:45:00] [INFO]: Integrity check: ok
[2026-08-25T12:45:00] [INFO]: No prune needed
[2026-08-25T12:45:00] [INFO]: Report — db: 636.8 MB, wal: 4.0 MB, shm: 32.0 KB, bak: none
[2026-08-25T12:45:00] [INFO]: Disposed
[2026-08-25T13:00:00] [INFO]: Integrity check: ok
[2026-08-25T13:00:01] [INFO]: Pruned rows total: 12345
[2026-08-25T13:00:01] [INFO]: Compaction deferred (database in use by another instance): database is locked
[2026-08-25T13:00:01] [INFO]: Report — db: 700.0 MB, wal: 12.0 MB, shm: 32.0 KB, bak: none
[2026-08-25T13:00:01] [INFO]: Disposed
```

## 💬 Notes

- **Runs on close, not on startup** — when opencode finishes a session, it releases its database. That's the perfect moment: minimal contention, zero impact on how fast sessions start.
- **Health first** — nothing is touched until the database proves it's healthy.
- **Snapshot before surgery** — a consistent backup is written to `<db_path>.bak` before anything is deleted, without locking the live database. On success it is removed automatically; on failure it stays as a restore point. With `"backup": false` there is no snapshot: the prune becomes a single `VACUUM` pass, but a failed prune has nothing to restore from. The log reports whether backup is configured (`bak: enabled` / `bak: none`) — no sizes.
- **Recency matters** — a session counts as "inactive" when it hasn't been touched in `prune_days` days. Its whole subtree goes with it; recent sessions are never touched.
- **Orphaned rows go too** — parts, messages, events and todos whose session no longer exists (cleared or migrated sessions) are swept on the same run, so nothing dangles.
- **Your opencode stays untouched** — the plugin works on its own connection with sensible speed settings, discarded when the job is done. It never touches opencode's own connection.
- **Space is really reclaimed** — compaction (`VACUUM` + WAL truncate) only runs after a real prune, so the file actually shrinks without paying the cost on every close. When several opencode instances share the DB, `VACUUM` is deferred to a quiet window (logged as `Compaction deferred`) instead of failing — the last instance to close usually does the compaction.
- **Multi-instance safe** — opencode can run several instances on the same DB over WAL. The prune's `DELETE`s are safe with concurrent readers and only touch sessions inactive beyond `prune_days` (a live instance keeps its open session's `time_updated` fresh). The cascade triggers are `TEMP`, so they never fire on a sibling instance's own deletes.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- Hy3 — assistant model during development

## 📄 License

MIT — version 0.1.13
