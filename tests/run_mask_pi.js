#engine v8
// Runs the masking engine on a list of registered frames, outside WBPP, with
// the files loaded the way StarlinkSweeper-WBPP.js loads them.
//
//   PixInsight.sh -n --automation-mode --no-startup-scripts \
//     -r="<clone>/tests/run_mask_pi.js,<output dir>,<mode>,<threads>,<frame1>,<frame2>,..." --force-exit
//
// mode: "dry" (masks and reports only, frames untouched) or "mask" (frames
// masked IN PLACE: give copies). threads: 0 = automatic, 1 = serial. Writes
// <output dir>/run.jsonl (one line per frame, then a summary) next to the
// engine's own reports. Paths without commas.

var args = ( typeof Runtime != "undefined" && Runtime.jsArguments ) ? Runtime.jsArguments : jsArguments;
var here = File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ ), dir = here + "/../scripts";
( 0, eval )( "var StarlinkSweeperScan = ( function() {\n" + File.readTextFile( dir + "/StarlinkSweeperCore.js" ) +
             "\nreturn StarlinkSweeperScan;\n} )();" );
( 0, eval )( File.readTextFile( dir + "/StarlinkSweeperMaskCore.js" ) );
( 0, eval )( File.readTextFile( dir + "/StarlinkSweeperMaskEngine.js" ) );

var outDir = args[0], mode = args[1], threads = parseInt( args[2] ), files = args.slice( 3 ), log = [];
var res = StarlinkSweeperMaskEngine.processGroup( files, {
   outputDir: outDir,
   dryRun: mode != "mask",
   threads: threads,
   log: function( s ) { log.push( s ); console.writeln( "StarlinkSweeper: " + s ); }
} );
var out = [];
for ( var i = 0; i < res.results.length; ++i )
{
   var r = res.results[i];
   out.push( JSON.stringify( { file: File.extractName( r.file ), score: r.score, candidates: r.candidates,
      directions: r.directions, trails: r.trails.length, far: r.far, rejected: r.rejected, pixels: r.pixels,
      fraction: r.fraction, maskBytes: r.maskBytes, seconds: r.seconds,
      widths: r.trails.map( t => 2 * t.width ), angles: r.trails.map( t => +t.geometry.angle.toFixed( 2 ) ) } ) );
}
out.push( JSON.stringify( { summary: true, masked: res.masked, failed: res.failed.length, bytes: res.bytes, threads: threads } ) );
File.writeTextFile( outDir + "/run.jsonl", out.join( "\n" ) + "\n" );
File.writeTextFile( outDir + "/run.log", log.join( "\n" ) + "\n" );
