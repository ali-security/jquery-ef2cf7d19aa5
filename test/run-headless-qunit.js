/*
 * Headless runner for the jQuery browser QUnit suite (test/index.html).
 *
 * Runs on modern Node (18+) with puppeteer; it is NOT part of the grunt
 * build and is not linted: it is excluded from jshint via .jshintignore
 * (grunt jshint:all globs every .js file under test/). test/ is excluded from the npm
 * tarball by .npmignore.
 *
 * Usage:
 *   NODE_PATH=/path/to/node_modules node test/run-headless-qunit.js [url]
 *
 * The default URL is http://127.0.0.1:8000/test/index.html, which expects the
 * repository root to be served by a PHP-capable server (test/data/*.php).
 *
 * Exit codes:
 *   0 - QUnit finished and reported zero failed assertions
 *   1 - QUnit finished with failures (or ran no assertions at all)
 *   2 - QUnit did not finish (timeout, navigation failure, page crash)
 */
"use strict";

// puppeteer-core drives the system Chrome (CHROME_BIN) instead of downloading one.
const puppeteer = require( "puppeteer-core" );

// Test names and assertion messages carry control and non-ASCII characters
// (e.g. NUL in selector/attribute tests); escape them so the CI log stays intact.
function asciiSafe( args ) {
	return args.map( String ).join( " " ).replace( /[^\x09\x0a\x20-\x7e]/g, ( c ) =>
		"\\u" + c.charCodeAt( 0 ).toString( 16 ).padStart( 4, "0" ) );
}
const rawLog = console.log.bind( console );
const rawError = console.error.bind( console );
console.log = ( ...args ) => rawLog( asciiSafe( args ) );
console.error = ( ...args ) => rawError( asciiSafe( args ) );

const url = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html";
const TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

const streamed = [];
let lastCompleted = null;
let fatalError = null;

function sleep( ms ) {
	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );
}

function testLabel( t ) {
	return ( t.module ? t.module + ": " : "" ) + t.name;
}

function isFailed( t ) {
	return t.failed > 0;
}

function printTest( t ) {
	if ( isFailed( t ) ) {
		console.log( "FAIL  " + testLabel( t ) + " (" + t.failed + " of " + t.total + " failed)" );
		( t.failures || [] ).forEach( ( f, i ) => {
			console.log( "        #" + ( i + 1 ) + " " + ( f.message || "(no message)" ) );
			if ( f.hasExpected ) {
				console.log( "           expected: " + f.expected );
				console.log( "           actual:   " + f.actual );
			}
			if ( f.source ) {
				String( f.source ).split( "\n" ).forEach( ( line ) => {
					console.log( "           " + line.trim() );
				} );
			}
		} );
	} else if ( process.env.QUNIT_VERBOSE ) {
		console.log( "PASS  " + testLabel( t ) + " (" + t.total + " assertion" +
			( t.total === 1 ? "" : "s" ) + ")" );
	}
	trackModule( t );
}

// Per-module result lines, printed as each module finishes. Passing tests are
// summarized per module instead of one line each to keep the CI log short
// (QUNIT_VERBOSE=1 restores the per-test PASS lines).
let moduleStats = null;

function flushModule() {
	if ( moduleStats ) {
		console.log( "MODULE " + moduleStats.name + ": " + moduleStats.tests + " tests, " +
			( moduleStats.tests - moduleStats.failed ) + " passed, " + moduleStats.failed +
			" failed (" + moduleStats.assertions + " assertions)" );
	}
	moduleStats = null;
}

function trackModule( t ) {
	const name = t.module || "(no module)";
	if ( !moduleStats || moduleStats.name !== name ) {
		flushModule();
		moduleStats = { name: name, tests: 0, failed: 0, assertions: 0 };
	}
	moduleStats.tests++;
	moduleStats.assertions += t.total;
	if ( isFailed( t ) ) {
		moduleStats.failed++;
	}
}

function pad( str, width ) {
	str = String( str );
	return str.length >= width ? str : str + " ".repeat( width - str.length );
}

function padLeft( str, width ) {
	str = String( str );
	return str.length >= width ? str : " ".repeat( width - str.length ) + str;
}

function printSummary( results, done ) {
	const failedTests = results.filter( isFailed );
	const passedTests = results.length - failedTests.length;

	console.log( "" );
	console.log( "==== Per-module results ====" );
	const modules = [];
	const byModule = Object.create( null );
	results.forEach( ( t ) => {
		const name = t.module || "(no module)";
		if ( !byModule[ name ] ) {
			byModule[ name ] = { tests: 0, failed: 0 };
			modules.push( name );
		}
		byModule[ name ].tests++;
		if ( isFailed( t ) ) {
			byModule[ name ].failed++;
		}
	} );
	const modWidth = Math.max( 6, ...modules.map( ( m ) => m.length ) ) + 2;
	console.log( pad( "Module", modWidth ) + padLeft( "Tests", 7 ) + padLeft( "Failed", 8 ) );
	console.log( "-".repeat( modWidth + 15 ) );
	modules.forEach( ( m ) => {
		console.log( pad( m, modWidth ) + padLeft( byModule[ m ].tests, 7 ) +
			padLeft( byModule[ m ].failed, 8 ) );
	} );

	console.log( "" );
	console.log( "==== QUnit summary ====" );
	console.log( "Tests: " + results.length + " total, " + passedTests + " passed, " +
		failedTests.length + " failed" );
	console.log( "Assertions: " + done.total + " total, " + done.passed + " passed, " +
		done.failed + " failed" );
	console.log( "Runtime: " + done.runtime + " ms" );

	if ( failedTests.length ) {
		console.log( "" );
		console.log( "Failed tests:" );
		failedTests.forEach( ( t ) => {
			console.log( "  - " + testLabel( t ) );
		} );
	}
}

