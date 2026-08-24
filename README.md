# DB Prunetor (keep opencode's brain lean)

![Version](https://img.shields.io/badge/version-0.1.2-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![OpenCode](https://img.shields.io/badge/OpenCode-plugin-purple)

> opencode's SQLite database grows forever. Event-sourcing rows pile up from sessions you'll never reopen. Your AI should not choke on its own history.

## 💡 What it does

> Lightweight, automatic database maintenance. You do nothing.

- **Copy and it works** — single TypeScript file, native `bun:sqlite`. No npm, no node_modules, no drama.

- **Runs on close** — maintenance fires on session `dispose`, when opencode releases its database connection. Zero startup cost, minimal contention.

- **Integrity gate** — it first proves the database is healthy. A suspect database is never pruned.

- **Safe online backup** — before any destructive change, a consistent snapshot of the database is written. No lock on the live database.

- **Event pruning** — deletes event history from sessions you haven't touched in a while, then rebuilds indexes and refreshes planner statistics to keep everything fast.

- **Ligero en vivo** — the database stays fully usable while the plugin works. No heavy compaction: the file keeps its size, the freed space is simply reused.

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
    C -->|"✅ yes"| D["🔢 Count eligible events<br/>(session inactive > prune_days)"]
    D --> E{"Eligible > 0?"}
    E -->|"❌ no"| R["📝 Log: no prune needed"]
    E -->|"✅ yes"| F["💾 Online backup<br/>(consistent snapshot)"]
    F --> G["🧹 Delete old events"]
    G --> H["🔧 Rebuild indexes"]
    H --> I["📊 Refresh planner stats"]
    I --> L["🗑️ Remove backup<br/>(success)"]
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
    style H fill:#0f3460,stroke:#53a8b6,color:#fff
    style I fill:#0f3460,stroke:#53a8b6,color:#fff
    style L fill:#0f3460,stroke:#53a8b6,color:#fff
    style J fill:#1a1a2e,stroke:#e94560,color:#fff
    style K fill:#1a1a2e,stroke:#e94560,color:#fff
    style R fill:#1a1a2e,stroke:#e94560,color:#fff
    style Z fill:#1a1a2e,stroke:#e94560,color:#fff
```

## 🎯 Use cases

**Disk creep.** After weeks of sessions, `opencode.db-wal` and the `event` table bloat. The plugin trims the dead weight on every close.

**Replay safety.** Event-sourcing rows are only needed to reconstruct old sessions. Once a session goes inactive, its events are dead weight — the current state lives in `message`/`part`.

**Peace of mind.** An integrity gate plus an automatic online backup mean a prune can never be the thing that breaks your history.

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
	"prune_days": 30,            // delete events from sessions inactive > N days
	// "db_path": "~/.local/share/opencode/opencode.db",  // optional override; auto-detected if omitted
	"log_level": "info"          // "silent" | "error" | "info" | "debug"
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `prune_days` | `30` | Delete events from sessions inactive beyond this many days |
| `db_path` | *auto-detected* | Optional override for opencode's database location |
| `log_level` | `"info"` | `"silent"`, `"error"`, `"info"`, `"debug"` |

**Database location is automatic.** The plugin resolves opencode's database the same way opencode itself does: it honors the `OPENCODE_DB` environment variable, and otherwise falls back to the stable default `<dataDir>/opencode.db` (`$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`). You only set `db_path` to override when necessary.

The pre-prune backup is written automatically to `<db_path>.bak` (same directory as the database). It is a temporary safety net: kept only if maintenance fails, removed once the prune succeeds. No configuration needed.

## 🪵 Logs

`~/.config/opencode/db-prunetor.log` (append-only). Format: `[TIMESTAMP] [LEVEL] message`.

```bash
tail -f ~/.config/opencode/db-prunetor.log
```

```log
[2026-08-23T21:30:00] [INFO]: Config loaded
[2026-08-23T21:30:01] [INFO]: Initialized
[2026-08-23T22:15:00] [INFO]: Integrity check: ok
[2026-08-23T22:15:00] [INFO]: Eligible events (inactive > 30d): 454878
[2026-08-23T22:15:02] [INFO]: Backup written: /home/alejo/.local/share/opencode/opencode.db.bak (1.17 GB)
[2026-08-23T22:15:05] [INFO]: Pruned events: 454878
[2026-08-23T22:15:06] [INFO]: Reindex + optimize done
[2026-08-23T22:15:06] [INFO]: Backup removed: /home/alejo/.local/share/opencode/opencode.db.bak
[2026-08-23T22:15:06] [INFO]: Report — db: 1.17 GB, wal: 0.6 MB, shm: 32 KB, bak: absent
[2026-08-23T22:15:06] [INFO]: Disposed
```

## 💬 Notes

- **Runs on close, not on startup** — when opencode finishes a session, it releases its database. That's the perfect moment: minimal contention, zero impact on how fast sessions start.
- **Health first** — nothing is touched until the database proves it's healthy.
- **Snapshot before surgery** — a consistent backup is written to `<db_path>.bak` before anything is deleted, without locking the live database. On success it is removed automatically; on failure it stays as a restore point.
- **Recency matters** — a session counts as "inactive" when it hasn't been touched in `prune_days` days; its event history goes with it, while your messages stay intact.
- **Your opencode stays untouched** — the plugin works on its own connection with sensible speed settings, discarded when the job is done. It never touches opencode's own connection.
- **Ligero en vivo** — no heavy compaction: the file keeps its size and the freed space is reused.

Less is more. :)

## 👤 Authors

- Alejandro Carraretto
- DeepSeek-V4 — assistant model during development

## 📄 License

MIT — version 0.1.2
