#engine v8
// Runs the StarlinkSweeper analysis on a list of frames inside PixInsight,
// without the dialog, and writes one JSON line per frame (preview left out).
// Used to check that a change gives the same results (tests/compare_scans.py).
//
//   PixInsight.sh -n --automation-mode --no-startup-scripts \
//     -r="<clone>/tests/run_scan_pi.js,<out.jsonl>[,threads=N],<frame1>,<frame2>,..." --force-exit
//
// threads=N: scan on N threads (0 = automatic, as the dialog's Auto); in
// series without it. Paths without commas. A script run with -r needs the
// #engine v8 directive: without it, PixInsight 1.9 runs it on the legacy
// SpiderMonkey engine.

var STARLINKSWEEPER_NO_MAIN = true;
#include "../scripts/StarlinkSweeper.js"

function record(r) {
   if (r.error) return { file: File.extractName(r.file), error: r.error };
   var copy = function (list) {
      var out = [];
      for (var i = 0; list && i < list.length; ++i) {
         var L = list[i], o = {};
         for (var k in L) o[k] = L[k];
         out.push(o);
      }
      return out;
   };
   var rec = { file: File.extractName(r.file), status: r.status, score: r.score, coarse: r.coarse,
               width: r.width, height: r.height, skipped: r.skipped || "", lines: copy(r.lines), seconds: r.seconds };
   if (r.rejected) rec.rejected = copy(r.rejected);   // lines dropped by the profile test
   return rec;
}

// Runtime.jsArguments since PixInsight 1.9.5 (jsArguments is deprecated there)
var args = ( typeof Runtime != "undefined" && Runtime.jsArguments ) ? Runtime.jsArguments : jsArguments;
var files = args.slice(1), threads = 1;
if (files.length && files[0].indexOf("threads=") == 0) {
   threads = scanThreads(files.slice(1), parseInt(files[0].substring(8)));
   files = files.slice(1);
}
var out = [], t0 = Date.now();
scanFiles(files, true, threads, function (k, r) { out[k] = JSON.stringify(record(r)); },
          function () { return false; });
out.push(JSON.stringify({ run: "threads " + threads, seconds: (Date.now() - t0) / 1000 }));
File.writeTextFile(args[0], out.join("\n") + "\n");
