/**
*	db-prunetor.ts
*
*	OpenCode plugin — lightweight maintenance of opencode's SQLite DB
*	(~/.local/share/opencode/opencode.db). Runs on startup in a nested Worker
*	off the backend event loop (workerData marker, never parentPort, to avoid
*	a double run). Verifies integrity, prunes sessions inactive > prune_days
*	(ON DELETE CASCADE removes all their tables; event_sequence and empty
*	projects are swept explicitly), refreshes stats, and compacts (VACUUM +
*	WAL truncate) only after a real prune and only when the DB is at least
*	vacuum_min_gb. Safe while opencode is live (WAL).
*
*	Install: cp db-prunetor.ts ~/.config/opencode/plugins/db-prunetor.ts
*	Config:  ~/.config/opencode/db-prunetor.jsonc
*	Log:     ~/.config/opencode/db-prunetor.log
*
*	@example ~/.config/opencode/db-prunetor.jsonc
*	{
*		"enabled": true,
*		"prune_days": 30,
*		// "db_path":
*		"log_level": "info",
*		"vacuum_min_gb": 1
*	}
*
*	@name db-prunetor
*	@version 1.1.23
*	@author Alejandro Carraretto
*	@assistant Hy3
*	@license MIT
*/

import type { Plugin } from "@opencode-ai/plugin" ;
import { Database } from "bun:sqlite" ;
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { isAbsolute, join } from "node:path" ;
import { workerData, Worker } from "node:worker_threads" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "db-prunetor.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "db-prunetor.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG =
{
	enabled: true,
	prune_days: 30,
	db_path: resolveDbPath(),
	log_level: "info" as "silent" | "error" | "info" | "debug",
	vacuum_min_gb: 1,
} ;

const LOG_LEVEL =
{
	SILENT : 0,
	ERROR  : 1,
	INFO   : 2,
	DEBUG  : 3
} as const ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled        : boolean ;
	prune_days     : number ;
	db_path        : string ;
	log_level      : string ;
	vacuum_min_gb  : number ;
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

	CONFIG.enabled       = file.enabled                  ?? CONFIG.enabled ;
	CONFIG.prune_days    = Math.max( 1, file.prune_days  ?? CONFIG.prune_days ) ;
	CONFIG.db_path       = file.db_path ? resolvePath( String( file.db_path ) ) : resolveDbPath() ;
	CONFIG.log_level     = file.log_level                ?? CONFIG.log_level ;
	CONFIG.vacuum_min_gb = file.vacuum_min_gb            ?? CONFIG.vacuum_min_gb ;

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

