/**
*	db-prunetor.ts
*
*	OpenCode plugin — automatic lightweight maintenance of opencode's
*	SQLite database (~/.local/share/opencode/opencode.db).
*
*	Runs on session dispose (opencode closing): verifies integrity, enforces
*	performance pragmas (journal_mode=WAL, cache_size=25000, page_size=8192,
*	auto_vacuum=OFF, etc.), prunes every table belonging to sessions inactive
*	beyond N days — parts, messages, the event journal, session metadata and
*	the sessions themselves, plus projects left empty — in FK order (children
*	before parents), sweeps rows orphaned by already-deleted sessions,
*	refreshes planner statistics, and compacts the file (VACUUM + WAL truncate)
*	to reclaim the freed space. Safe to run while opencode is live (everything
*	goes through the WAL); the heavy VACUUM only fires after a real prune.
*
*	Install: cp db-prunetor.ts ~/.config/opencode/plugins/db-prunetor.ts
*	Config:  ~/.config/opencode/db-prunetor.jsonc
*	Log:     ~/.config/opencode/db-prunetor.log
*
*	@example ~/.config/opencode/db-prunetor.jsonc
*	{
*		"enabled": true,             // master switch
*		"prune_days": 30,            // delete sessions inactive > N days (and all their data)
*		"backup": false,             // pre-prune snapshot (<db_path>.bak); false = faster (single VACUUM), no restore point
*		// "db_path":                // optional override; auto-detected if omitted
*		"log_level": "info"          // "silent" | "error" | "info" | "debug"
*	}
*
*	@name db-prunetor
*	@version 0.1.12
*	@author Alejandro Carraretto
*	@assistant Hy3
*	@license MIT
*/

import type { Plugin } from "@opencode-ai/plugin" ;
import { Database } from "bun:sqlite" ;
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { isAbsolute, join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "db-prunetor.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "db-prunetor.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG =
{
	enabled     : true,
	prune_days  : 30,
	backup      : false,
	db_path     : resolveDbPath(),
	log_level   : "info" as "silent" | "error" | "info" | "debug",
} ;

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3,
} as const ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled     : boolean ;
	prune_days  : number ;
	backup      : boolean ;
	db_path     : string ;
	log_level   : string ;
}

// ─── Global Helpers ──────────────────────────────────────────────────────────

// Current local datetime as ISO-like string: "2026-07-06T20:30:26"
function timestamp() : string
{
	const utc    = new Date() ;
	const offset = utc.getTimezoneOffset() ;
	const local  = new Date( utc.getTime() - offset * 60 * 1000 ) ;

	return local.toISOString().slice( 0, 19 ) ;
}

// Load config from ~/.config/opencode/db-prunetor.jsonc, fall back to defaults
function loadConfig() : typeof CONFIG
{
	let file : Record<string, unknown> = {} ;
	try
	{
		file = Bun.JSONC.parse( readFileSync( CONFIG_FILE, "utf-8" ) ) ;
	}
	catch
	{
		log( LOG_LEVEL.ERROR, `Config not found or parse error at ${ CONFIG_FILE }` ) ;
	}

	CONFIG.enabled     = file.enabled                       ?? CONFIG.enabled ;
	CONFIG.prune_days  = Math.max( 1, file.prune_days       ?? CONFIG.prune_days ) ;
	CONFIG.backup      = file.backup                        ?? CONFIG.backup ;
	CONFIG.db_path     = file.db_path    ? resolvePath( String( file.db_path ) )    : resolveDbPath() ;
	CONFIG.log_level   = file.log_level                      ?? CONFIG.log_level ;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;

	return CONFIG ;
}

// Append timestamped entry to ~/.config/opencode/db-prunetor.log
function log( level : number, message : string ) : void
{
	const min = LOG_LEVEL[ ( CONFIG.log_level ?? "info" ).toUpperCase() ] ?? LOG_LEVEL.ERROR ;

	if ( level > min ) return ;

	const label = Object.keys( LOG_LEVEL )[ level ] ?? "" ;

	try
	{
		appendFileSync( LOG_FILE, `[${ timestamp() }] [${ label }]: ${ message }\n` ) ;
	}
	catch {}
}

// Expand a leading "~" to the user's home directory
function resolvePath( p : string ) : string
{
	if ( p.startsWith( "~" ) )
		p = join( homedir(), p.slice( 1 ) ) ;

	return p ;
}

