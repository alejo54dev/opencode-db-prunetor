/**
*	db-maintain.ts
*
*	OpenCode plugin — automatic lightweight maintenance of opencode's
*	SQLite database (~/.local/share/opencode/opencode.db).
*
*	Runs on session dispose (opencode closing): verifies integrity, prunes
*	event-sourcing rows from inactive sessions, rebuilds indexes, and
*	refreshes planner statistics. Safe to run while opencode is live
*	(everything goes through the WAL); no VACUUM / checkpoint truncation.
*
*	Install: cp db-maintain.ts ~/.config/opencode/plugins/db-maintain.ts
*	Config:  ~/.config/opencode/db-maintain.jsonc
*	Log:     ~/.config/opencode/db-maintain.log
*
*	@example ~/.config/opencode/db-maintain.jsonc
*	{
*		"enabled": true,             // master switch
*		"prune_days": 30,            // delete events from sessions inactive > N days
*		"backup": true,              // VACUUM INTO safe online backup before prune
*		"backup_path": "~/.local/share/opencode/opencode.db.bak",
*		"db_path": "~/.local/share/opencode/opencode.db",
*		"log_level": "info"          // "silent" | "error" | "info" | "debug"
*	}
*
*	@name db-maintain
*	@version 0.1.0
*	@author Alejandro Carraretto
*	@license MIT
*/

import type { Plugin, PluginInput } from "@opencode-ai/plugin" ;
import { Database } from "bun:sqlite" ;
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs" ;
import { homedir } from "node:os" ;
import { join } from "node:path" ;

// ─── Paths ─────────────────────────────────────────────────────────────────

const CONFIG_DIR  = join( homedir(), ".config", "opencode" ) ;
const CONFIG_FILE = join( CONFIG_DIR, "db-maintain.jsonc" ) ;
const LOG_FILE    = join( CONFIG_DIR, "db-maintain.log" ) ;

// ─── Constants ─────────────────────────────────────────────────────────────

const CONFIG =
{
	enabled     : true,
	prune_days  : 30,
	backup      : true,
	backup_path : join( homedir(), ".local", "share", "opencode", "opencode.db.bak" ),
	db_path     : join( homedir(), ".local", "share", "opencode", "opencode.db" ),
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
	backup_path : string ;
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

// Expand a leading "~" to the user's home directory
function resolvePath( p : string ) : string
{
	if ( p.startsWith( "~" ) )
		p = join( homedir(), p.slice( 1 ) ) ;

	return p ;
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
		if ( bytes < 1024 * 1024 ) return `${( bytes / 1024 ).toFixed( 1 )} KB` ;
		if ( bytes < 1024 * 1024 * 1024 ) return `${( bytes / ( 1024 * 1024 ) ).toFixed( 1 )} MB` ;

		return `${( bytes / ( 1024 * 1024 * 1024 ) ).toFixed( 2 )} GB` ;
	}
	catch
	{
		return "?" ;
	}
}

// Load config from ~/.config/opencode/db-maintain.jsonc, fall back to defaults
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
	CONFIG.backup_path = file.backup_path ? resolvePath( String( file.backup_path ) ) : CONFIG.backup_path ;
	CONFIG.db_path     = file.db_path    ? resolvePath( String( file.db_path ) )    : CONFIG.db_path ;
	CONFIG.log_level   = file.log_level                      ?? CONFIG.log_level ;

	log( LOG_LEVEL.INFO, "Config loaded" ) ;

	return CONFIG ;
}

// Append timestamped entry to ~/.config/opencode/db-maintain.log
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

// ─── DbMaintain ────────────────────────────────────────────────────────────

// Controller class: holds all plugin state and logic.
class DbMaintain
{
	private config : typeof CONFIG ;
	private client : PluginInput[ "client" ] ;

	// Initialize: store config + client, no side effects, no DB open
	constructor( config : typeof CONFIG, client : PluginInput[ "client" ] )
	{
		this.config = config ;
		this.client = client ;
	}

	// ── Internal helpers ───────────────────────────────────────────────

	// Count events belonging to sessions inactive for more than pruneDays
	protected countEligible( db : Database, pruneDays : number ) : number
	{
		const row = db.prepare(
			`SELECT COUNT(*) AS c
			 FROM event
			 WHERE aggregate_id IN (
				SELECT id FROM session
				WHERE time_updated < strftime( '%s', 'now', '-' || CAST( ? AS TEXT ) || ' days' ) * 1000
			 )`
		).get( pruneDays ) as { c : number } | null ;

		return row?.c ?? 0 ;
	}

