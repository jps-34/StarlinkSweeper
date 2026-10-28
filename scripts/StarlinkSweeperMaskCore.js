/*
 * StarlinkSweeperMaskCore.js
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic), under the direction of Jacques Pouyaud.
 *
 * Mask geometry of the masking option: a copy of scripts/ClarkeMaskCore.js of
 * ClarkeMask (https://github.com/jps-34/ClarkeMask, commit 67f3df3), unchanged
 * except for the names of the factory (StarlinkSweeperMaskCoreFactory) and of
 * the namespace (StarlinkSweeperMaskCore), so that both scripts can be loaded
 * side by side. StarlinkSweeper only calls detect(), binMean2() and
 * rasterize(): along each direction found by its own scan, detect() finds every
 * trail (each member of a Starlink train separately), its width and its ends;
 * rasterize() draws the masks at full resolution. The functions about
 * geostationary trails (detectAll, length report) are kept unused, so that the
 * copy can be refreshed from ClarkeMask as a whole.
 *
 * Original description (ClarkeMaskCore.js):
 * Numeric core of ClarkeMask: detection of geostationary satellite trails and
 * geometry of their masks. Pure JavaScript, no PixInsight object: shared by the
 * dialog script and the WBPP event script, and run under node for validation
 * (tests/run_core.js). Everything lives in the ClarkeMaskCore namespace, since
 * the event script is evaluated in the scope of WBPP.
 *
 * Conventions
 *   Images are Float32Array, row-major, index y*w + x. A pixel at exactly 0
 *   carries no data (registration border, pixel already masked) and is
 *   ignored. Coordinates are centred: a pixel at index (x, y) has centre
 *   (x + 0.5 - w/2, y + 0.5 - h/2).
 *   theta is the angle of the trails' normal, in degrees: a trail is the line
 *   x*cos(theta) + y*sin(theta) = d, its direction is (-sin(theta), cos(theta)),
 *   and u = -x*sin(theta) + y*cos(theta) is the position along it.
 *
 * The namespace is built by StarlinkSweeperMaskCoreFactory(), which is self-contained:
 * the engine sends its source code to the detection threads (Thread objects of
 * PixInsight 1.9.5, each with a runtime of its own), where it builds the same
 * namespace.
 *
 * Detection (on a detection image, usually the 2x2 mean of the frame)
 *   1. Rectify along theta: for each distance d (1 px steps) and each segment
 *      of SEGMENT samples along u, sample bilinearly and take the median:
 *      stars are rejected, continuous trails kept.
 *   2. Per-pixel noise: median over cells of each cell's MAD.
 *   3. Perpendicular high-pass: subtract a running median across d (removes
 *      nebulae and gradients); E = excess in per-pixel noise units.
 *   4. Hysteresis: a core is an 8-connected run of cells with E above coreK
 *      times the noise of E, spanning at least minSegments segments; in each
 *      segment the mask extends across the trail while E >= edgeSigma.
 *   5. Collinear pieces separated by a short gap are merged; a trail must be
 *      straight (bend) and thin (core width), otherwise it is reported and not
 *      masked.
 *   6. Ends refined sample by sample along the trail.
 *   detectAll() repeats this on grids tilted a little either side of theta
 *   (inclined geosynchronous objects) and keeps one decision per trail.
 *
 * Heuristics, parameters and known limits: DETECTOR.md (keep it in sync).
 */