// opencode's data directory: $XDG_DATA_HOME/opencode or ~/.local/share/opencode
function dataDir() : string
{
	return process.env.XDG_DATA_HOME
		? join( process.env.XDG_DATA_HOME, "opencode" )
		: join( homedir(), ".local", "share", "opencode" ) ;
}

// Mirror opencode's own DB-path resolution (its internal G4()):
// OPENCODE_DB env wins (absolute / :memory: as-is, else relative to data dir);
// otherwise the stable default <dataDir>/opencode.db.
function resolveDbPath() : string
{
	const env = process.env.OPENCODE_DB ;

	if ( env )
	{
		if ( env === ":memory:" || isAbsolute( env ) ) return env ;

		return join( dataDir(), env ) ;
	}

	return join( dataDir(), "opencode.db" ) ;
}

// Escape a string for embedding inside a single-quoted SQL literal
function sqlString( p : string ) : string
{
	return p.replace( /'/g, "''" ) ;
}

// Human-readable size of a file, or "absent" if missing
function fileSize( p : string ) : string
{
	try
	{
		if ( ! existsSync( p ) ) return "absent" ;

		const bytes = statSync( p ).size ;

		if ( bytes < 1024 ) return `${bytes} B` ;
		if ( bytes < 1024 * 1024 ) return `${( bytes / 1024 ).toFixed( 1 ) } KB` ;
		if ( bytes < 1024 * 1024 * 1024 ) return `${( bytes / ( 1024 * 1024 ) ).toFixed( 1 ) } MB` ;

		return `${( bytes / ( 1024 * 1024 * 1024 ) ).toFixed( 2 ) } GB` ;
	}
	catch
	{
		return "?" ;
	}
}

// ─── DbPrunetor ────────────────────────────────────────────────────────────

// Controller class: holds all plugin state and logic.
class DbPrunetor
{
	private config : typeof CONFIG ;
	private db : Database | null = null ;

	// Initialize: store config, no side effects, no DB open
	constructor( config : typeof CONFIG )
	{
		this.config = config ;
	}

	// ── Internal helpers ───────────────────────────────────────────────

	// Open the database on this ephemeral connection. Persistent pragmas
	// (journal_mode, auto_vacuum, wal_autocheckpoint, journal_size_limit)
	// are set once here; they survive reconexiones and are reinforced by
	// VACUUM at the end of maintenance.
	protected connect( path : string ) : void
	{
		this.db = new Database( path ) ;
		this.db.exec(
			`PRAGMA journal_mode       = WAL ;
			 PRAGMA journal_size_limit = 0 ;
			 PRAGMA wal_autocheckpoint = 1000 ;
			 PRAGMA auto_vacuum        = OFF ;`
		) ;
	}

	// Close the database and release the connection
	protected disconnect() : void
	{
		try { this.db?.close() ; } catch {}
		this.db = null ;
	}

	// Integrity gate — never mutate a suspect database
	protected checkIntegrity() : boolean
	{
		const rows = this.db!.prepare( "PRAGMA integrity_check" ).all() as Array<{ integrity_check : string }> ;
		const ok   = rows.length > 0 && rows.every( r => r.integrity_check === "ok" ) ;

		if ( ok )
			log( LOG_LEVEL.INFO, "Integrity check: ok" ) ;
		else
			log( LOG_LEVEL.ERROR, `Integrity check FAILED — aborting: ${ JSON.stringify( rows ) }` ) ;

		return ok ;
	}

	// Backup lives next to the db: "<db_path>.bak"
	protected backupPath() : string
	{
		return this.config.db_path + ".bak" ;
	}

	// Temporary pre-prune safety backup via VACUUM INTO (consistent snapshot,
	// no lock on live DB). Removed automatically once maintenance succeeds.
	// Skipped entirely when backup is disabled: prune then costs a single
	// VACUUM pass instead of two, at the price of no restore point.
	protected backup() : void
	{
		if ( ! this.config.backup ) return ;

		const path = this.backupPath() ;

		if ( existsSync( path ) ) rmSync( path, { force : true } ) ;

		this.db!.exec( `VACUUM INTO '${ sqlString( path ) }'` ) ;

		log( LOG_LEVEL.INFO, `Backup written: ${ path } (${ fileSize( path ) })` ) ;
	}

	// Remove the temporary pre-prune backup once maintenance succeeded
	protected removeBackup() : void
	{
		const path = this.backupPath() ;

		if ( existsSync( path ) )
		{
			rmSync( path, { force : true } ) ;
			log( LOG_LEVEL.INFO, `Backup removed: ${ path }` ) ;
		}
	}

	// Log database / wal / shm sizes and whether the backup was written this run
	protected report() : void
	{
		const dbPath = this.config.db_path ;

		log( LOG_LEVEL.INFO,
			`Report — db: ${ fileSize( dbPath ) }, ` +
			`wal: ${ fileSize( dbPath + "-wal" ) }, ` +
			`shm: ${ fileSize( dbPath + "-shm" ) }, ` +
			`bak: ${ this.config.backup ? "enabled" : "none" }`
		) ;
	}

	// Orchestrate maintenance on an open connection.
	//
	// One integrity gate, one gate-count, then a single exec: TEMP triggers
	// cascade every child of a deleted session (and every child of a deleted
	// project), so one DELETE FROM session drags all related rows; orphaned
	// rows (session already gone) and empty projects are swept in the same
	// transaction. VACUUM runs outside the txn. REINDEX is deliberately absent
	// — VACUUM rebuilds the whole file (indexes included), so REINDEX before
	// it would be wasted work.
	protected maintain() : void
	{
		const days = this.config.prune_days ;

		// 1) integrity gate — never mutate a suspect database
		if ( ! this.checkIntegrity() ) return ;

		// 2) gate: anything to prune? (eligible sessions + already-orphaned rows)
		const pending = this.db!.prepare(
			`SELECT
				( SELECT COUNT(*) FROM session WHERE time_updated < strftime( '%s', 'now', '-' || ? || ' days' ) * 1000 )
				+ ( SELECT COUNT(*) FROM part            WHERE session_id   NOT IN ( SELECT id FROM session ) )
				+ ( SELECT COUNT(*) FROM message         WHERE session_id   NOT IN ( SELECT id FROM session ) )
				+ ( SELECT COUNT(*) FROM event           WHERE aggregate_id NOT IN ( SELECT id FROM session ) )
				+ ( SELECT COUNT(*) FROM event_sequence  WHERE aggregate_id NOT IN ( SELECT id FROM session ) )
				+ ( SELECT COUNT(*) FROM todo            WHERE session_id   NOT IN ( SELECT id FROM session ) )
				+ ( SELECT COUNT(*) FROM session_message WHERE session_id   NOT IN ( SELECT id FROM session ) )
				AS c`
		).get( days ) as { c : number } ;

		if ( ! pending || pending.c === 0 )
		{
			log( LOG_LEVEL.INFO, "No prune needed" ) ;

		this.removeBackup() ;

			return ;
		}

		// 3) optional pre-prune snapshot (no-op when backup is false)
		this.backup() ;

		// 4) one-shot prune. BEFORE triggers delete children before the parent
		//    row goes (so foreign_keys=ON never sees a dangling reference); the
		//    session trigger also nulls parent_id of kept children. Triggers are
		//    TEMP — they vanish when this connection closes, never touching
		//    opencode's own schema.
		const before = ( this.db!.prepare( "SELECT total_changes() AS c" ).get() as { c : number } ).c ;

		this.db!.exec(
			`PRAGMA synchronous          = NORMAL ;
			 PRAGMA temp_store           = MEMORY ;
			 PRAGMA page_size            = 8192 ;
			 PRAGMA cache_size           = 25000 ;
			 PRAGMA cache_spill          = ON ;
			 PRAGMA automatic_index      = ON ;
			 PRAGMA recursive_triggers   = ON ;
			 PRAGMA foreign_keys         = ON ;
			 PRAGMA defer_foreign_keys   = OFF ;
			 PRAGMA threads              = 4 ;
			 PRAGMA busy_timeout         = 5000 ;

			 CREATE TEMP TRIGGER pr_session_children BEFORE DELETE ON session BEGIN
				DELETE FROM part            WHERE session_id   = OLD.id ;
				DELETE FROM message         WHERE session_id   = OLD.id ;
				DELETE FROM event           WHERE aggregate_id = OLD.id ;
				DELETE FROM event_sequence  WHERE aggregate_id = OLD.id ;
				DELETE FROM todo            WHERE session_id   = OLD.id ;
				DELETE FROM session_share   WHERE session_id   = OLD.id ;
				DELETE FROM session_message WHERE session_id   = OLD.id ;
				DELETE FROM session_input   WHERE session_id   = OLD.id ;
				DELETE FROM session_context_epoch WHERE session_id = OLD.id ;
				UPDATE session SET parent_id = NULL WHERE parent_id = OLD.id ;
			 END ;

			 CREATE TEMP TRIGGER pr_project_children BEFORE DELETE ON project BEGIN
				DELETE FROM permission        WHERE project_id = OLD.id ;
				DELETE FROM workspace         WHERE project_id = OLD.id ;
				DELETE FROM project_directory WHERE project_id = OLD.id ;
			 END ;

			 BEGIN ;
				DELETE FROM session WHERE time_updated < strftime( '%s', 'now', '-' || ${ days } || ' days' ) * 1000 ;
				DELETE FROM part            WHERE session_id   NOT IN ( SELECT id FROM session ) ;
				DELETE FROM message         WHERE session_id   NOT IN ( SELECT id FROM session ) ;
				DELETE FROM event           WHERE aggregate_id NOT IN ( SELECT id FROM session ) ;
				DELETE FROM event_sequence  WHERE aggregate_id NOT IN ( SELECT id FROM session ) ;
				DELETE FROM todo            WHERE session_id   NOT IN ( SELECT id FROM session ) ;
				DELETE FROM session_message WHERE session_id   NOT IN ( SELECT id FROM session ) ;
				DELETE FROM project         WHERE NOT EXISTS          ( SELECT 1 FROM session s WHERE s.project_id = project.id ) ;
			 COMMIT ;`
		) ;

		const deleted = ( this.db!.prepare( "SELECT total_changes() AS c" ).get() as { c : number } ).c - before ;

		log( LOG_LEVEL.INFO, `Pruned rows total: ${ deleted }` ) ;

		// 5) refresh planner statistics (VACUUM below already rebuilds indexes)
		this.db!.exec( "PRAGMA optimize" ) ;

		// 6) reclaim space — but only when no other instance holds the DB.
		//    opencode may run several instances sharing one DB over WAL; a
		//    closing instance must not block or fail while siblings are live.
		//    Probe with BEGIN IMMEDIATE (short timeout): if we take the lock the
		//    DB is quiet — typically the last instance closing — so VACUUM +
		//    wal_checkpoint(TRUNCATE) runs. If BUSY, another instance is active:
		//    defer compaction (the data is already pruned) and let a later quiet
		//    window do it. VACUUM lives in its own guarded block so a transient
		//    BUSY is logged as "deferred", never as "Maintenance failed".
		try
		{
			this.db!.exec( "PRAGMA busy_timeout = 1000" ) ;
			this.db!.exec( "BEGIN IMMEDIATE" ) ;
			this.db!.exec( "COMMIT" ) ;
			this.db!.exec( "PRAGMA page_size = 8192 ; VACUUM ; PRAGMA wal_checkpoint(TRUNCATE)" ) ;
			log( LOG_LEVEL.INFO, "Vacuum + wal checkpoint done" ) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.INFO, `Compaction deferred (database in use by another instance): ${ ( err as Error ).message }` ) ;
		}

		// 7) success — drop the temporary backup
		this.removeBackup() ;
	}

	// ── Public hooks ──────────────────────────────────────────────────

	// Maintenance on session close: open -> maintain -> report -> close
	public async dispose() : Promise<void>
	{
		const dbPath = this.config.db_path ;

		if ( ! existsSync( dbPath ) )
		{
			log( LOG_LEVEL.ERROR, `Database not found at ${ dbPath } — skipping` ) ;
			return ;
		}

		try
		{
			// Clean up any orphan .bak left by a previous run (failed or interrupted)
			this.removeBackup() ;

			this.connect( dbPath ) ;
			this.maintain() ;
			this.report() ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `Maintenance failed: ${( err as Error ).message }` ) ;
		}
		finally
		{
			this.disconnect() ;
		}

		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, build DbPrunetor, register dispose hook
export default ( async () =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const inst = new DbPrunetor( opts ) ;

	log( LOG_LEVEL.INFO, "Initialized" ) ;

	return {
		// Maintenance runs on session close (opencode releasing its DB connection)
		dispose : async () =>
		{
			await inst.dispose() ;
		},
	} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