// Print a line straight to the terminal (not the log file) so the user sees
// that maintenance is running in the background at startup, instead of a silent job.
function notify( message : string ) : void
{
	try { process.stdout.write( message + "\n" ) ; }
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

	// Open the database on this ephemeral connection. Every performance and
	// safety pragma lives here so connect() is the single source of truth for
	// connection settings; they survive reconnects and are reinforced by the
	// final VACUUM.
	protected connect( path : string ) : void
	{
		this.db = new Database( path ) ;
		this.db.exec(
			`PRAGMA journal_mode       = WAL ;
			 PRAGMA journal_size_limit = 0 ;
			 PRAGMA wal_autocheckpoint = 1000 ;
			 PRAGMA auto_vacuum        = OFF ;
			 PRAGMA synchronous        = NORMAL ;
			 PRAGMA temp_store         = MEMORY ;
			 PRAGMA cache_size         = 25000 ;
			 PRAGMA cache_spill        = ON ;
			 PRAGMA automatic_index    = ON ;
			 PRAGMA foreign_keys       = ON ;
			 PRAGMA defer_foreign_keys = OFF ;
			 PRAGMA threads            = 4 ;
			 PRAGMA busy_timeout       = 5000 ;`
		) ;
	}

	// Close the database and release the connection
	protected disconnect() : void
	{
		try { this.db?.close() ; } catch {}
		this.db = null ;
	}

	// Integrity gate — never mutate a suspect database
	protected integrityOk() : boolean
	{
		const rows = this.db!.prepare( "PRAGMA integrity_check" ).all() as Array<{ integrity_check : string }> ;
		const ok   = rows.length > 0 && rows.every( r => r.integrity_check === "ok" ) ;

		if ( ok )
			log( LOG_LEVEL.INFO, "Integrity check: ok" ) ;
		else
			log( LOG_LEVEL.ERROR, `Integrity check FAILED — aborting: ${ JSON.stringify( rows ) }` ) ;

		return ok ;
	}

	// One transaction, foreign-key cascade does the work. opencode's schema
	// declares ON DELETE CASCADE for every child of session and project, so a
	// single DELETE FROM session drags parts, messages, the event journal,
	// session metadata and the sessions' own children with it. event_sequence
	// has no FK to session (event cascades from it), so it is swept
	// explicitly; empty projects and dangling parent_id links go too.
	protected prune( days : number ) : number
	{
		const cutoff = `strftime( '%s', 'now', '-' || ${ days } || ' days' ) * 1000` ;

		const before = ( this.db!.prepare( "SELECT total_changes() AS c" ).get() as { c : number } ).c ;

		this.db!.exec(
			`BEGIN ;
			 DELETE FROM session WHERE time_updated < ${ cutoff } ;
			 UPDATE session SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN ( SELECT id FROM session ) ;
			 DELETE FROM event_sequence WHERE aggregate_id NOT IN ( SELECT id FROM session ) ;
			 DELETE FROM project WHERE NOT EXISTS ( SELECT 1 FROM session s WHERE s.project_id = project.id ) ;
			 COMMIT ;`
		) ;

		return ( this.db!.prepare( "SELECT total_changes() AS c" ).get() as { c : number } ).c - before ;
	}

	// Refresh planner statistics (VACUUM below already rebuilds indexes)
	protected optimize() : void
	{
		this.db!.exec( "PRAGMA optimize" ) ;
	}

	// Reclaim space — but only when no other instance holds the DB. opencode
	// may run several instances sharing one DB over WAL; a closing instance
	// must not block or fail while siblings are live. Probe with BEGIN
	// IMMEDIATE (short timeout): if we take the lock the DB is quiet — VACUUM
	// + wal_checkpoint(TRUNCATE) runs, gated by vacuum_min_gb. If BUSY, another
	// instance is active: defer compaction (the data is already pruned).
	protected compact() : void
	{
		try
		{
			this.db!.exec( "PRAGMA busy_timeout = 1000" ) ;
			this.db!.exec( "BEGIN IMMEDIATE" ) ;
			this.db!.exec( "COMMIT" ) ;

			const dbBytes  = ( () =>
			{
				try { return statSync( this.config.db_path ).size ; }
				catch { return 0 ; }
			} )() ;

			const threshold = this.config.vacuum_min_gb * 1024 * 1024 * 1024 ;

			if ( threshold > 0 && dbBytes < threshold )
			{
				log( LOG_LEVEL.INFO,
					`Vacuum skipped — db ${ fileSize( this.config.db_path ) } ` +
					`below ${ this.config.vacuum_min_gb }GB threshold` ) ;
				this.db!.exec( "PRAGMA wal_checkpoint(TRUNCATE)" ) ;
			}
			else
			{
				this.db!.exec( "PRAGMA page_size = 8192 ; VACUUM ; PRAGMA wal_checkpoint(TRUNCATE)" ) ;
				log( LOG_LEVEL.INFO, "Vacuum + wal checkpoint done" ) ;
			}
		}
		catch ( err )
		{
			log( LOG_LEVEL.INFO, `Compaction deferred (database in use by another instance): ${ ( err as Error ).message }` ) ;
		}
	}

	// Log database / wal / shm sizes
	protected report() : void
	{
		const dbPath = this.config.db_path ;

		log( LOG_LEVEL.INFO,
			`Report — db: ${ fileSize( dbPath ) }, ` +
			`wal: ${ fileSize( dbPath + "-wal" ) }, ` +
			`shm: ${ fileSize( dbPath + "-shm" ) }`
		) ;
	}

	// Atomic single-instance guard: exclusive-create (wx) so two opencode
	// instances sharing one DB can never prune at once. A lock whose owner PID
	// is gone (opencode may kill the worker mid-run) is stale and is stolen;
	// otherwise it would block every future run forever.
	protected acquireLock( lock : string ) : boolean
	{
		try
		{
			writeFileSync( lock, String( process.pid ), { flag : "wx" } ) ;
			return true ;
		}
		catch
		{
			if ( this.isStale( lock ) )
			{
				rmSync( lock, { force : true } ) ;

				try
				{
					writeFileSync( lock, String( process.pid ), { flag : "wx" } ) ;
					return true ;
				}
				catch {}
			}

			log( LOG_LEVEL.INFO, "Another prune already running — skip" ) ;
			return false ;
		}
	}

	// A lock is stale when its owner PID is not alive anymore (ESRCH) or the
	// file is unreadable/empty. EPERM means the process exists — keep waiting.
	protected isStale( lock : string ) : boolean
	{
		try
		{
			const owner = Number( readFileSync( lock, "utf-8" ).trim() ) ;

			if ( ! Number.isFinite( owner ) || owner <= 0 ) return true ;

			process.kill( owner, 0 ) ;
			return false ;
		}
		catch ( err )
		{
			return ( err as NodeJS.ErrnoException ).code !== "EPERM" ;
		}
	}

	// Release the single-instance guard
	protected releaseLock( lock : string ) : void
	{
		rmSync( lock, { force : true } ) ;
	}

	// Orchestrate maintenance on an open connection: a linear pipeline of
	// small stages, each a method above. Cleanup (close + release lock) lives
	// only in the finally, so every early return leaves no residue behind.
	public async run() : Promise<void>
	{
		const dbPath = this.config.db_path ;
		const lock   = dbPath + ".prune.lock" ;
		let completed = false ;

		if ( ! this.acquireLock( lock ) ) return ;

		try
		{
			if ( ! existsSync( dbPath ) )
			{
				log( LOG_LEVEL.ERROR, `Database not found at ${ dbPath } — skipping` ) ;
				return ;
			}

			this.connect( dbPath ) ;

			if ( ! this.integrityOk() ) return ;

			const deleted = this.prune( this.config.prune_days ) ;

			if ( deleted === 0 )
			{
				log( LOG_LEVEL.INFO, "No prune needed" ) ;
				completed = true ;
				return ;
			}

			log( LOG_LEVEL.INFO, `Pruned rows total: ${ deleted }` ) ;
			this.optimize() ;
			this.compact() ;
			this.report() ;
			completed = true ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `Maintenance failed: ${( err as Error ).message }` ) ;
		}
		finally
		{
			this.disconnect() ;
			this.releaseLock( lock ) ;
		}

		if ( completed ) log( LOG_LEVEL.INFO, "Maintenance complete" ) ;
	}
}

