/**
*	db-prunetor.ts
*
*	OpenCode plugin — automatic lightweight maintenance of opencode's
*	SQLite database (~/.local/share/opencode/opencode.db).
*
*	Runs on session dispose (opencode closing): verifies integrity, prunes
*	event-sourcing rows from inactive sessions, rebuilds indexes, and
*	refreshes planner statistics. Safe to run while opencode is live
*	(everything goes through the WAL); no VACUUM / checkpoint truncation.
*
*	Install: cp db-prunetor.ts ~/.config/opencode/plugins/db-prunetor.ts
*	Config:  ~/.config/opencode/db-prunetor.jsonc
*	Log:     ~/.config/opencode/db-prunetor.log
*
*	@example ~/.config/opencode/db-prunetor.jsonc
*	{
*		"enabled": true,             // master switch
*		"prune_days": 30,            // delete events from sessions inactive > N days
*		// "db_path": "~/.local/share/opencode/opencode.db",  // optional override; auto-detected if omitted
*		"log_level": "info"          // "silent" | "error" | "info" | "debug"
*	}
*
*	@name db-prunetor
*	@version 0.1.2
*	@author Alejandro Carraretto
*	@assistant DeepSeek-V4
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

// Rows belonging to sessions inactive beyond N days (time_updated is epoch ms)
const INACTIVE_SESSION_WHERE =
	`aggregate_id IN (
		SELECT id FROM session
		WHERE time_updated < strftime( '%s', 'now', '-' || CAST( ? AS TEXT ) || ' days' ) * 1000
	 )` ;

// ─── Interfaces ────────────────────────────────────────────────────────────

interface Config
{
	enabled     : boolean ;
	prune_days  : number ;
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

	// Open the database and apply speed pragmas on this ephemeral connection
	protected connect( path : string ) : void
	{
		this.db = new Database( path ) ;
		this.applySpeedPragmas() ;
	}

	// Close the database and release the connection
	protected disconnect() : void
	{
		try { this.db?.close() ; } catch {}
		this.db = null ;
	}

	// Speed pragmas on THIS connection only (discarded on disconnect)
	protected applySpeedPragmas() : void
	{
		this.db!.exec(
			`PRAGMA synchronous  = NORMAL ;
			 PRAGMA temp_store   = MEMORY ;
			 PRAGMA cache_size   = 5000 ;
			 PRAGMA busy_timeout = 5000 ;`
		) ;
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

	// Count events belonging to sessions inactive beyond pruneDays
	protected countEligible( pruneDays : number ) : number
	{
		const row = this.db!.prepare(
			`SELECT COUNT(*) AS c FROM event WHERE ${ INACTIVE_SESSION_WHERE }`
		).get( pruneDays ) as { c : number } | null ;

		return row?.c ?? 0 ;
	}

	// Backup lives next to the db: "<db_path>.bak"
	protected backupPath() : string
	{
		return this.config.db_path + ".bak" ;
	}

	// Temporary pre-prune safety backup via VACUUM INTO (consistent snapshot,
	// no lock on live DB). Removed automatically once maintenance succeeds.
	protected backup() : void
	{
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

	// Prune event-sourcing rows from inactive sessions
	protected prune( pruneDays : number ) : number
	{
		const result = this.db!.run(
			`DELETE FROM event WHERE ${ INACTIVE_SESSION_WHERE }`,
			[ pruneDays ]
		) ;

		return result.changes ?? 0 ;
	}

	// Rebuild indexes and refresh planner statistics over the post-prune state
	protected optimize() : void
	{
		this.db!.exec( "REINDEX" ) ;
		this.db!.exec( "PRAGMA analysis_limit = 1000 ; PRAGMA optimize" ) ;

		log( LOG_LEVEL.INFO, "Reindex + optimize done" ) ;
	}

	// Log database / wal / shm / backup sizes
	protected report() : void
	{
		const dbPath = this.config.db_path ;

		log( LOG_LEVEL.INFO,
			`Report — db: ${ fileSize( dbPath ) }, ` +
			`wal: ${ fileSize( dbPath + "-wal" ) }, ` +
			`shm: ${ fileSize( dbPath + "-shm" ) }, ` +
			`bak: ${ fileSize( this.backupPath() ) }`
		) ;
	}

	// Orchestrate the maintenance sequence on an open connection
	protected maintain() : void
	{
		const days = this.config.prune_days ;

		if ( ! this.checkIntegrity() ) return ;

		const eligible = this.countEligible( days ) ;

		log( LOG_LEVEL.INFO, `Eligible events (inactive > ${ days }d): ${ eligible }` ) ;

		if ( eligible === 0 )
		{
			log( LOG_LEVEL.INFO, "No prune needed" ) ;
			return ;
		}

		this.backup() ;

		const deleted = this.prune( days ) ;

		log( LOG_LEVEL.INFO, `Pruned events: ${ deleted }` ) ;

		this.optimize() ;

		// Success path: the temporary pre-prune backup is no longer needed
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
