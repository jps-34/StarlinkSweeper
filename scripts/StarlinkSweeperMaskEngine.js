/*
 * StarlinkSweeperMaskEngine.js
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic), under the direction of Jacques Pouyaud.
 *
 * Masking option of StarlinkSweeper: instead of setting a whole frame aside,
 * only the pixels of its trails are set to 0 in the registered frame, which
 * WBPP's integration rejects (range rejection at 0 for light frames). Each
 * pixel is then integrated from the frames that are clean there.
 *
 * Per registered frame:
 *   1. detection image: mean of the channels (0 where any channel is 0);
 *   2. StarlinkSweeper's own scan (StarlinkSweeperScan, every direction), with
 *      the bins of the registration borders left out and no cap on the number
 *      of lines; candidate lines from minScore up;
 *   3. candidates grouped by direction (within groupAngle);
 *   4. along each direction, StarlinkSweeperMaskCore.detect() (ClarkeMask's
 *      core) finds every trail (each member of a train separately), its width
 *      and its ends; only the trails close to a candidate line are kept;
 *   5. rasterize() at full resolution, 0 under the mask in every channel, the
 *      frame saved in place, a mask file and a coverage map written.
 * With PixInsight 1.9.5 and later, steps 1 to 4 run on Thread objects (each
 * with a runtime of its own, rebuilt from the sources of both cores); the
 * frames are masked and saved in order in the main thread.
 *
 * Needs StarlinkSweeperScan (StarlinkSweeperCore.js) and
 * StarlinkSweeperMaskCore (StarlinkSweeperMaskCore.js) loaded first. No
 * #include here: the WBPP event script loads this file with eval.
 */