function StarlinkSweeperMaskCoreFactory()
{
   "use strict";

   var DEFAULTS = {
      segment: 64,          // samples per segment along the trail
      highPass: 31,         // perpendicular running-median window (px, odd)
      coreK: 10,            // core threshold, in units of the noise of E
      edgeSigma: 1.0,       // mask edge, in per-pixel noise units of the detection image
      minSegments: 3,       // core continuity along the trail
      maxGap: 2,            // segments: collinear pieces closer than this are merged
      mergeDistance: 3,     // px: max offset across the trail for merging
      maxCoreWidth: 15,     // px: wider cores are not trails (star halos, nebula edges)
      maxBend: 3,           // px: max deviation of the centres from a straight line
      minValid: 0.5,        // fraction of valid samples for a cell to count
      endSmooth: 9,         // samples: along-trail median window for end refinement
      maxAngle: 2.5,        // deg: trails further from theta are reported ("angle"), not masked (user setting)
      angleStep: 0.75,      // deg: step between the tilted detection grids
      angleRange: null,     // deg: tilt of the outermost grids; null = just enough to cover maxAngle
      maxCovered: 0.5,      // fraction: a candidate lying more than this on stronger trails is dropped
      expectedLength: null, // px (detection image): sidereal drift during the exposure, for the report
      lengthTolerance: 0.1, // fraction of expectedLength for the "single" length class
      maxConfirmedAngle: 7, // deg: beyond maxAngle and up to this, a trail is masked when its
                            // length confirms a geosynchronous object (needs expectedLength)
      confirmStep: 1.5      // deg: step of the grids beyond maxAngle (confirmation only)
   };

   // ---------------------------------------------------------------- statistics

   function kthSmallest( a, n, k )
   {
      // Quickselect in place on a[0..n-1]: returns the k-th smallest (0-based).
      var lo = 0, hi = n - 1;
      while ( hi > lo )
      {
         var pivot = a[( lo + hi ) >> 1], i = lo, j = hi;
         while ( i <= j )
         {
            while ( a[i] < pivot ) ++i;
            while ( a[j] > pivot ) --j;
            if ( i <= j )
            {
               var t = a[i]; a[i] = a[j]; a[j] = t;
               ++i; --j;
            }
         }
         if ( k <= j ) hi = j;
         else if ( k >= i ) lo = i;
         else break;
      }
      return a[k];
   }

   function medianInPlace( a, n )
   {
      // Median of a[0..n-1]; reorders a. Upper median for even n (cheaper,
      // and the difference is irrelevant at the sizes used here).
      return kthSmallest( a, n, n >> 1 );
   }

   function robustStats( values, n )
   {
      // {med, sig}: median and 1.4826 * MAD of values[0..n-1] (not modified).
      var c = new Float64Array( n );
      for ( var i = 0; i < n; ++i ) c[i] = values[i];
      var med = medianInPlace( c, n );
      for ( var j = 0; j < n; ++j ) c[j] = Math.abs( values[j] - med );
      var sig = 1.4826 * medianInPlace( c, n );
      return { med: med, sig: sig };
   }

   // ---------------------------------------------------------------- images

   function binMean2( src, w, h )
   {
      // 2x2 mean; the last row/column is dropped when odd. A block with any
      // pixel at 0 (no data) gives 0.
      var W = w >> 1, H = h >> 1, out = new Float32Array( W * H );
      for ( var Y = 0; Y < H; ++Y )
      {
         var r0 = 2 * Y * w, r1 = r0 + w;
         for ( var X = 0; X < W; ++X )
         {
            var x = 2 * X, a = src[r0 + x], b = src[r0 + x + 1], c = src[r1 + x], d = src[r1 + x + 1];
            out[Y * W + X] = ( a == 0 || b == 0 || c == 0 || d == 0 ) ? 0 : 0.25 * ( a + b + c + d );
         }
      }
      return { data: out, w: W, h: H };
   }

   function normalAngle( dx, dy )
   {
      // Normal angle (degrees, [0, 180)) of trails running along the pixel
      // direction (dx, dy).
      var a = Math.atan2( dy, dx ) * 180 / Math.PI - 90;
      return ( ( a % 180 ) + 180 ) % 180;
   }

   function sampler( img, w, h )
   {
      // Bilinear sampling at centred coordinates; NaN outside the image or
      // next to a pixel with no data.
      var cx = w / 2 - 0.5, cy = h / 2 - 0.5;
      return function( x, y )
      {
         var xi = x + cx, yi = y + cy;
         if ( !( xi >= 0 && yi >= 0 && xi <= w - 1 && yi <= h - 1 ) )
            return NaN;
         var x0 = Math.floor( xi ), y0 = Math.floor( yi );
         var x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
         var fx = xi - x0, fy = yi - y0;
         var a = img[y0 * w + x0], b = img[y0 * w + x1], c = img[y1 * w + x0], d = img[y1 * w + x1];
         if ( a == 0 || b == 0 || c == 0 || d == 0 )
            return NaN;
         return ( 1 - fy ) * ( ( 1 - fx ) * a + fx * b ) + fy * ( ( 1 - fx ) * c + fx * d );
      };
   }

   // ---------------------------------------------------------------- detection

   function Grid( w, h, theta, segment )
   {
      // Rectified grid: rows = distance d (index i, d = i - dHalf), columns =
      // segments of `segment` samples along u starting at u = -uHalf.
      this.w = w; this.h = h; this.theta = theta; this.segment = segment;
      var t = theta * Math.PI / 180;
      this.c = Math.cos( t ); this.s = Math.sin( t );
      this.dHalf = Math.ceil( Math.sqrt( w * w + h * h ) / 2 ) + 1;
      this.nd = 2 * this.dHalf + 1;
      this.uHalf = this.dHalf;
      this.nseg = Math.ceil( ( 2 * this.uHalf + 1 ) / segment );
   }

   Grid.prototype.segmentStart = function( j )
   {
      return -this.uHalf + j * this.segment;
   };

   Grid.prototype.x = function( d, u ) { return d * this.c - u * this.s; };
   Grid.prototype.y = function( d, u ) { return d * this.s + u * this.c; };

   function cellMedians( img, g, opt )
   {
      // M: median per (d, segment) cell, NaN when too few valid samples.
      // Also returns the per-pixel noise (median over cells of the cell MAD).
      // Hot loop (most of the detection time): the bilinear sampling of
      // sampler() is inlined with the same arithmetic, and segments lying
      // wholly outside the image (about half of the grid) are skipped.
      var w = g.w, h = g.h, cx = w / 2 - 0.5, cy = h / 2 - 0.5, c = g.c, s = g.s;
      var seg = g.segment, nd = g.nd, nseg = g.nseg, uFirst = g.segmentStart( 0 );
      var M = new Float32Array( nd * nseg ), buf = new Float64Array( seg ), dev = new Float64Array( seg );
      var mads = new Float32Array( nd * nseg ), nm = 0, valid = 0, minN = Math.ceil( opt.minValid * seg );
      for ( var i = 0; i < nd; ++i )
      {
         var d = i - g.dHalf, dc = d * c, ds = d * s;
         // u interval where the row may be inside the image, widened by 1:
         // only used to skip segments, every sample is still tested
         var uLo = -Infinity, uHi = Infinity;
         if ( s != 0 )
         {
            var a1 = ( dc + cx ) / s, a2 = ( dc + cx - ( w - 1 ) ) / s;
            uLo = Math.max( uLo, Math.min( a1, a2 ) - 1 ); uHi = Math.min( uHi, Math.max( a1, a2 ) + 1 );
         }
         if ( c != 0 )
         {
            var b1 = ( -cy - ds ) / c, b2 = ( h - 1 - cy - ds ) / c;
            uLo = Math.max( uLo, Math.min( b1, b2 ) - 1 ); uHi = Math.min( uHi, Math.max( b1, b2 ) + 1 );
         }
         for ( var j = 0; j < nseg; ++j )
         {
            var u0 = uFirst + j * seg, n = 0;
            if ( u0 + seg - 1 < uLo || u0 > uHi )
            {
               M[i * nseg + j] = NaN;
               continue;
            }
            for ( var k = 0; k < seg; ++k )
            {
               var u = u0 + k, xi = ( dc - u * s ) + cx, yi = ( ds + u * c ) + cy;
               if ( !( xi >= 0 && yi >= 0 && xi <= w - 1 && yi <= h - 1 ) )
                  continue;
               var x0 = Math.floor( xi ), y0 = Math.floor( yi );
               var x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
               var fx = xi - x0, fy = yi - y0;
               var p = img[y0 * w + x0], q2 = img[y0 * w + x1], r = img[y1 * w + x0], t = img[y1 * w + x1];
               if ( p == 0 || q2 == 0 || r == 0 || t == 0 )
                  continue;
               var v = ( 1 - fy ) * ( ( 1 - fx ) * p + fx * q2 ) + fy * ( ( 1 - fx ) * r + fx * t );
               if ( v == v )
                  buf[n++] = v;
            }
            if ( n < minN )
            {
               M[i * nseg + j] = NaN;
               continue;
            }
            var m = medianInPlace( buf, n );
            M[i * nseg + j] = m;
            ++valid;
            // the per-pixel noise is a median over cells: one row in eight is
            // plenty, and this second selection was half of the work
            if ( ( i & 7 ) == 0 )
            {
               for ( var q = 0; q < n; ++q ) dev[q] = Math.abs( buf[q] - m );
               mads[nm++] = 1.4826 * medianInPlace( dev, n );
            }
         }
      }
      var sigPix = nm > 0 ? medianInPlace( mads, nm ) : 0;
      return { M: M, sigPix: sigPix, validCells: valid };
   }

   function runningMedian( M, nd, nseg, j, r, med, count )
   {
      // For every row i of column j of M: median (the upper one for an even
      // count, like medianInPlace) and number of the defined values within
      // rows i - r .. i + r. A sorted window slides along the column, one
      // removal and one insertion per row. med[i] = NaN where it is empty.
      var win = new Float64Array( 2 * r + 1 ), n = 0;
      function insert( v )
      {
         var k = n++;
         while ( k > 0 && win[k - 1] > v ) { win[k] = win[k - 1]; --k; }
         win[k] = v;
      }
      function remove( v )
      {
         var k = 0;
         while ( k < n && win[k] != v ) ++k;
         for ( ; k < n - 1; ++k ) win[k] = win[k + 1];
         --n;
      }
      for ( var q = 0; q <= Math.min( nd - 1, r ); ++q )
      {
         var v0 = M[q * nseg + j];
         if ( v0 == v0 ) insert( v0 );
      }
      for ( var i = 0; i < nd; ++i )
      {
         med[i] = n > 0 ? win[n >> 1] : NaN;
         count[i] = n;
         if ( i - r >= 0 )
         {
            var vo = M[( i - r ) * nseg + j];
            if ( vo == vo ) remove( vo );
         }
         if ( i + r + 1 < nd )
         {
            var vi = M[( i + r + 1 ) * nseg + j];
            if ( vi == vi ) insert( vi );
         }
      }
   }

   function excessMap( M, g, sigPix, opt )
   {
      // E = (M - running median of M across d) / sigPix; NaN where undefined.
      var nd = g.nd, nseg = g.nseg, r = opt.highPass >> 1, minN = Math.ceil( opt.highPass / 3 );
      var E = new Float32Array( nd * nseg ), med = new Float64Array( nd ), count = new Int32Array( nd );
      for ( var j = 0; j < nseg; ++j )
      {
         runningMedian( M, nd, nseg, j, r, med, count );
         for ( var i = 0; i < nd; ++i )
         {
            var o = i * nseg + j, m = M[o];
            E[o] = ( m == m && sigPix > 0 && count[i] >= minN ) ? ( m - med[i] ) / sigPix : NaN;
         }
      }
      return E;
   }

   function components( core, nd, nseg )
   {
      // 8-connected components of a boolean grid -> array of arrays of cell
      // indices.
      var label = new Int32Array( nd * nseg ), queue = new Int32Array( nd * nseg ), out = [];
      for ( var start = 0; start < nd * nseg; ++start )
      {
         if ( !core[start] || label[start] )
            continue;
         var id = out.length + 1, head = 0, tail = 0, cells = [];
         queue[tail++] = start; label[start] = id;
         while ( head < tail )
         {
            var o = queue[head++], i = ( o / nseg ) | 0, j = o - i * nseg;
            cells.push( o );
            for ( var di = -1; di <= 1; ++di )
               for ( var dj = -1; dj <= 1; ++dj )
               {
                  var ii = i + di, jj = j + dj;
                  if ( ii < 0 || jj < 0 || ii >= nd || jj >= nseg )
                     continue;
                  var p = ii * nseg + jj;
                  if ( core[p] && !label[p] )
                  {
                     label[p] = id;
                     queue[tail++] = p;
                  }
               }
         }
         out.push( cells );
      }
      return out;
   }

   function columnPieces( cells, E, g, tEdge )
   {
      // Per segment column: core range, mask range (core extended while
      // E >= tEdge), excess-weighted centre and peak.
      var nseg = g.nseg, cols = {};
      for ( var k = 0; k < cells.length; ++k )
      {
         var o = cells[k], i = ( o / nseg ) | 0, j = o - i * nseg, c = cols[j];
         if ( !c ) cols[j] = c = { j: j, coreLo: i, coreHi: i };
         if ( i < c.coreLo ) c.coreLo = i;
         if ( i > c.coreHi ) c.coreHi = i;
      }
      var pieces = [];
      for ( var key in cols )
      {
         var p = cols[key], lo = p.coreLo, hi = p.coreHi;
         while ( lo > 0 && E[( lo - 1 ) * nseg + p.j] >= tEdge ) --lo;
         while ( hi < g.nd - 1 && E[( hi + 1 ) * nseg + p.j] >= tEdge ) ++hi;
         var sw = 0, sd = 0, peak = 0;
         for ( var i2 = lo; i2 <= hi; ++i2 )
         {
            var e = E[i2 * nseg + p.j];
            if ( e > 0 ) { sw += e; sd += e * i2; }
            if ( e > peak ) peak = e;
         }
         pieces.push( { j: p.j, iLo: lo, iHi: hi, coreWidth: p.coreHi - p.coreLo + 1,
                        centre: ( sw > 0 ? sd / sw : 0.5 * ( lo + hi ) ) - g.dHalf, peak: peak } );
      }
      pieces.sort( function( a, b ) { return a.j - b.j; } );
      return pieces;
   }

   function lineFit( pieces )
   {
      // Least-squares centre = a + b*j; returns {a, b, bend (max |residual|)}.
      var n = pieces.length, sj = 0, sc = 0, sjj = 0, sjc = 0;
      for ( var k = 0; k < n; ++k )
      {
         var j = pieces[k].j, c = pieces[k].centre;
         sj += j; sc += c; sjj += j * j; sjc += j * c;
      }
      var den = n * sjj - sj * sj, b = den != 0 ? ( n * sjc - sj * sc ) / den : 0, a = ( sc - b * sj ) / n, bend = 0;
      for ( var q = 0; q < n; ++q )
         bend = Math.max( bend, Math.abs( pieces[q].centre - ( a + b * pieces[q].j ) ) );
      return { a: a, b: b, bend: bend };
   }

   function refineEnd( img, g, piece, direction, tEdge, sigPix, opt, background )
   {
      // Along-trail profile (mean over the piece's mask range minus the
      // background of its column, running median of endSmooth samples) from
      // the middle of the piece outwards, over one more segment; returns the u
      // of the last sample still at or above the threshold.
      var at = sampler( img, g.w, g.h ), seg = g.segment, u0 = g.segmentStart( piece.j );
      var from = u0 + ( seg >> 1 ), n = seg + ( seg >> 1 ), prof = new Float64Array( n );
      for ( var k = 0; k < n; ++k )
      {
         var u = from + direction * k, s = 0, m = 0;
         for ( var i = piece.iLo; i <= piece.iHi; ++i )
         {
            var v = at( g.x( i - g.dHalf, u ), g.y( i - g.dHalf, u ) );
            if ( v == v ) { s += v - background[i]; ++m; }
         }
         prof[k] = m > 0 ? s / m / sigPix : NaN;
      }
      var r = opt.endSmooth >> 1, win = new Float64Array( 2 * r + 1 ), last = 0;
      var thr = Math.max( tEdge, 0.25 * piece.peak );
      for ( var k2 = 0; k2 < n; ++k2 )
      {
         var c = 0;
         for ( var q = Math.max( 0, k2 - r ); q <= Math.min( n - 1, k2 + r ); ++q )
            if ( prof[q] == prof[q] ) win[c++] = prof[q];
         if ( c == 0 || medianInPlace( win, c ) < thr )
            break;
         last = k2;
      }
      return from + direction * last;
   }

   function detect( img, w, h, theta, options )
   {
      // Detects trails along theta in img (w x h). Returns
      // {theta, sigPix, sigE, tCore, tEdge, trails: [...], rejected: [...]}.
      // Each trail: {centre, slope, bend, uStart, uEnd, length, width, peak,
      // pieces: [{u0, u1, dLo, dHi}]} in detection-image pixels.
      var opt = {};
      for ( var key in DEFAULTS ) opt[key] = DEFAULTS[key];
      if ( options ) for ( var key2 in options ) opt[key2] = options[key2];

      var g = new Grid( w, h, theta, opt.segment ), nd = g.nd, nseg = g.nseg;
      var cm = cellMedians( img, g, opt );
      var E = excessMap( cm.M, g, cm.sigPix, opt );
      var vals = [];
      for ( var o = 0; o < E.length; ++o ) if ( E[o] == E[o] ) vals.push( E[o] );
      var st = robustStats( vals, vals.length );
      var tCore = st.med + opt.coreK * st.sig, tEdge = Math.min( opt.edgeSigma, tCore );

      var core = new Uint8Array( nd * nseg );
      for ( var o2 = 0; o2 < E.length; ++o2 ) core[o2] = E[o2] >= tCore ? 1 : 0;

      // core components -> pieces, then merge collinear neighbours
      var groups = [];
      var comps = components( core, nd, nseg );
      for ( var c = 0; c < comps.length; ++c )
         groups.push( columnPieces( comps[c], E, g, tEdge ) );
      groups.sort( function( a, b ) { return a[0].j - b[0].j; } );
      // each merged candidate remembers its parts (the original components)
      var merged = [];
      for ( var gi = 0; gi < groups.length; ++gi )
      {
         var gp = groups[gi], done = false;
         for ( var mi = 0; mi < merged.length && !done; ++mi )
         {
            var mg = merged[mi].pcs, last = mg[mg.length - 1], gap = gp[0].j - last.j;
            if ( gap >= 1 && gap <= opt.maxGap + 1 && Math.abs( gp[0].centre - last.centre ) <= opt.mergeDistance )
            {
               merged[mi] = { pcs: mg.concat( gp ), parts: merged[mi].parts.concat( [ gp ] ) };
               done = true;
            }
         }
         if ( !done ) merged.push( { pcs: gp, parts: [ gp ] } );
      }

      var trails = [], rejected = [];
      for ( var t = 0; t < merged.length; ++t )
      {
         var pcs = merged[t].pcs, span = pcs[pcs.length - 1].j - pcs[0].j + 1;
         if ( span < opt.minSegments )
            continue;
         var fit = lineFit( pcs ), widths = [], cores = [], peaks = [];
         for ( var p = 0; p < pcs.length; ++p )
         {
            widths.push( pcs[p].iHi - pcs[p].iLo + 1 );
            cores.push( pcs[p].coreWidth );
            peaks.push( pcs[p].peak );
         }
         var coreWidth = medianInPlace( Float64Array.from( cores ), cores.length ), strength = 0;
         for ( var p1 = 0; p1 < peaks.length; ++p1 ) strength += peaks[p1];
         var jMid = 0.5 * ( pcs[0].j + pcs[pcs.length - 1].j );
         var info = { theta: theta, centre: fit.a + fit.b * jMid, slope: fit.b / opt.segment,
                      uCentre: g.segmentStart( 0 ) + jMid * opt.segment + 0.5 * ( opt.segment - 1 ),
                      bend: fit.bend, coreWidth: coreWidth,
                      width: medianInPlace( Float64Array.from( widths ), widths.length ),
                      peak: Math.max.apply( null, peaks ), strength: strength, segments: span,
                      uStart: g.segmentStart( pcs[0].j ), uEnd: g.segmentStart( pcs[pcs.length - 1].j ) + opt.segment - 1 };
         if ( fit.bend > opt.maxBend && merged[t].parts.length > 1 )
         {
            // collinear pieces that do not make one straight line (for instance
            // two objects end to end, slightly offset): judge each part alone
            for ( var pp = 0; pp < merged[t].parts.length; ++pp )
               merged.push( { pcs: merged[t].parts[pp], parts: [ merged[t].parts[pp] ] } );
            continue;
         }
         if ( fit.bend > opt.maxBend || coreWidth > opt.maxCoreWidth )
         {
            info.reason = fit.bend > opt.maxBend ? "bent" : "wide";
            info.geometry = trailGeometry( info );
            rejected.push( info );
            continue;
         }
         // fill gaps left by the merge with the fitted centre and median width
         var full = [], half = 0.5 * ( info.width - 1 );
         for ( var p2 = 0; p2 < pcs.length; ++p2 )
         {
            if ( p2 > 0 )
               for ( var jg = pcs[p2 - 1].j + 1; jg < pcs[p2].j; ++jg )
               {
                  var cc = fit.a + fit.b * jg + g.dHalf;
                  full.push( { j: jg, iLo: Math.floor( cc - half ), iHi: Math.ceil( cc + half ), peak: 0 } );
               }
            full.push( pcs[p2] );
         }
         // ends, sample by sample
         var bgFirst = columnBackground( cm.M, g, full[0].j, opt );
         var bgLast = columnBackground( cm.M, g, full[full.length - 1].j, opt );
         var uStart = refineEnd( img, g, full[0], -1, tEdge, cm.sigPix, opt, bgFirst );
         var uEnd = refineEnd( img, g, full[full.length - 1], +1, tEdge, cm.sigPix, opt, bgLast );
         var out = [];
         for ( var p3 = 0; p3 < full.length; ++p3 )
         {
            var a0 = g.segmentStart( full[p3].j ), a1 = a0 + opt.segment - 1;
            if ( p3 == 0 ) a0 = uStart;
            if ( p3 == full.length - 1 ) a1 = uEnd;
            if ( a1 < a0 ) continue;
            out.push( { u0: a0, u1: a1, dLo: full[p3].iLo - g.dHalf, dHi: full[p3].iHi - g.dHalf } );
         }
         info.uStart = uStart; info.uEnd = uEnd; info.length = uEnd - uStart + 1;
         info.pieces = out;
         info.geometry = trailGeometry( info );
         trails.push( info );
      }
      trails.sort( function( a, b ) { return a.centre - b.centre; } );
      return { theta: theta, w: w, h: h, sigPix: cm.sigPix, sigE: st.sig, tCore: tCore, tEdge: tEdge,
               validCells: cm.validCells, trails: trails, rejected: rejected };
   }

   function trailGeometry( t )
   {
      // Image-space line of a trail found on the grid at t.theta: midpoint of
      // its extent, unit direction, and normal angle (the grid angle corrected
      // by the fitted slope).
      var a = t.theta * Math.PI / 180, c = Math.cos( a ), s = Math.sin( a );
      var uMid = 0.5 * ( t.uStart + t.uEnd ), dMid = t.centre + t.slope * ( uMid - t.uCentre );
      var dx = t.slope * c - s, dy = t.slope * s + c, n = Math.sqrt( dx * dx + dy * dy );
      return { x: dMid * c - uMid * s, y: dMid * s + uMid * c, ux: dx / n, uy: dy / n,
               half: 0.5 * ( t.uEnd - t.uStart ) * n, angle: normalAngle( dx, dy ) };
   }

   function sameTrail( a, b, opt )
   {
      // True when b lies on a: close directions, b's midpoint within a's width
      // (plus the merge distance) of a's line and within a's extent (plus one
      // segment) along it.
      var ga = a.geometry, gb = b.geometry, da = Math.abs( ga.angle - gb.angle );
      if ( Math.min( da, 180 - da ) > 2 * opt.angleStep )
         return false;
      var ex = gb.x - ga.x, ey = gb.y - ga.y;
      var along = ex * ga.ux + ey * ga.uy, across = Math.abs( -ex * ga.uy + ey * ga.ux );
      return across <= 0.5 * Math.max( a.width, b.width ) + opt.mergeDistance &&
             Math.abs( along ) <= ga.half + opt.segment;
   }

   function coveredFraction( t, others )
   {
      // Fraction of the length of t lying on one of the other trails (within
      // their half width plus 2 px, inside their extent). A tilted line
      // through a pack of parallel trails collects their light where it
      // crosses them: such a candidate is mostly covered by those trails.
      var g = t.geometry, n = 0, hit = 0;
      for ( var a = -g.half; a <= g.half; a += 2 )
      {
         var x = g.x + a * g.ux, y = g.y + a * g.uy, on = false;
         for ( var k = 0; k < others.length && !on; ++k )
         {
            var o = others[k].geometry, ex = x - o.x, ey = y - o.y;
            on = Math.abs( ex * o.ux + ey * o.uy ) <= o.half &&
                 Math.abs( -ex * o.uy + ey * o.ux ) <= 0.5 * others[k].width + 2;
         }
         ++n;
         if ( on ) ++hit;
      }
      return n > 0 ? hit / n : 0;
   }

   function extendsBeyond( t, ref, margin )
   {
      // True when t reaches more than `margin` px past either end of ref,
      // measured along ref's line.
      var g = t.geometry, r = ref.geometry;
      var c = ( g.x - r.x ) * r.ux + ( g.y - r.y ) * r.uy;
      var h = g.half * Math.abs( g.ux * r.ux + g.uy * r.uy );
      return c + h > r.half + margin || c - h < -r.half - margin;
   }

   function endIsCut( at, t, sign, reach )
   {
      // True when the line beyond one end of t leaves the image or meets
      // pixels without data within `reach` px: the trail may go on there.
      var g = t.geometry;
      for ( var k = 2; k <= reach; k += 2 )
      {
         var a = sign * ( g.half + k );
         if ( !( at( g.x + a * g.ux, g.y + a * g.uy ) == at( g.x + a * g.ux, g.y + a * g.uy ) ) )
            return true;
      }
      return false;
   }

   function lengthReport( img, w, h, t, theta, opt )
   {
      // Length diagnostic (reported, not a criterion; see DETECTOR.md):
      // ratio to the expected length of a geosynchronous object (corrected
      // for the trail tilt), and a class: "cut" (an end at the image edge or
      // a border without data), "single" (about one expected length),
      // "partial" (shorter, both ends free: faint part below the threshold,
      // Earth shadow, or another kind of object), "overlap" (longer: objects
      // at the same declination overlapping or end to end).
      if ( !( opt.expectedLength > 0 ) )
         return;
      var at = sampler( img, w, h ), reach = opt.segment >> 1;
      var off = ( t.geometry.angle - theta ) * Math.PI / 180;
      var expected = opt.expectedLength / Math.max( Math.abs( Math.cos( off ) ), 0.5 );
      t.lengthRatio = 2 * t.geometry.half / expected;
      t.cut = endIsCut( at, t, -1, reach ) || endIsCut( at, t, +1, reach );
      if ( Math.abs( t.lengthRatio - 1 ) <= opt.lengthTolerance )
         t.lengthClass = "single";
      else if ( t.lengthRatio > 1 )
         t.lengthClass = "overlap";
      else
         t.lengthClass = t.cut ? "cut" : "partial";
   }

   function detectAll( img, w, h, theta, options )
   {
      // detect() along theta and along theta +/- k * angleStep up to
      // angleRange, so that trails slightly off the belt direction (inclined
      // geosynchronous objects) are found whole. A trail found at several
      // angles is kept once, at the angle where it is strongest (sum of the
      // segment peaks: longest and most contrasted). Same result as detect(),
      // each trail and rejected candidate carrying its own theta.
      var opt = {};
      for ( var key in DEFAULTS ) opt[key] = DEFAULTS[key];
      if ( options ) for ( var key2 in options ) opt[key2] = options[key2];
      // One grid catches trails within about half a step of its angle. Fine
      // grids (angleStep) cover maxAngle; when the length can confirm a
      // geosynchronous object (expectedLength known), coarser grids
      // (confirmStep) go on up to maxConfirmedAngle: they only serve to
      // confirm long straight trails, which tolerate a larger angle error.
      var confirm = opt.expectedLength > 0 && opt.maxConfirmedAngle > opt.maxAngle;
      var reachOf = function( step, target ) { return step > 0 ? step * Math.ceil( Math.max( 0, target - 0.5 * step ) / step ) : 0; };
      var range = opt.angleRange;
      if ( range === null || range === undefined )
         range = reachOf( opt.angleStep, opt.maxAngle );
      var offsets = [ 0 ];
      if ( opt.angleStep > 0 )
         for ( var a = opt.angleStep; a <= range + 1e-9; a += opt.angleStep )
            offsets.push( a, -a );
      var cstep = opt.confirmStep > 0 ? opt.confirmStep : opt.angleStep;
      if ( confirm && cstep > 0 )
         for ( var b = range + cstep; b - 0.5 * cstep < opt.maxConfirmedAngle + 1e-9; b += cstep )
            offsets.push( b, -b );
      var base = null, found = [], refused = [];
      for ( var i = 0; i < offsets.length; ++i )
      {
         var r = detect( img, w, h, theta + offsets[i], opt );
         if ( typeof opt.onGrid === "function" ) opt.onGrid( i + 1, offsets.length );
         if ( i == 0 ) base = r;
         for ( var k = 0; k < r.trails.length; ++k )
         {
            var tk = r.trails[k], off = Math.abs( tk.geometry.angle - theta ) % 180;
            tk.offset = offsets[i];
            tk.angleFromBelt = Math.min( off, 180 - off );
            if ( tk.angleFromBelt > opt.maxAngle )
               tk.reason = "angle";       // straight and thin, but not along the belt (may be confirmed below)
            found.push( tk );
         }
         for ( var q = 0; q < r.rejected.length; ++q )
         {
            r.rejected[q].offset = offsets[i];
            refused.push( r.rejected[q] );
         }
      }
      // One physical trail, one decision: all versions (accepted or off-angle)
      // compete by strength; the strongest decides for the whole trail, and the
      // versions lying on it (fragments, other angles) are dropped with it.
      var byStrength = function( x, y ) { return y.strength - x.strength; };
      found.sort( byStrength );
      refused.sort( byStrength );
      var winners = [], kept = [], dropped = [];
      for ( var f = 0; f < found.length; ++f )
      {
         var dup = null;
         for ( var m = 0; m < winners.length && !dup; ++m )
            if ( sameTrail( winners[m], found[f], opt ) || sameTrail( found[f], winners[m], opt ) )
               dup = winners[m];
         if ( dup )
         {
            // another version with the same decision (masked, or off-angle and
            // possibly confirmed by length) that extends the trail by more than
            // a quarter segment (a fainter part, when the brightness varies
            // along the trail): masked with it if the trail is. Versions
            // within its extent add nothing but width, and are ignored.
            if ( dup.reason == found[f].reason && extendsBeyond( found[f], dup, 0.25 * opt.segment ) )
               ( dup.versions = dup.versions || [] ).push( found[f] );
            continue;
         }
         // made of crossings of stronger trails at another angle: not a trail
         if ( coveredFraction( found[f], winners ) > opt.maxCovered )
            continue;
         winners.push( found[f] );
         ( found[f].reason ? dropped : kept ).push( found[f] );
      }
      // a bent or wide candidate is reported once, unless a trail covers it
      for ( var f2 = 0; f2 < refused.length; ++f2 )
      {
         var cover = false;
         for ( var m2 = 0; m2 < winners.length && !cover; ++m2 ) cover = sameTrail( winners[m2], refused[f2], opt );
         for ( var m3 = 0; m3 < dropped.length && !cover; ++m3 ) cover = sameTrail( dropped[m3], refused[f2], opt );
         if ( !cover ) dropped.push( refused[f2] );
      }
      for ( var lk = 0; lk < kept.length; ++lk ) lengthReport( img, w, h, kept[lk], theta, opt );
      for ( var ld = 0; ld < dropped.length; ++ld ) lengthReport( img, w, h, dropped[ld], theta, opt );
      // Confirmation by length: a straight trail beyond maxAngle, up to
      // maxConfirmedAngle, of about one expected length with both ends free,
      // moves at the sidereal rate: a geosynchronous object, masked.
      if ( confirm )
         for ( var lc = dropped.length - 1; lc >= 0; --lc )
         {
            var dc = dropped[lc];
            if ( dc.reason == "angle" && dc.angleFromBelt <= opt.maxConfirmedAngle &&
                 dc.lengthClass == "single" && !dc.cut )
            {
               delete dc.reason;
               dc.confirmedByLength = true;
               kept.push( dc );
               dropped.splice( lc, 1 );
            }
         }
      kept.sort( function( x, y ) { return x.centre - y.centre; } );
      return { theta: theta, w: w, h: h, sigPix: base.sigPix, sigE: base.sigE, tCore: base.tCore, tEdge: base.tEdge,
               validCells: base.validCells, angles: offsets.length, trails: kept, rejected: dropped };
   }

   function columnBackground( M, g, j, opt )
   {
      // Running median of M across d in column j (Float64Array over d index).
      var nd = g.nd, bg = new Float64Array( nd ), count = new Int32Array( nd );
      runningMedian( M, nd, g.nseg, j, opt.highPass >> 1, bg, count );
      for ( var i = 0; i < nd; ++i )
         if ( count[i] == 0 ) bg[i] = 0;
      return bg;
   }

   // ---------------------------------------------------------------- masks

   function rasterize( result, W, H, scale, margin, endMargin, mask )
   {
      // Writes 1 into mask (Uint8Array W*H, full resolution) under every trail
      // of a detect() result made on an image `scale` times smaller. margin:
      // full-resolution px added across the trail, endMargin: along it.
      // Returns the number of pixels newly set. Each trail is drawn on the
      // grid of its own theta (detectAll), result.theta otherwise.
      var cx = scale * result.w / 2, cy = scale * result.h / 2, count = 0, all = [];
      for ( var v = 0; v < result.trails.length; ++v )   // each trail with its other versions (detectAll)
         all = all.concat( [ result.trails[v] ], result.trails[v].versions || [] );
      for ( var k = 0; k < all.length; ++k )
      {
         var tr = all[k], ta = ( tr.theta === undefined ? result.theta : tr.theta ) * Math.PI / 180;
         var c = Math.cos( ta ), s = Math.sin( ta ), pcs = tr.pieces;
         // the mask follows the fitted line of the trail (parallelograms), not
         // the grid rows: line(u) = scale * (centre + slope * (u / scale - uCentre))
         var sl = tr.slope || 0, dc = tr.centre || 0, uc = tr.uCentre || 0;
         var line = function( uf ) { return scale * ( dc + sl * ( uf / scale - uc ) ); };
         for ( var p = 0; p < pcs.length; ++p )
         {
            var um = 0.5 * ( pcs[p].u0 + pcs[p].u1 ), ref = dc + sl * ( um - uc );
            var e0 = scale * ( pcs[p].dLo - ref - 0.5 ) - margin, e1 = scale * ( pcs[p].dHi - ref + 0.5 ) + margin;
            var u0 = scale * ( pcs[p].u0 - 0.5 ) - ( p == 0 ? endMargin : 0 );
            var u1 = scale * ( pcs[p].u1 + 0.5 ) + ( p == pcs.length - 1 ? endMargin : 0 );
            var l0 = line( u0 ), l1 = line( u1 );
            // bounding box of the parallelogram
            var xs = [ ( l0 + e0 ) * c - u0 * s, ( l1 + e0 ) * c - u1 * s, ( l0 + e1 ) * c - u0 * s, ( l1 + e1 ) * c - u1 * s ];
            var ys = [ ( l0 + e0 ) * s + u0 * c, ( l1 + e0 ) * s + u1 * c, ( l0 + e1 ) * s + u0 * c, ( l1 + e1 ) * s + u1 * c ];
            var xa = Math.max( 0, Math.floor( Math.min.apply( null, xs ) + cx - 0.5 ) );
            var xb = Math.min( W - 1, Math.ceil( Math.max.apply( null, xs ) + cx - 0.5 ) );
            var ya = Math.max( 0, Math.floor( Math.min.apply( null, ys ) + cy - 0.5 ) );
            var yb = Math.min( H - 1, Math.ceil( Math.max.apply( null, ys ) + cy - 0.5 ) );
            for ( var y = ya; y <= yb; ++y )
            {
               var py = y + 0.5 - cy;
               for ( var x = xa; x <= xb; ++x )
               {
                  var px = x + 0.5 - cx, d = px * c + py * s, u = -px * s + py * c, e = d - line( u );
                  if ( e >= e0 && e <= e1 && u >= u0 && u <= u1 )
                  {
                     var o = y * W + x;
                     if ( !mask[o] ) { mask[o] = 1; ++count; }
                  }
               }
            }
         }
      }
      return count;
   }

   return {
      VERSION: "0.2.4",
      DEFAULTS: DEFAULTS,
      binMean2: binMean2,
      normalAngle: normalAngle,
      robustStats: robustStats,
      detect: detect,
      detectAll: detectAll,
      rasterize: rasterize
   };
}

var StarlinkSweeperMaskCore = StarlinkSweeperMaskCoreFactory();

if ( typeof module !== "undefined" && module.exports )
   module.exports = StarlinkSweeperMaskCore;