	// Safe online backup via VACUUM INTO (consistent snapshot, no lock on live DB)
	protected backup( db : Database, path : string ) : void
	{
		try
		{
			if ( existsSync( path ) ) rmSync( path, { force : true } ) ;

			db.exec( `VACUUM INTO '${ sqlString( path ) }'` ) ;

			log( LOG_LEVEL.INFO, `Backup written: ${ path } (${ fileSize( path ) })` ) ;
		}
		catch ( err )
		{
			throw new Error( `backup failed: ${( err as Error ).message }` ) ;
		}
	}

	// Prune event-sourcing rows from inactive sessions
	protected prune( db : Database, pruneDays : number ) : number
	{
		const result = db.run(
			`DELETE FROM event
			 WHERE aggregate_id IN (
				SELECT id FROM session
				WHERE time_updated < strftime( '%s', 'now', '-' || CAST( ? AS TEXT ) || ' days' ) * 1000
			 )`,
			[ pruneDays ]
		) ;

		return result.changes ?? 0 ;
	}

	// ── Public hooks ──────────────────────────────────────────────────

	// Maintenance on session close: integrity check -> backup -> prune -> reindex -> optimize
	public async dispose() : Promise<void>
	{
		const dbPath = this.config.db_path ;

		if ( ! existsSync( dbPath ) )
		{
			log( LOG_LEVEL.ERROR, `Database not found at ${ dbPath } — skipping` ) ;
			return ;
		}

		let db : Database | null = null ;

		try
		{
			db = new Database( dbPath ) ;

			// Speed pragmas on THIS ephemeral connection only (discarded on close)
			db.exec(
				`PRAGMA synchronous   = OFF ;
				 PRAGMA temp_store    = MEMORY ;
				 PRAGMA cache_size    = -200000 ;
				 PRAGMA busy_timeout  = 5000 ;`
			) ;

			// 1. Integrity gate — never mutate a suspect database
			const integrity = db.prepare( "PRAGMA integrity_check" ).all() as Array<{ integrity_check : string }> ;
			const corrupt   = integrity.some( r => r.integrity_check !== "ok" ) ;

			if ( corrupt )
			{
				log( LOG_LEVEL.ERROR, `Integrity check FAILED — aborting prune: ${ JSON.stringify( integrity ) }` ) ;
				return ;
			}

			log( LOG_LEVEL.INFO, "Integrity check: ok" ) ;

			// 2. Eligibility count
			const eligible = this.countEligible( db, this.config.prune_days ) ;

			log( LOG_LEVEL.INFO, `Eligible events (inactive > ${ this.config.prune_days }d): ${ eligible }` ) ;

			if ( eligible === 0 )
			{
				log( LOG_LEVEL.INFO, "No prune needed" ) ;
			}
			else
			{
				// 3. Online backup before any destructive change
				if ( this.config.backup )
					this.backup( db, this.config.backup_path ) ;

				// 4. Prune
				const deleted = this.prune( db, this.config.prune_days ) ;

				log( LOG_LEVEL.INFO, `Pruned events: ${ deleted }` ) ;

				// 5. Rebuild indexes after the mass delete
				db.exec( "REINDEX" ) ;

				// 6. Refresh planner statistics over the post-prune state
				db.exec( "PRAGMA analysis_limit = 1000 ; PRAGMA optimize" ) ;

				log( LOG_LEVEL.INFO, "Reindex + optimize done" ) ;
			}

			// Report
			log( LOG_LEVEL.INFO,
				`Report — db: ${ fileSize( dbPath ) }, ` +
				`wal: ${ fileSize( dbPath + "-wal" ) }, ` +
				`shm: ${ fileSize( dbPath + "-shm" ) }, ` +
				`bak: ${ fileSize( this.config.backup_path ) }`
			) ;
		}
		catch ( err )
		{
			log( LOG_LEVEL.ERROR, `Maintenance failed: ${( err as Error ).message }` ) ;
		}
		finally
		{
			try { db?.close() ; } catch {}
		}

		log( LOG_LEVEL.INFO, "Disposed" ) ;
	}
}

// ─── Plugin ────────────────────────────────────────────────────────────────

// Plugin factory: load config, build DbMaintain, register dispose hook
export default ( async ( ctx : PluginInput ) =>
{
	const opts = loadConfig() ;

	if ( ! opts.enabled )
	{
		log( LOG_LEVEL.INFO, "Disabled" ) ;
		return {} ;
	}

	const inst = new DbMaintain( opts, ctx.client ) ;

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