var StarlinkSweeperMaskEngine = ( function()
{
   "use strict";

   var VERSION = "1.3.2";
   var NO_SWAP_FILE = 0xFFFFFFFF;    // UndoFlag_NoSwapFile
   var MASK_HINTS = "compression-codec zlib+sh";

   var DEFAULTS = {
      minScore: 15,         // candidate lines from this score up (the list of the dialog starts at 20)
      minLine: 0.10,        // shortest line searched, share of the smaller image side (reaches corners)
      groupAngle: 1.0,      // deg: candidate lines closer than this share one direction
      keepDistance: 60,     // detection-image px: trails further than this from every candidate are not masked
      margin: 4,            // full-resolution px added across each trail
      endMargin: 16,        // full-resolution px added at each end
      binning: 2,           // detection image binning (StarlinkSweeperMaskCore)
      // StarlinkSweeperMaskCore.detect options, wider than ClarkeMask's for bright low-orbit trails:
      // cores up to 40 px, wings down to 0.5 sigma, and a bend up to 12 px (detection image) from a
      // straight line (long trails across a wide field, or crossing a bright galaxy)
      detect: { maxCoreWidth: 40, edgeSigma: 0.5, maxBend: 12 },
      outputDir: "",        // masks, coverage map and reports ("" = no files)
      writeMasks: true,     // one <frame>_mask.xisf per masked frame
      dryRun: false,        // masks and reports only, frames not modified
      noData: 0,            // value written under the masks
      lowCoverage: 0.5,     // warn where fewer than this fraction of the frames remain
      threads: null,        // detection threads: null = setting StarlinkSweeper/threads, 0 = automatic, 1 = serial
      abort: null,          // function returning true to stop between frames
      onFrame: null,        // function( result ) called after each frame
      onProgress: null,     // function() called while waiting (UI events)
      log: null             // function( text ); console by default
   };

   function options( o )
   {
      var opt = {};
      for ( var k in DEFAULTS ) opt[k] = DEFAULTS[k];
      if ( o ) for ( var k2 in o ) opt[k2] = o[k2];
      var det = {};
      for ( var d in DEFAULTS.detect ) det[d] = DEFAULTS.detect[d];
      if ( o && o.detect ) for ( var d2 in o.detect ) det[d2] = o.detect[d2];
      opt.detect = det;
      if ( !opt.log ) opt.log = function( s ) { console.writeln( "StarlinkSweeper: " + s ); console.flush(); };
      return opt;
   }

   function baseName( path )
   {
      return File.extractName( path );
   }

   // ------------------------------------------------------------- detection
   // channelMean, readFrame, detectFrame and frameDetection also run in the
   // detection threads: they use only their arguments and the two cores.

   function channelMean( img )
   {
      // Mean of the channels at full resolution; 0 where any channel is 0 or
      // NaN (registration border, pixel already masked).
      var W = img.width, H = img.height, n = W * H, nc = img.numberOfChannels;
      var sum = new Float32Array( n ), rect = new Rect( 0, 0, W, H );
      img.getSamples( sum, rect, 0 );
      if ( nc > 1 )
      {
         var d = new Float32Array( n );
         for ( var c = 1; c < nc; ++c )
         {
            img.getSamples( d, rect, c );
            for ( var i = 0; i < n; ++i )
               sum[i] = ( sum[i] == 0 || !( d[i] != 0 ) ) ? 0 : sum[i] + d[i];
         }
         for ( var j = 0; j < n; ++j )
            sum[j] = sum[j] == sum[j] ? sum[j] / nc : 0;
      }
      return sum;
   }

   function readFrame( path )
   {
      // Reads a frame without an image window (usable in a thread): the mean
      // of its channels and its size.
      var img = new Image;
      try
      {
         var f = new FileFormatInstance( new FileFormat( File.extractExtension( path ), true /*read*/, false /*write*/ ) );
         if ( f.open( path, "" ).length < 1 )
            throw new Error( "Unable to open " + path );
         try
         {
            if ( !f.readImage( img ) )
               throw new Error( "Unable to read " + path );
         }
         finally
         {
            f.close();
         }
         return { data: channelMean( img ), width: img.width, height: img.height };
      }
      finally
      {
         img.free();
      }
   }

   function detectFrame( full, W, H, d, S, MC )
   {
      // Trails of one frame (full: channelMean, W x H). d: {minScore,
      // groupAngle, keepDistance, detect, binning}. S: the scan core
      // (binMeanNoData, analyseBinned, FINE_BIN); MC: the mask core. Returns a
      // result for MC.rasterize ({w, h, theta, trails}) with the scan summary.
      var b8 = S.binMeanNoData( full, W, H, S.FINE_BIN );
      var scan = S.analyseBinned( b8.data, b8.w, b8.h, b8.invalid, 100, d.minLine );
      var cand = [];
      for ( var i = 0; i < scan.lines.length; ++i )
         if ( scan.lines[i].score >= d.minScore )
            cand.push( scan.lines[i] );
      cand.sort( function( a, b ) { return b.score - a.score; } );
      var groups = [];
      for ( var k = 0; k < cand.length; ++k )
      {
         var found = false;
         for ( var g = 0; g < groups.length && !found; ++g )
         {
            var da = Math.abs( ( ( cand[k].angle - groups[g].angle ) % 180 + 270 ) % 180 - 90 );
            if ( da < d.groupAngle ) { groups[g].lines.push( cand[k] ); found = true; }
         }
         if ( !found ) groups.push( { angle: cand[k].angle, lines: [ cand[k] ] } );
      }
      var det = MC.binMean2( full, W, H ), trails = [], far = 0, rejected = 0;
      var ratio = S.FINE_BIN / d.binning;      // scan bins -> detection-image px
      for ( var q = 0; q < groups.length; ++q )
      {
         var th = groups[q].angle, r = MC.detect( det.data, det.w, det.h, th, d.detect );
         var c = Math.cos( th * Math.PI / 180 ), s = Math.sin( th * Math.PI / 180 );
         rejected += r.rejected.length;
         for ( var t = 0; t < r.trails.length; ++t )
         {
            var gm = r.trails[t].geometry, best = 1e9;
            for ( var l = 0; l < groups[q].lines.length; ++l )
               best = Math.min( best, Math.abs( gm.x * c + gm.y * s - ratio * groups[q].lines[l].rho ) );
            if ( best <= d.keepDistance )
               trails.push( r.trails[t] );
            else
               ++far;
         }
      }
      return { w: det.w, h: det.h, theta: 0, trails: trails, score: scan.score, candidates: cand.length,
               directions: groups.length, far: far, rejected: rejected };
   }

   function frameDetection( d )
   {
      // Body of a detection thread: d = {path, minScore, groupAngle,
      // keepDistance, detect, binning}.
      var t0 = Date.now(), fr = readFrame( d.path );
      var S = { FINE_BIN: FINE_BIN, binMeanNoData: binMeanNoData, analyseBinned: analyseBinned };
      var res = detectFrame( fr.data, fr.width, fr.height, d, S, StarlinkSweeperMaskCore );
      return { result: res, width: fr.width, height: fr.height, seconds: ( Date.now() - t0 ) / 1000 };
   }

   function threadSource()
   {
      // Source of a detection thread: the scan core, the mask core, the
      // helpers above, and frameDetection as the value of the script.
      var src = [ StarlinkSweeperScan.coreSource(),
                  "var StarlinkSweeperMaskCore = ( " + StarlinkSweeperMaskCoreFactory.toString() + " )();" ];
      var helpers = [ channelMean, readFrame, detectFrame ];
      for ( var i = 0; i < helpers.length; ++i )
         src.push( helpers[i].toString() );
      src.push( "( " + frameDetection.toString() + " )" );
      return src.join( "\n" );
   }

   function detectData( opt )
   {
      return { minScore: opt.minScore, minLine: opt.minLine, groupAngle: opt.groupAngle, keepDistance: opt.keepDistance,
               detect: opt.detect, binning: opt.binning };
   }

   function threadCount( opt, paths )
   {
      // 1 (serial) without Thread objects (PixInsight before 1.9.5) or for a
      // single frame; otherwise opt.threads or the setting, and when it is 0
      // (automatic) as many as the processors and the available memory permit
      // (a frame read in full, its detection images and buffers per thread).
      if ( typeof Thread === "undefined" || paths.length < 2 )
         return 1;
      var n = opt.threads;
      if ( n === null || n === undefined )
      {
         n = Settings.read( "StarlinkSweeper/threads", DataType.Int32 );
         if ( !Settings.lastReadOK ) n = 0;
      }
      if ( !( n >= 1 ) )
      {
         n = Thread.numberOfProcessors;
         try
         {
            var mem = System.physicalMemoryStatus(), per = 0;
            var f = new FileFormatInstance( new FileFormat( File.extractExtension( paths[0] ), true, false ) );
            var desc = f.open( paths[0], "" );
            f.close();
            if ( desc && desc.length > 0 )
               per = 4 * desc[0].width * desc[0].height * ( desc[0].numberOfChannels + 2 ) + 268435456;
            if ( mem && mem.availableBytes > 0 && per > 0 )
               n = Math.min( n, Math.floor( 0.6 * mem.availableBytes / per ) );
         }
         catch ( e ) {}
      }
      return Math.max( 1, Math.min( Math.round( n ), paths.length ) );
   }

   function detectionPool( paths, data, n, idle )
   {
      // Detects paths[i] on up to n threads at a time, in the order of i.
      // result( i ) waits for frame i (calling idle() meanwhile) and returns
      // its detection, false when idle() returns true (stop requested), or
      // throws its error. stop() aborts and joins the running threads: it
      // must be called in every case.
      var src = threadSource(), next = 0, running = [], done = {};
      function refill()
      {
         for ( var k = running.length - 1; k >= 0; --k )
            if ( !running[k].thread.isActive )
            {
               var e = running[k];
               e.thread.wait();
               done[e.index] = e.thread.error ? { error: e.thread.error } : { value: e.thread.result };
               running.splice( k, 1 );
            }
         while ( running.length < n && next < paths.length )
         {
            var d = {};
            for ( var key in data ) d[key] = data[key];
            d.path = paths[next];
            var t = new Thread( src, d );
            t.start();
            running.push( { thread: t, index: next++ } );
         }
      }
      refill();
      return {
         result: function( i )
         {
            for ( ;; )
            {
               refill();
               if ( done[i] )
               {
                  var r = done[i];
                  delete done[i];
                  if ( r.error )
                     throw new Error( r.error );
                  return r.value;
               }
               var waiting = null;
               for ( var k = 0; k < running.length && !waiting; ++k )
                  if ( running[k].index == i ) waiting = running[k].thread;
               if ( !waiting )
                  throw new Error( "frame " + i + " was not scheduled for detection" );
               if ( !waiting.wait( 100 ) && idle && idle() )
                  return false;
            }
         },
         stop: function()
         {
            next = paths.length;
            for ( var k = 0; k < running.length; ++k ) running[k].thread.abort();
            for ( var k2 = 0; k2 < running.length; ++k2 ) running[k2].thread.wait();
            running = [];
         }
      };
   }

   // ------------------------------------------------------------- frames

   function applyMask( win, mask, value )
   {
      // Writes value under the mask in every channel.
      var view = win.mainView, img = view.image, rect = new Rect( 0, 0, img.width, img.height );
      view.beginProcess( NO_SWAP_FILE );
      try
      {
         var d = new Float32Array( img.width * img.height );
         for ( var c = 0; c < img.numberOfChannels; ++c )
         {
            img.getSamples( d, rect, c );
            for ( var i = 0; i < d.length; ++i )
               if ( mask[i] ) d[i] = value;
            img.setSamples( d, rect, c );
         }
      }
      finally
      {
         view.endProcess();
      }
   }

   function addHistory( win, text )
   {
      var kw = win.keywords;
      kw.push( new FITSKeyword( "HISTORY", "", text ) );
      win.keywords = kw;
   }

   function saveInPlace( win, path )
   {
      // Writes to a temporary file next to the original, then replaces it, so
      // that a failure never leaves a half-written frame.
      var tmp = File.extractDrive( path ) + File.extractDirectory( path ) + "/" + baseName( path ) +
                "_sstmp" + File.extractExtension( path );
      if ( File.exists( tmp ) )
         File.remove( tmp );
      if ( !win.saveAs( tmp, false /*query*/, false /*messages*/, false /*strict*/, false /*verifyOverwrite*/ ) )
         throw new Error( "Unable to write " + tmp );
      File.remove( path );
      File.move( tmp, path );
   }

   function writeImage( path, data, w, h, bits, real, hints )
   {
      // Writes a one-channel image ([0,1] data) as XISF with the given sample
      // format (without setOptions() it would be 16-bit integer).
      var win = new ImageWindow( w, h, 1, bits, real, false /*color*/, "StarlinkSweeper_tmp" );
      try
      {
         var view = win.mainView;
         view.beginProcess( NO_SWAP_FILE );
         view.image.setSamples( data, new Rect( 0, 0, w, h ), 0 );
         view.endProcess();
         var f = new FileFormatInstance( new FileFormat( ".xisf", false /*read*/, true /*write*/ ) );
         if ( !f.create( path, hints || "" ) )
            throw new Error( "Unable to create " + path );
         var d = new ImageDescription;
         d.bitsPerSample = bits;
         d.ieeefpSampleFormat = real;
         if ( !f.setOptions( d ) )
            throw new Error( "Unable to set the sample format of " + path );
         if ( !f.writeImage( view.image ) )
            throw new Error( "Unable to write " + path );
         f.close();
      }
      finally
      {
         win.forceClose();
      }
   }

   function processFrame( path, opt, coverage, found )
   {
      // Detects and masks the trails of one frame. found: the detection made
      // by a thread (frameDetection), or none. coverage: {count, before, w, h,
      // frames}, updated with the valid pixels left.
      var t0 = Date.now();
      var ws = ImageWindow.open( path, "", "", true );
      if ( ws.length < 1 )
         throw new Error( "Unable to open " + path );
      for ( var k = 1; k < ws.length; ++k ) ws[k].forceClose();
      var win = ws[0];
      try
      {
         var img = win.mainView.image, W = img.width, H = img.height, res;
         var full = null;
         if ( found )
         {
            if ( found.width != W || found.height != H )
               throw new Error( "the detection thread read an image of another size" );
            res = found.result;
         }
         else
         {
            full = channelMean( img );
            StarlinkSweeperScan.setAbort( opt.abort );
            try
            {
               res = detectFrame( full, W, H, detectData( opt ), StarlinkSweeperScan, StarlinkSweeperMaskCore );
            }
            finally
            {
               StarlinkSweeperScan.setAbort( null );
            }
         }
         var mask = new Uint8Array( W * H );
         var pixels = res.trails.length ? StarlinkSweeperMaskCore.rasterize( res, W, H, opt.binning, opt.margin, opt.endMargin, mask ) : 0;
         var maskBytes = 0;
         if ( pixels > 0 )
         {
            if ( !opt.dryRun )
            {
               applyMask( win, mask, opt.noData );
               addHistory( win, "StarlinkSweeper " + VERSION + ": " + res.trails.length + " trails, " +
                           pixels + " pixels set to " + opt.noData );
               saveInPlace( win, path );
            }
            if ( opt.outputDir && opt.writeMasks )
            {
               var m = new Float32Array( W * H ), mp = opt.outputDir + "/" + baseName( path ) + "_mask.xisf";
               for ( var i = 0; i < m.length; ++i ) m[i] = mask[i];
               writeImage( mp, m, W, H, 8, false, MASK_HINTS );
               try { maskBytes = new FileInfo( mp ).size; } catch ( e ) {}
            }
         }
         if ( coverage )
         {
            if ( !full ) full = channelMean( img );   // after masking: the masked pixels read 0
            if ( !coverage.count )
            {
               coverage.w = W; coverage.h = H;
               coverage.count = new Uint16Array( W * H );    // valid frames after masking
               coverage.before = new Uint16Array( W * H );   // valid frames before masking
            }
            if ( coverage.w == W && coverage.h == H )
            {
               for ( var j = 0; j < full.length; ++j )
               {
                  if ( full[j] != 0 || mask[j] ) ++coverage.before[j];
                  if ( full[j] != 0 && !mask[j] ) ++coverage.count[j];
               }
               ++coverage.frames;
            }
         }
         return { file: path, score: res.score, candidates: res.candidates, directions: res.directions,
                  trails: res.trails, far: res.far, rejected: res.rejected, pixels: pixels, fraction: pixels / ( W * H ),
                  maskBytes: maskBytes, seconds: ( Date.now() - t0 ) / 1000 + ( found ? found.seconds : 0 ) };
      }
      finally
      {
         win.forceClose();
      }
   }

   // ------------------------------------------------------------- groups

   function percent( x, digits )
   {
      return ( 100 * x ).toFixed( digits === undefined ? 1 : digits ) + "%";
   }

   function share( x )
   {
      // One decimal from 1% up, two significant digits below.
      var p = 100 * x;
      return ( p == 0 ? "0" : p >= 1 ? p.toFixed( 1 ) : p.toPrecision( 2 ) ) + "%";
   }

   function megabytes( bytes )
   {
      return ( bytes / 1048576 ).toFixed( bytes < 10485760 ? 2 : 0 ) + " MB";
   }

   function coverageReport( coverage, opt )
   {
      // Cost of the masks over the area covered by every frame: a pixel that
      // lost k of N frames keeps (N-k)/N of the exposure. Saves coverage.xisf
      // (fraction kept) and coverage.csv; returns the size written.
      var n = coverage.count.length, all = coverage.frames, thr = opt.lowCoverage * all;
      var lost = [], field = 0, mn = all, low = 0, m = new Float32Array( n ), bytes = 0;
      for ( var k = 0; k <= all; ++k ) lost.push( 0 );
      for ( var i = 0; i < n; ++i )
      {
         var c = coverage.count[i];
         m[i] = coverage.before[i] > 0 ? c / coverage.before[i] : 0;
         if ( coverage.before[i] != all )
            continue;
         ++field;
         ++lost[all - c];
         if ( c < mn ) mn = c;
         if ( c < thr ) ++low;
      }
      if ( field == 0 )
      {
         opt.log( "coverage: no pixel covered by every frame" );
         return 0;
      }
      var worst = all - mn, csv = [ "frames_lost,exposure_kept,pixels,field_fraction" ], lostSum = 0, hit = 0;
      for ( var k1 = 1; k1 <= all; ++k1 )
      {
         lostSum += k1 * lost[k1];
         hit += lost[k1];
      }
      opt.log( "data lost overall: " + share( lostSum / ( field * all ) ) + " (masked pixels out of all the pixels of the " +
               all + " frames)" );
      if ( worst > 0 )
         opt.log( "   " + share( hit / field ) + " of the field lost at least one frame, the rest keeps them all:" );
      for ( var k2 = 0; k2 <= all; ++k2 )
         if ( lost[k2] > 0 )
         {
            csv.push( k2 + "," + ( ( all - k2 ) / all ).toFixed( 4 ) + "," + lost[k2] + "," + ( lost[k2] / field ).toFixed( 6 ) );
            if ( k2 > 0 )
               opt.log( "   " + k2 + " of " + all + " frames lost: " + share( lost[k2] / field ) + " of the field, " +
                        lost[k2] + " px (exposure kept there " + percent( ( all - k2 ) / all, 1 ) + ")" );
         }
      if ( low > 0 )
         opt.log( "** " + low + " px keep less than " + percent( opt.lowCoverage, 0 ) + " of the frames" );
      if ( opt.outputDir )
      {
         var cp = opt.outputDir + "/coverage.xisf";
         writeImage( cp, m, coverage.w, coverage.h, 32, true, MASK_HINTS );
         File.writeTextFile( opt.outputDir + "/coverage.csv", csv.join( "\n" ) + "\n" );
         try { bytes = new FileInfo( cp ).size; } catch ( e ) {}
      }
      return bytes;
   }

   function processGroup( paths, o )
   {
      // Masks the trails of every frame of a registered group (in place).
      // Returns {results, failed, masked, bytes}.
      var opt = options( o ), T0 = Date.now();
      if ( opt.outputDir && !File.directoryExists( opt.outputDir ) )
         File.createDirectory( opt.outputDir, true );
      opt.log( "masking trails from a scan score of " + opt.minScore + " (frames are listed in the dialog from 20)" +
               ( opt.dryRun ? "; dry run, frames not modified" : "" ) );
      var nth = threadCount( opt, paths ), pool = null;
      if ( nth > 1 )
      {
         opt.log( "detection on " + nth + " threads" );
         pool = detectionPool( paths, detectData( opt ), nth, function()
         {
            if ( opt.onProgress ) opt.onProgress();
            return !!( opt.abort && opt.abort() );
         } );
      }
      var results = [], failed = [], coverage = { count: null, frames: 0 }, masked = 0, bytes = 0;
      var csv = [ "file,score,candidates,directions,trails,pixels,masked_fraction,seconds" ];
      var tcsv = [ "file,normal_angle_deg,length_px,width_px,peak_sigma" ];
      try
      {
         for ( var f = 0; f < paths.length; ++f )
         {
            if ( opt.abort && opt.abort() )
            {
               opt.log( "stopped by the user after " + f + " of " + paths.length + " frames" );
               break;
            }
            try
            {
               var found = null;
               if ( pool )
                  try
                  {
                     found = pool.result( f );
                  }
                  catch ( e )
                  {
                     opt.log( "** " + baseName( paths[f] ) + ": detection thread failed (" + e.message +
                              "), detected in the main thread" );
                  }
               if ( found === false )
               {
                  opt.log( "stopped by the user after " + f + " of " + paths.length + " frames" );
                  break;
               }
               var r = processFrame( paths[f], opt, coverage, found );
               results.push( r );
               if ( r.pixels > 0 ) ++masked;
               bytes += r.maskBytes;
               if ( opt.onFrame ) opt.onFrame( r );
               csv.push( '"' + baseName( paths[f] ) + '",' + r.score.toFixed( 1 ) + "," + r.candidates + "," + r.directions + "," +
                         r.trails.length + "," + r.pixels + "," + r.fraction.toFixed( 6 ) + "," + r.seconds.toFixed( 1 ) );
               for ( var t = 0; t < r.trails.length; ++t )
               {
                  var tr = r.trails[t];
                  tcsv.push( '"' + baseName( paths[f] ) + '",' + tr.geometry.angle.toFixed( 2 ) + "," +
                             Math.round( 2 * opt.binning * tr.geometry.half ) + "," + opt.binning * tr.width + "," + tr.peak.toFixed( 1 ) );
               }
               if ( r.pixels > 0 || r.candidates > 0 )
                  opt.log( ( f + 1 ) + "/" + paths.length + " " + baseName( paths[f] ) + ": " +
                           ( r.pixels > 0 ? r.trails.length + " trail(s), " + share( r.fraction ) + " of the frame masked" :
                                            "no trail confirmed" ) +
                           " (scan score " + r.score.toFixed( 1 ) + ", " + r.seconds.toFixed( 1 ) + " s)" );
            }
            catch ( e )
            {
               failed.push( paths[f] );
               opt.log( "** " + baseName( paths[f] ) + " left untouched: " + e.message );
            }
         }
      }
      finally
      {
         if ( pool ) pool.stop();   // every thread joined, also on a stop or an error
      }
      opt.log( masked + " of " + results.length + " frames masked, in " + ( ( Date.now() - T0 ) / 1000 ).toFixed( 1 ) + " s" +
               ( nth > 1 ? " (" + nth + " detection threads)" : "" ) );
      if ( coverage.count )
         bytes += coverageReport( coverage, opt );
      if ( opt.outputDir )
      {
         File.writeTextFile( opt.outputDir + "/frames.csv", csv.join( "\n" ) + "\n" );
         File.writeTextFile( opt.outputDir + "/trails.csv", tcsv.join( "\n" ) + "\n" );
         opt.log( "masks, coverage map and reports: " + megabytes( bytes ) + " in " + opt.outputDir );
      }
      return { results: results, failed: failed, masked: masked, bytes: bytes };
   }

   return {
      VERSION: VERSION,
      DEFAULTS: DEFAULTS,
      processGroup: processGroup,
      processFrame: function( path, o, coverage ) { return processFrame( path, options( o ), coverage ); }
   };
} )();