// ─── Prune worker entry ─────────────────────────────────────────────────────

// opencode runs plugins inside its backend Bun Worker, so `parentPort` is
// defined there too — using it as a trigger would run maintenance in BOTH the
// plugin thread and the nested worker we spawn (double execution). Instead we
// spawn a nested Worker carrying a workerData marker and run maintenance ONLY
// when that marker is present. The nested Worker keeps the synchronous VACUUM
// off opencode's backend event loop, so startup never freezes.
const IS_PRUNE_WORKER = workerData != null && ( workerData as { dbPrunetorRole? : string } ).dbPrunetorRole === "prune" ;

if ( IS_PRUNE_WORKER )
{
	const cfg = ( workerData as { config? : typeof CONFIG } ).config ?? loadConfig() ;
	const inst = new DbPrunetor( cfg ) ;

	( async () =>
	{
		await inst.run() ;
	} )() ;
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin entry: orchestration only. Spawns the prune Worker (off the backend
// event loop) so the heavy VACUUM never blocks startup.
export default ( async () =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	log( LOG_LEVEL.INFO, "Initialized" ) ;
	notify( "Pruning opencode database… (background)" ) ;

	try
	{
		const worker = new Worker( new URL( import.meta.url ), { workerData : { dbPrunetorRole : "prune", config : opts } } ) ;

		worker.on( "exit", ( code ) =>
		{
			notify( code === 0 ? "Pruning complete." : "Pruning failed (see log)." ) ;
		} ) ;

		worker.on( "error", () =>
		{
			notify( "Pruning failed (see log)." ) ;
		} ) ;
	}
	catch ( err )
	{
		log( LOG_LEVEL.ERROR, `Worker spawn failed: ${ ( err as Error ).message }` ) ;
	}

	return {} ;
} ) satisfies Plugin ;

// ─── END ──────────────────────────────────────────────────────────────
