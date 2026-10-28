#engine v8
// Feasibility probe for the masking option (development aid): on each frame,
// StarlinkSweeper's candidate lines (no cap), then ClarkeMaskCore.detect along
// each direction; writes one JSON line per frame.
//   PixInsight.sh -n --automation-mode --no-startup-scripts \
//     -r="<clone>/tests/probe_mask_pi.js,<StarlinkSweeperMaskCore.js>,<out.jsonl>,<name=value+...>,<frame1>,..." --force-exit

var STARLINKSWEEPER_NO_MAIN = true;
#include "../scripts/StarlinkSweeperCore.js"

var args = ( typeof Runtime != "undefined" && Runtime.jsArguments ) ? Runtime.jsArguments : jsArguments;
( 0, eval )( File.readTextFile( args[0] ) );           // StarlinkSweeperMaskCore.js (or ClarkeMaskCore.js)
var MC = ( typeof StarlinkSweeperMaskCore != "undefined" ) ? StarlinkSweeperMaskCore : ClarkeMaskCore;
var outPath = args[1], files = args.slice( 3 ), detectOptions = {};
// args[2]: detect options as name=value pairs joined by "+" (e.g. maxCoreWidth=40+maxBend=12)
args[2].split( "+" ).forEach( function( kv ) { var p = kv.split( "=" ); if ( p.length == 2 ) detectOptions[p[0]] = parseFloat( p[1] ); } );
MAX_LINES = 50;                                         // probe: no cap

function readChannel0( path )
{
   var f = new FileFormatInstance( new FileFormat( File.extractExtension( path ), true, false ) );
   var d = f.open( path, "raw cfa verbosity 0" );
   var img = new Image;
   f.readImage( img ); f.close();
   var W = img.width, H = img.height, data = new Float32Array( W * H );
   img.getSamples( data, new Rect( 0, 0, W, H ), 0 );
   img.free();
   return { data: data, W: W, H: H };
}

var out = [];
for ( var k = 0; k < files.length; ++k )
{
   var t0 = Date.now(), fr = readChannel0( files[k] );
   var b8 = binMeanNoData( fr.data, fr.W, fr.H, FINE_BIN );
   var res = analyseBinned( b8.data, b8.w, b8.h, b8.invalid );
   var det = MC.binMean2( fr.data, fr.W, fr.H );
   var t1 = Date.now();
   // directions: candidate lines grouped within 0.5 deg
   var dirs = [];
   for ( var i = 0; i < res.lines.length; ++i )
   {
      var L = res.lines[i], found = false;
      for ( var j = 0; j < dirs.length && !found; ++j )
         if ( Math.abs( ( ( L.angle - dirs[j].angle ) % 180 + 270 ) % 180 - 90 ) < 0.5 ) { dirs[j].lines.push( L ); found = true; }
      if ( !found ) dirs.push( { angle: L.angle, lines: [ L ] } );
   }
   var report = { file: File.extractName( files[k] ), W: fr.W, H: fr.H, score: res.score,
                  lines: res.lines.map( L => ( { score: +L.score.toFixed( 1 ), angle: L.angle, rho: L.rho, run: L.run } ) ), dirs: [] };
   for ( var di = 0; di < dirs.length; ++di )
   {
      var th = dirs[di].angle, r = MC.detect( det.data, det.w, det.h, th, detectOptions );
      var c = Math.cos( th * Math.PI / 180 ), s = Math.sin( th * Math.PI / 180 );
      function near( g )
      {
         var best = 1e9;
         for ( var q = 0; q < dirs[di].lines.length; ++q )
            best = Math.min( best, Math.abs( g.x * c + g.y * s - 4 * dirs[di].lines[q].rho ) );
         return +best.toFixed( 1 );
      }
      report.dirs.push( { angle: th, nLines: dirs[di].lines.length, sigPix: r.sigPix,
         trails: r.trails.map( t => ( { distToLine: near( t.geometry ), width: t.width, coreWidth: t.coreWidth,
                                         peak: +t.peak.toFixed( 1 ), length: t.length, segments: t.segments } ) ),
         rejected: r.rejected.map( t => ( { reason: t.reason, distToLine: near( t.geometry ), coreWidth: t.coreWidth,
                                           segments: t.segments } ) ) } );
   }
   report.seconds = { read_scan: ( t1 - t0 ) / 1000, detect: ( Date.now() - t1 ) / 1000 };
   out.push( JSON.stringify( report ) );
   File.writeTextFile( outPath, out.join( "\n" ) + "\n" );
}