// Runs inside the page (top frame only). Traps the assignment of window.QUnit
// by qunit.js and registers the logging callbacks immediately, before any test
// can run.
function installQUnitHooks() {
	if ( window.top !== window ) {
		return;
	}

	var qunitRef;
	var hooked = false;
	var currentFailures = [];

	window.__qunitResults = [];
	window.__qunitDone = null;

	function dump( value ) {
		try {
			if ( window.QUnit && window.QUnit.jsDump && window.QUnit.jsDump.parse ) {
				return window.QUnit.jsDump.parse( value );
			}
		} catch ( e ) {}
		try {
			var json = JSON.stringify( value );
			return json === undefined ? String( value ) : json;
		} catch ( e ) {
			return String( value );
		}
	}

	function hook( Q ) {
		if ( hooked || !Q || typeof Q.log !== "function" ||
				typeof Q.testDone !== "function" || typeof Q.done !== "function" ) {
			return;
		}
		hooked = true;

		Q.testStart( function() {
			currentFailures = [];
		} );

		Q.log( function( details ) {
			if ( details.result ) {
				return;
			}
			var hasExpected = Object.prototype.hasOwnProperty.call( details, "expected" );
			currentFailures.push( {
				message: details.message == null ? "" : String( details.message ),
				hasExpected: hasExpected,
				expected: hasExpected ? dump( details.expected ) : "",
				actual: hasExpected ? dump( details.actual ) : "",
				source: details.source ? String( details.source ) : ""
			} );
		} );

		Q.testDone( function( details ) {
			var record = {
				module: details.module || "",
				name: details.name,
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				failures: currentFailures
			};
			currentFailures = [];
			window.__qunitResults.push( record );
			try {
				if ( typeof window.__qunitReportTest === "function" ) {
					window.__qunitReportTest( record );
				}
			} catch ( e ) {}
		} );

		Q.done( function( details ) {
			window.__qunitDone = {
				failed: details.failed,
				passed: details.passed,
				total: details.total,
				runtime: details.runtime
			};
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( value ) {
			qunitRef = value;
			hook( value );
		}
	} );
}

async function main() {
	console.log( "Running QUnit suite at " + url );

	const browser = await puppeteer.launch( {
		headless: "new",
		executablePath: process.env.CHROME_BIN || "/usr/bin/google-chrome-stable",
		args: [ "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage" ]
	} );

	let exitCode = 2;

	try {
		const page = await browser.newPage();

		page.on( "console", ( msg ) => {
			if ( msg.type() === "error" ) {
				console.log( "[browser] console.error: " + msg.text() );
			}
		} );
		page.on( "pageerror", ( err ) => {
			console.log( "[browser] pageerror: " + ( err && err.message ? err.message : err ) );
		} );
		page.on( "error", ( err ) => {
			fatalError = err;
			console.log( "[browser] page crashed: " + ( err && err.message ? err.message : err ) );
		} );

		await page.exposeFunction( "__qunitReportTest", ( record ) => {
			streamed.push( record );
			lastCompleted = record;
			printTest( record );
		} );

		await page.evaluateOnNewDocument( installQUnitHooks );

		try {
			await page.goto( url, { waitUntil: "domcontentloaded", timeout: 120000 } );
		} catch ( e ) {
			console.log( "Failed to load " + url + ": " + e.message );
			return 2;
		}

		const deadline = Date.now() + TIMEOUT_MS;
		let done = null;

		while ( Date.now() < deadline && !fatalError ) {
			try {
				done = await page.evaluate( () => window.__qunitDone || null );
			} catch ( e ) {
				// Execution context may be briefly unavailable; keep polling.
				done = null;
			}
			if ( done ) {
				break;
			}
			await sleep( POLL_MS );
		}

		if ( !done ) {
			console.log( "" );
			if ( fatalError ) {
				console.log( "QUnit did not finish: the page crashed." );
			} else {
				console.log( "QUnit did not finish within " + ( TIMEOUT_MS / 60000 ) + " minutes." );
			}
			console.log( "Tests completed: " + streamed.length );
			console.log( "Last completed test: " +
				( lastCompleted ? testLabel( lastCompleted ) : "(none)" ) );
			return 2;
		}

		// Give any in-flight exposeFunction calls a moment to flush.
		await sleep( 500 );

		let results = streamed;
		try {
			const pageResults = await page.evaluate( () => window.__qunitResults || [] );
			if ( Array.isArray( pageResults ) && pageResults.length >= streamed.length ) {
				results = pageResults;
			}
		} catch ( e ) {}

		flushModule();
		printSummary( results, done );

		if ( done.total === 0 ) {
			console.log( "" );
			console.log( "ERROR: QUnit reported zero assertions; treating as failure." );
			exitCode = 1;
		} else {
			exitCode = done.failed === 0 ? 0 : 1;
		}
		return exitCode;
	} finally {
		await browser.close().catch( () => {} );
	}
}

main().then(
	( code ) => {
		process.exit( code );
	},
	( err ) => {
		console.error( "Runner error: " + ( err && err.stack ? err.stack : err ) );
		process.exit( 2 );
	}
);
