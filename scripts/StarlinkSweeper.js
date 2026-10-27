#engine v8
#feature-id    StarlinkSweeper : Utilities > StarlinkSweeper
#feature-info  Finds subframes crossed by satellite or aircraft trails, shows \
   each detection on a preview, and lets you quarantine (moved next to the \
   scanned folder) or erase the affected frames one by one. Nothing is deleted \
   without confirmation.

/*
 * StarlinkSweeper.js  v1.2.1
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic),
 * under the direction of Jacques Pouyaud.
 * https://github.com/jps-34/StarlinkSweeper
 *
 * v1.2.1: licence changed to GPL-3.0-or-later (1.2.0 and earlier: MIT).
 * v1.2.0: runs on the V8 engine of PixInsight; parallel scan on threads
 *   (PixInsight 1.9.5), Threads setting; the Python option is removed from the
 *   dialog (the command-line version stays as a separate tool).
 * v1.1.5: the machine probe works with no folder selected (the command line
 *   refused it, so Detect failed right after a Reset).
 * v1.1.4: Reset button (PixInsight style, bottom left) that forgets every
 *   remembered setting; the scanner status shows the path of the command-line
 *   script in use and warns when its version differs from the script's.
 * v1.1.3: the quarantine folder is created NEXT TO the scanned folder
 *   (<folder>_trails, same sub-folders inside) instead of inside it, so that a
 *   stacking program importing the scanned folder never sees the quarantined
 *   frames. Quarantine folders are skipped by the scan.
 * v1.1.2: installation hints for the Python modules per system (apt, pip or a
 *   virtual environment); wording only.
 * v1.1.1: the dialog no longer depends on capturing the scanner's standard
 *   output: Python version and machine probe go through files, scan progress
 *   through a progress file; the detection reports why each candidate failed.
 * v1.1.0: parallel scan through the command-line version (starlinksweeper.py,
 *   installed with this script) when Python 3 with numpy, scipy and astropy is
 *   available: "Parallel scan with Python" option, Workers slider bounded by
 *   what the machine allows, results streamed into the list, previews built on
 *   demand. Built-in single-core scan otherwise.
 * v1.0.7: the window can be made narrower (wrapping labels, shortened file
 *   names, smaller minimum sizes); "Verbose log" option removed.
 * v1.0.6: one adjustable level only, "Red above". Frames and lines are listed
 *   from a fixed score of 20 up; weaker candidates are no longer drawn.
 * v1.0.5: "Red above" level: frames at or above it are shown in red and can be
 *   quarantined in one go ("Quarantine red"); red count in the summary and a
 *   "red" column in the CSV. Threshold, red level, options and last folder are
 *   remembered between sessions.
 * v1.0.4: the line under the preview is reset when a new scan starts and shows
 *   live counts (scanned, listed, skipped) whenever no frame is
 *   selected; the details of a selected frame follow the list refreshes.
 * v1.0.3: 1.0.1 and 1.0.2 stopped with an error right after the first frame
 *   (list refresh); fixed. Frame type read from the file keywords before
 *   loading, window keywords as fallback. Stop takes effect within a second
 *   or two (checked between the stages of the analysis, not only between
 *   frames) and the button gives feedback. "Verbose log" option: one console
 *   line per stage of each frame.
 * v1.0.1: only light frames are analysed; flats, darks and bias are recognised
 *   from their IMAGETYP (or FRAME / FRAMETYP) header and skipped ("Lights only"
 *   option, on by default). Frames without the keyword are scanned.
 * v1.0.0: first release.
 * ----------------------------------------------------------------------------
 * Point it at the folder tree of your light frames: every FITS / XISF light
 * frame is scanned for straight trails (satellites, Starlink trains, aircraft);
 * flats, darks and bias found in the tree are skipped from their header. The
 * suspect frames are listed with a score and a preview showing the detected
 * trail, so you can check each one and quarantine it (moved to a <folder>_trails
 * folder next to the scanned folder, reversible) or erase it (permanent,
 * confirmed one by one).
 *
 * Algorithm (same as the Python command-line version, python/starlinksweeper.py):
 *   1. bin x8 (mean), subtract a large-scale background, normalise to robust
 *      sigma units, clip to [-3, +3] so stars weigh little;
 *   2. coarse line projection (Radon by accumulation) at bin 16, every 0.25
 *      deg; broad structures along rho (nebulae, gradients) are removed, thin
 *      peaks are kept;
 *   3. each candidate is refined at bin 8 with 0.05 deg steps;
 *   4. continuity test: the line is cut into 24 segments, a trail must be
 *      present in at least 6 consecutive segments; the score is
 *      sqrt(run) * median(segment significance). A short line through a
 *      saturated star is a diffraction spike and is rejected.
 */

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

var TITLE = "StarlinkSweeper";
var VERSION = "1.2.1";

// ---------------------------------------------------------------- parameters
// Keep these identical to starlinksweeper.py so both tools give the same scores.
var FINE_BIN     = 8;      // analysis binning
var COARSE_STEP  = 0.25;   // deg, coarse angular scan (at bin 16)
var FINE_STEP    = 0.05;   // deg, refinement step (at bin 8)
var FINE_HALF    = 0.6;    // deg, refinement half range
var N_SEG        = 24;     // segments along a line for the continuity test
var MIN_RUN      = 6;      // minimum consecutive significant segments
var SEG_MIN_SIG  = 1.5;    // sigma, a segment is significant above this
var SPIKE_MAX_RUN = 18;    // a line through a saturated star is a spike unless longer
var MAX_CAND     = 8;      // coarse candidates refined per frame
var FLOOR        = 4.0;    // internal detection floor (the listing level only filters)
var MARGIN       = 12;     // binned pixels ignored along the frame edges
var STAR_SUM     = 4000;   // 3x3 block sum (binned sigma) above which a star is "saturated"
var MAX_LINES    = 5;      // lines reported per frame
var LIST_THRESHOLD = 20.0;   // fixed: frames and lines are listed from this score up
var DEFAULT_ALERT = 60.0;    // adjustable: frames at or above this score are shown in red
var SETTINGS_KEY = "StarlinkSweeper";
var EXTENSIONS   = [".fit", ".fits", ".fts", ".xisf", ".FIT", ".FITS", ".FTS", ".XISF"];
var QUARANTINE_SUFFIX = "_trails";   // quarantine folder: <parent of the scanned folder>/<scanned folder name>_trails

// =============================================================== numeric core
// (no PixInsight object below this line: this section is also run under node
//  for validation against the Python version)

var abortRequested = null;   // set by the dialog to a function returning true to stop

function checkAbort() {
   // Lets the GUI breathe between heavy stages and stops the scan when asked.
   // In a scan thread (PixInsight 1.9.5): the abort request of the thread only,
   // since a thread has no user interface.
   if (typeof Thread != "undefined" && Thread.current) {
      if (Thread.current.isAborted) throw new Error("__abort__");
      return;
   }
   if (typeof CoreApplication != "undefined") CoreApplication.processEvents();
   if (abortRequested && abortRequested()) throw new Error("__abort__");
}

function kthSmallest(a, n, k) {
   // Quickselect in place on a[0..n-1]: returns the k-th smallest (0-based).
   var lo = 0, hi = n - 1;
   while (hi > lo) {
      var pivot = a[(lo + hi) >> 1], i = lo, j = hi;
      while (i <= j) {
         while (a[i] < pivot) i++;
         while (a[j] > pivot) j--;
         if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else break;
   }
   return a[k];
}

function medianOf(a, n) {
   var c = new Float64Array(n);
   for (var i = 0; i < n; ++i) c[i] = a[i];
   if (n & 1) return kthSmallest(c, n, n >> 1);
   var m1 = kthSmallest(c, n, (n >> 1) - 1);
   var m2 = c[n >> 1];                       // after the select, c[n/2..] >= m1
   for (var i2 = n >> 1; i2 < n; ++i2) if (c[i2] < m2) m2 = c[i2];
   return 0.5 * (m1 + m2);
}

function robustSigma(a, n) {
   // {med, sig}: median and 1.4826 * MAD, with fallbacks like the Python code
   var med = medianOf(a, n);
   var d = new Float64Array(n);
   for (var i = 0; i < n; ++i) d[i] = Math.abs(a[i] - med);
   var sig = 1.4826 * medianOf(d, n);
   if (!(sig > 0) || !isFinite(sig)) {
      var s = 0, s2 = 0;
      for (var j = 0; j < n; ++j) { s += a[j]; s2 += a[j] * a[j]; }
      sig = Math.sqrt(Math.max(s2 / n - (s / n) * (s / n), 0)) || 1.0;
   }
   return { med: med, sig: sig };
}

function binMean(src, w, h, b) {
   // Mean binning b x b; the remainder rows/columns are dropped (like numpy).
   var W = Math.floor(w / b), H = Math.floor(h / b);
   var out = new Float32Array(W * H), inv = 1.0 / (b * b);
   for (var Y = 0; Y < H; ++Y)
      for (var X = 0; X < W; ++X) {
         var s = 0;
         for (var dy = 0; dy < b; ++dy) {
            var row = (Y * b + dy) * w + X * b;
            for (var dx = 0; dx < b; ++dx) s += src[row + dx];
         }
         out[Y * W + X] = s * inv;
      }
   return { data: out, w: W, h: H };
}

function medianFilter(a, w, h, size) {
   // Square median filter with "nearest" edge handling.
   var r = size >> 1, out = new Float32Array(w * h), win = new Float64Array(size * size);
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x) {
         var n = 0;
         for (var dy = -r; dy <= r; ++dy) {
            var yy = Math.min(Math.max(y + dy, 0), h - 1);
            for (var dx = -r; dx <= r; ++dx) {
               var xx = Math.min(Math.max(x + dx, 0), w - 1);
               win[n++] = a[yy * w + xx];
            }
         }
         out[y * w + x] = kthSmallest(win, n, n >> 1);   // n is odd (size odd)
      }
   return out;
}

function background(s, w, h) {
   // Large-scale background: median on a 4x coarser grid, second pass with
   // bright pixels replaced, cell-centred bilinear upsampling.
   var coarse = 4, size = 15;
   var c = binMean(s, w, h, coarse);
   var bg = medianFilter(c.data, c.w, c.h, size);
   var n = c.w * c.h, res = new Float64Array(n);
   for (var i = 0; i < n; ++i) res[i] = c.data[i] - bg[i];
   var sig = robustSigma(res, n).sig;
   var c2 = new Float32Array(n);
   for (var k = 0; k < n; ++k) c2[k] = (c.data[k] - bg[k] > 2.0 * sig) ? bg[k] : c.data[k];
   bg = medianFilter(c2, c.w, c.h, size);
   var out = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      var v = (y + 0.5) / coarse - 0.5;
      v = Math.min(Math.max(v, 0), c.h - 1);
      var y0 = Math.floor(v), y1 = Math.min(y0 + 1, c.h - 1), fy = v - y0;
      for (var x = 0; x < w; ++x) {
         var u = (x + 0.5) / coarse - 0.5;
         u = Math.min(Math.max(u, 0), c.w - 1);
         var x0 = Math.floor(u), x1 = Math.min(x0 + 1, c.w - 1), fx = u - x0;
         out[y * w + x] = (1 - fy) * ((1 - fx) * bg[y0 * c.w + x0] + fx * bg[y0 * c.w + x1])
                        + fy * ((1 - fx) * bg[y1 * c.w + x0] + fx * bg[y1 * c.w + x1]);
      }
   }
   return out;
}

function normalise(s, w, h) {
   // Returns {z (clipped, sigma units), valid (Uint8Array), stars [[x,y],...]
   // centred coordinates, preview (Uint8Array, display stretch)}
   var n = w * h, bg = background(s, w, h), r = new Float64Array(n);
   for (var i = 0; i < n; ++i) r[i] = s[i] - bg[i];
   var rs = robustSigma(r, n);
   var zu = new Float32Array(n), z = new Float32Array(n), preview = new Uint8Array(n);
   for (var k = 0; k < n; ++k) {
      var v = (r[k] - rs.med) / rs.sig;
      zu[k] = v;
      z[k] = v < -3 ? -3 : (v > 3 ? 3 : v);
      var p = (z[k] + 2.0) / 5.0 * 255;
      preview[k] = p < 0 ? 0 : (p > 255 ? 255 : p);
   }
   var valid = new Uint8Array(n);
   for (var y = MARGIN; y < h - MARGIN; ++y)
      for (var x = MARGIN; x < w - MARGIN; ++x) valid[y * w + x] = 1;
   // saturated stars: 3x3 block sum above STAR_SUM and local maximum in 7x7
   var blk = new Float32Array(n);
   for (var yy = 1; yy < h - 1; ++yy)
      for (var xx = 1; xx < w - 1; ++xx) {
         var o = yy * w + xx;
         blk[o] = zu[o - w - 1] + zu[o - w] + zu[o - w + 1] + zu[o - 1] + zu[o] + zu[o + 1]
                + zu[o + w - 1] + zu[o + w] + zu[o + w + 1];
      }
   var stars = [];
   for (var sy = MARGIN; sy < h - MARGIN; ++sy)
      for (var sx = MARGIN; sx < w - MARGIN; ++sx) {
         var b = blk[sy * w + sx];
         if (b <= STAR_SUM) continue;
         var isMax = true;
         for (var dy = -3; dy <= 3 && isMax; ++dy)
            for (var dx = -3; dx <= 3; ++dx)
               if (blk[(sy + dy) * w + sx + dx] > b) { isMax = false; break; }
         if (isMax) stars.push([sx - w / 2.0, sy - h / 2.0]);
      }
   return { z: z, valid: valid, stars: stars, preview: preview };
}

function Projector(z, valid, w, h) {
   // Line sums of z along every direction (Radon transform by accumulation).
   // Line: x*cos(t) + y*sin(t) = rho, with x and y centred on the image.
   var n = 0;
   for (var i = 0; i < w * h; ++i) if (valid[i]) ++n;
   this.n = n;
   this.x = new Float32Array(n); this.y = new Float32Array(n); this.v = new Float32Array(n);
   var k = 0;
   for (var yy = 0; yy < h; ++yy)
      for (var xx = 0; xx < w; ++xx) {
         var o = yy * w + xx;
         if (!valid[o]) continue;
         this.x[k] = xx - w / 2.0; this.y[k] = yy - h / 2.0; this.v[k] = z[o]; ++k;
      }
   this.w = w; this.h = h;
   this.half = Math.ceil(Math.sqrt(w * w + h * h) / 2) + 1;
   this.nrho = 2 * this.half + 1;
   this.sigPix = robustSigma(this.v, n).sig;
}

Projector.prototype.project = function (thetas) {
   // R and N laid out as [j * nrho + i] (one contiguous block per angle)
   var nth = thetas.length, nrho = this.nrho, half = this.half, n = this.n;
   var R = new Float64Array(nth * nrho), N = new Int32Array(nth * nrho);
   var x = this.x, y = this.y, v = this.v;
   for (var j = 0; j < nth; ++j) {
      var t = thetas[j] * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), base = j * nrho;
      var off = half + 0.5;
      for (var i = 0; i < n; ++i) {
         var idx = base + ((x[i] * c + y[i] * s + off) | 0);
         R[idx] += v[i]; N[idx] += 1;
      }
   }
   return { R: R, N: N, nth: nth, nrho: nrho };
};

Projector.prototype.significance = function (thetas, minlen) {
   // Per-line significance map, broad structures removed along rho (30th
   // percentile over a 61-bin window), normalised by its own robust sigma.
   var P = this.project(thetas), nth = P.nth, nrho = P.nrho;
   var Z = new Float32Array(nth * nrho), ok = new Uint8Array(nth * nrho), nok = 0;
   for (var j = 0; j < nth; ++j)
      for (var i = 0; i < nrho; ++i) {
         var o = j * nrho + i;
         if (P.N[o] >= minlen) { Z[o] = P.R[o] / Math.sqrt(P.N[o]); ok[o] = 1; ++nok; }
      }
   var win = 61, r = 30, kth = 18, buf = new Float64Array(win);      // 0.30 * (61-1)
   var S = new Float32Array(nth * nrho), vals = new Float64Array(nok), m = 0;
   for (var jj = 0; jj < nth; ++jj) {
      var base = jj * nrho;
      for (var ii = 0; ii < nrho; ++ii) {
         for (var q = -r; q <= r; ++q) {
            var p = ii + q; p = p < 0 ? 0 : (p >= nrho ? nrho - 1 : p);
            buf[q + r] = Z[base + p];
         }
         S[base + ii] = Z[base + ii] - kthSmallest(buf, win, kth);
         if (ok[base + ii]) vals[m++] = S[base + ii];
      }
   }
   var sig = robustSigma(vals, nok).sig;
   for (var o2 = 0; o2 < nth * nrho; ++o2) S[o2] = ok[o2] ? S[o2] / sig : 0;
   return { S: S, nth: nth, nrho: nrho };
};

Projector.prototype.segments = function (thetaDeg, rho) {
   // Per-segment significance along one line (band |d| <= 1), each segment
   // measured against its own local baseline (parallel bands 3 <= |d| <= 8).
   var t = thetaDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
   var x = this.x, y = this.y, v = this.v, n = this.n;
   var umin = Infinity, umax = -Infinity, nb = 0, nw = 0;
   var d = new Float32Array(n), u = new Float32Array(n);
   for (var i = 0; i < n; ++i) {
      d[i] = x[i] * c + y[i] * s - rho;
      var ad = Math.abs(d[i]);
      if (ad <= 1.0 || (ad >= 3.0 && ad <= 8.0)) {
         u[i] = -x[i] * s + y[i] * c;
         if (u[i] < umin) umin = u[i];
         if (u[i] > umax) umax = u[i];
         if (ad <= 1.0) ++nb; else ++nw;
      }
   }
   var sig = new Float64Array(N_SEG), bn = new Int32Array(N_SEG);
   if (nb < 10 || nw < 10) return { sig: sig, n: bn, umin: 0, umax: 1 };
   var bsum = new Float64Array(N_SEG), wsum = new Float64Array(N_SEG), wn = new Int32Array(N_SEG);
   var scale = N_SEG / (umax - umin + 1e-6);
   for (var i2 = 0; i2 < n; ++i2) {
      var ad2 = Math.abs(d[i2]);
      if (ad2 > 8.0 || (ad2 > 1.0 && ad2 < 3.0)) continue;
      var k = ((u[i2] - umin) * scale) | 0;
      if (k >= N_SEG) k = N_SEG - 1;
      if (ad2 <= 1.0) { bsum[k] += v[i2]; bn[k]++; } else { wsum[k] += v[i2]; wn[k]++; }
   }
   for (var k2 = 0; k2 < N_SEG; ++k2) {
      if (bn[k2] <= 0) { sig[k2] = 0; continue; }
      var wmean = wsum[k2] / Math.max(wn[k2], 1);
      var excess = bsum[k2] - bn[k2] * wmean;
      var err = this.sigPix * Math.sqrt(Math.max(bn[k2], 1) * (1.0 + bn[k2] / Math.max(wn[k2], 1)));
      sig[k2] = excess / err;
   }
   return { sig: sig, n: bn, umin: umin, umax: umax };
};

function continuity(seg) {
   // Best run of consecutive significant segments -> {score, run, start}.
   // One isolated weak (but non-negative) segment inside a run is tolerated.
   // Score = sqrt(run) * MEDIAN of the segment significances over the run.
   var n = seg.length, best = { score: 0, run: 0, start: 0 }, i = 0;
   var good = function (k) { return seg[k] >= SEG_MIN_SIG; };
   while (i < n) {
      if (!good(i)) { ++i; continue; }
      var j = i;
      while (j + 1 < n && (good(j + 1) || (j + 2 < n && good(j + 2) && seg[j + 1] >= 0))) ++j;
      var run = j - i + 1;
      var sc = Math.sqrt(run) * medianOf(seg.subarray(i, j + 1), run);
      if (run >= MIN_RUN && sc > best.score) best = { score: sc, run: run, start: i };
      i = j + 1;
   }
   return best;
}

function onBrightStar(thetaDeg, rho, run, start, stars, umin, umax) {
   // True when a saturated star sits on the line inside the run: a short
   // bright line through a saturated star is a diffraction spike.
   if (stars.length == 0) return false;
   var t = thetaDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
   for (var i = 0; i < stars.length; ++i) {
      var d = stars[i][0] * c + stars[i][1] * s - rho;
      if (Math.abs(d) > 2.5) continue;
      var u = -stars[i][0] * s + stars[i][1] * c;
      var k = (u - umin) / (umax - umin + 1e-6) * N_SEG;
      if (k >= start - 1 && k <= start + run + 1) return true;
   }
   return false;
}

function endpoints(thetaDeg, rho, u0, u1, w, h, binning) {
   // Full-resolution endpoints of the detected run.
   var t = thetaDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
   var cx = w / 2.0, cy = h / 2.0;
   return { x0: Math.round((cx + rho * c - u0 * s) * binning), y0: Math.round((cy + rho * s + u0 * c) * binning),
            x1: Math.round((cx + rho * c - u1 * s) * binning), y1: Math.round((cy + rho * s + u1 * c) * binning) };
}

function analyseBinned(s8, w8, h8) {
   // s8: bin-8 mean image (Float32Array). Returns the analysis result.
   checkAbort();
   var norm = normalise(s8, w8, h8);
   checkAbort();
   var z8 = norm.z, v8 = norm.valid;
   // bin 16 of the clipped map, valid where all four pixels are valid
   var w16 = Math.floor(w8 / 2), h16 = Math.floor(h8 / 2);
   var z16 = binMean(z8, w8, h8, 2).data, v16 = new Uint8Array(w16 * h16);
   for (var Y = 0; Y < h16; ++Y)
      for (var X = 0; X < w16; ++X) {
         var o = 2 * Y * w8 + 2 * X;
         v16[Y * w16 + X] = (v8[o] && v8[o + 1] && v8[o + w8] && v8[o + w8 + 1]) ? 1 : 0;
      }
   // ---- coarse scan
   var P16 = new Projector(z16, v16, w16, h16);
   var nth = Math.round(180 / COARSE_STEP), thetas = new Float64Array(nth);
   for (var j = 0; j < nth; ++j) thetas[j] = j * COARSE_STEP;
   var S = P16.significance(thetas, 0.15 * Math.min(w16, h16));
   checkAbort();
   var coarseBest = 0, pool = [];
   for (var o2 = 0; o2 < S.S.length; ++o2) {
      if (S.S[o2] > coarseBest) coarseBest = S.S[o2];
      if (S.S[o2] >= FLOOR) pool.push(o2);
   }
   pool.sort(function (a, b) { return S.S[b] - S.S[a]; });
   var cand = [];
   for (var p = 0; p < pool.length && cand.length < MAX_CAND; ++p) {
      var jj = Math.floor(pool[p] / S.nrho), ii = pool[p] - jj * S.nrho, dup = false;
      for (var q = 0; q < cand.length; ++q) {
         var dj = Math.abs(jj - cand[q].j); dj = Math.min(dj, nth - dj);
         if (Math.abs(ii - cand[q].i) < 6 && dj < 6) { dup = true; break; }
      }
      if (!dup) cand.push({ i: ii, j: jj });
   }
   // ---- fine refinement + continuity test
   var P8 = new Projector(z8, v8, w8, h8), minlen8 = 0.15 * Math.min(w8, h8), lines = [];
   var nf = Math.round(2 * FINE_HALF / FINE_STEP) + 1;
   for (var ci = 0; ci < cand.length; ++ci) {
      checkAbort();
      var th = new Float64Array(nf);
      for (var f = 0; f < nf; ++f) {
         var a = thetas[cand[ci].j] - FINE_HALF + f * FINE_STEP;
         th[f] = ((a % 180) + 180) % 180;
      }
      var Sf = P8.significance(th, minlen8);
      var rhoC = 2 * (cand[ci].i - P16.half);
      var lo = Math.max(0, rhoC + P8.half - 14), hi = Math.min(Sf.nrho, rhoC + P8.half + 15);
      var sub = new Float32Array((hi - lo) * nf);
      for (var f2 = 0; f2 < nf; ++f2)
         for (var r = lo; r < hi; ++r) sub[f2 * (hi - lo) + (r - lo)] = Sf.S[f2 * Sf.nrho + r];
      for (var pass = 0; pass < 4; ++pass) {
         var best = -1, bi = 0;
         for (var k = 0; k < sub.length; ++k) if (sub[k] > best) { best = sub[k]; bi = k; }
         if (best < FLOOR) break;
         var fb = Math.floor(bi / (hi - lo)), ra = bi - fb * (hi - lo);
         var theta = th[fb], rho = lo + ra - P8.half;
         var seg = P8.segments(theta, rho);
         var ct = continuity(seg.sig);
         var spike = ct.run <= SPIKE_MAX_RUN && onBrightStar(theta, rho, ct.run, ct.start, norm.stars, seg.umin, seg.umax);
         var u0 = seg.umin + (seg.umax - seg.umin) * ct.start / N_SEG;
         var u1 = seg.umin + (seg.umax - seg.umin) * (ct.start + ct.run) / N_SEG;
         lines.push({ score: spike ? 0 : ct.score, peak: best, angle: theta, rho: rho, run: ct.run,
                      spike: spike, u0: u0, u1: u1 });
         for (var f3 = 0; f3 < nf; ++f3)
            for (var r2 = Math.max(0, ra - 2); r2 <= Math.min(hi - lo - 1, ra + 2); ++r2) sub[f3 * (hi - lo) + r2] = 0;
      }
   }
   lines.sort(function (a, b) { return b.score - a.score; });
   var kept = [];
   for (var L = 0; L < lines.length && kept.length < MAX_LINES; ++L) {
      var ln = lines[L];
      if (ln.score < FLOOR) break;
      var dupl = false;
      for (var K = 0; K < kept.length; ++K)
         if (Math.abs(ln.rho - kept[K].rho) < 4 && Math.abs(ln.angle - kept[K].angle) < 0.5) { dupl = true; break; }
      if (dupl) continue;
      var ep = endpoints(ln.angle, ln.rho, ln.u0, ln.u1, w8, h8, FINE_BIN);
      ln.x0 = ep.x0; ln.y0 = ep.y0; ln.x1 = ep.x1; ln.y1 = ep.y1;
      kept.push(ln);
   }
   var score = kept.length ? kept[0].score : (lines.length ? lines[0].score : 0);
   return { score: score, coarse: coarseBest, lines: kept, nStars: norm.stars.length,
            preview: norm.preview, pw: w8, ph: h8 };
}

// ============================================================ end of core

// ------------------------------------------------------------------ file I/O
var TYPE_KEYWORDS = ["IMAGETYP", "FRAME", "FRAMETYP"];

function frameType(value) {
   // Normalised frame type from an IMAGETYP-like keyword value:
   // "light", "flat", "dark", "bias", "other", or null when empty.
   var v = String(value).trim().replace(/^'+|'+$/g, "").trim().toLowerCase();
   if (!v.length) return null;
   if (v.indexOf("light") >= 0) return "light";
   if (v.indexOf("flat") >= 0) return "flat";
   if (v.indexOf("dark") >= 0) return "dark";
   if (v.indexOf("bias") >= 0 || v.indexOf("offset") >= 0) return "bias";
   return "other";
}

function frameTypeFromKeywords(keywords) {
   // keywords: Array of FITSKeyword (FileFormatInstance.keywords or
   // ImageWindow.keywords). null if absent.
   if (!keywords) return null;
   for (var k = 0; k < TYPE_KEYWORDS.length; ++k)
      for (var i = 0; i < keywords.length; ++i)
         if (keywords[i].name == TYPE_KEYWORDS[k]) {
            var t = frameType(keywords[i].value);
            if (t) return t;
         }
   return null;
}

var verboseLog = false;      // one console line per stage of each frame (maintenance aid)

function stage(msg) {
   if (verboseLog) { console.writeln("<end><cbr>    " + msg); console.flush(); }
}

function keywordsType(f, what) {
   // Frame type from the keywords of an open FileFormatInstance; null if unknown.
   var keywords = null;
   try { keywords = f.keywords; } catch (e) { stage(what + " unavailable: " + e.message); }
   var t = frameTypeFromKeywords(keywords);
   stage("frame type " + (t == null ? "unknown" : t) + " (" + what + ")");
   return t;
}

function readBinnedImage(filePath, lightsOnly) {
   // Reads the file without an image window (also usable in a scan thread)
   // and bins channel 0 x8 by averaging complete 8x8 blocks, band by band:
   // the same values, to the bit, as IntegerResample (Average). Returns
   // {data, w, h, W, H}. With lightsOnly, a frame whose header says flat /
   // dark / bias is not read: {skipped: type} is returned instead.
   var ext = File.extractExtension(filePath);
   stage("format " + ext);
   var F = new FileFormat(ext, true /*toRead*/, false /*toWrite*/);
   if (F.isNull) throw new Error("No installed file format can read " + ext + " files");
   var f = new FileFormatInstance(F);
   if (f.isNull) throw new Error("Unable to instantiate file format " + F.name);
   stage("open");
   var d = f.open(filePath, "raw cfa verbosity 0");
   if (d.length < 1) throw new Error("Unable to open file " + filePath);
   stage("opened " + d[0].width + "x" + d[0].height + "x" + d[0].numberOfChannels);
   var img = new Image;
   try {
      var type = null;
      if (lightsOnly) {
         type = keywordsType(f, "file keywords");
         if (type != null && type != "light") return { skipped: type };
      }
      checkAbort();
      stage("read image");
      if (!f.readImage(img)) throw new Error("Unable to read image " + filePath);
      if (lightsOnly && type == null) {          // some formats give their keywords once the image is read
         type = keywordsType(f, "keywords after reading");
         if (type != null && type != "light") return { skipped: type };
      }
      checkAbort();
      var W = img.width, H = img.height, w = Math.floor(W / FINE_BIN), h = Math.floor(H / FINE_BIN);
      stage("bin x" + FINE_BIN + " to " + w + "x" + h);
      var data = new Float32Array(w * h), band = new Float32Array(W * FINE_BIN);
      for (var y = 0; y < h; ++y) {
         img.getSamples(band, new Rect(0, y * FINE_BIN, W, (y + 1) * FINE_BIN), 0);
         data.set(binMean(band, W, FINE_BIN, FINE_BIN).data, y * w);
      }
      return { data: data, w: w, h: h, W: W, H: H };
   } finally {
      f.close();
      img.free();
   }
}

function analyseFile(filePath, lightsOnly) {
   var t0 = Date.now();
   var b = readBinnedImage(filePath, lightsOnly);
   if (b.skipped) return { file: filePath, skipped: b.skipped, score: -1, lines: [], status: "skipped", preview: null };
   stage("analyse");
   var res = analyseBinned(b.data, b.w, b.h);
   stage("done");
   res.file = filePath;
   res.width = b.W; res.height = b.H;
   res.seconds = (Date.now() - t0) / 1000;
   return res;
}

function normalizedDir(path) {
   path = String(path).replace(/\\/g, "/");
   while (path.length > 1 && path.charAt(path.length - 1) == "/") path = path.substring(0, path.length - 1);
   return path;
}

function inQuarantine(path) {
   // true when any folder on the path is a quarantine folder (name ending with _trails)
   var parts = normalizedDir(path).split("/");
   for (var i = 0; i < parts.length - 1; ++i)
      if (parts[i].length > QUARANTINE_SUFFIX.length - 1 && parts[i].substring(parts[i].length - QUARANTINE_SUFFIX.length) == QUARANTINE_SUFFIX)
         return true;
   return false;
}

function quarantineRoot(scanFolder) {
   // The quarantine lives NEXT TO the scanned folder, not inside it, so that a
   // stacking program importing the scanned folder recursively never sees it:
   // scanning /a/b/lights puts the frames under /a/b/lights_trails/<same sub-path>.
   var root = normalizedDir(scanFolder);
   var parent = File.extractDirectory(root), name = File.extractName(root) + File.extractExtension(root);
   if (!parent.length || parent == root) return (root == "/" ? "" : root) + "/" + QUARANTINE_SUFFIX;
   if (!name.length) name = "lights";
   return parent + "/" + name + QUARANTINE_SUFFIX;
}

function makeDirs(path) {
   // creates the folder and its missing parents
   path = normalizedDir(path);
   if (File.directoryExists(path)) return;
   var parent = File.extractDirectory(path);
   if (parent.length && parent != path && !File.directoryExists(parent)) makeDirs(parent);
   File.createDirectory(path);
}

function listFrames(dir, recursive) {
   var files = [];
   for (var i = 0; i < EXTENSIONS.length; ++i) {
      var found = File.searchDirectory(dir + "/*" + EXTENSIONS[i], recursive);
      for (var k = 0; k < found.length; ++k)
         if (!inQuarantine(found[k]) && files.indexOf(found[k]) < 0) files.push(found[k]);
   }
   files.sort();
   return files;
}

function moveFile(src, dst) {
   if (typeof File.move == "function") File.move(src, dst);
   else { File.copyFile(dst, src); File.remove(src); }   // copyFile(target, source)
}

function csvEscape(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function shortName(path, maxLength) {
   // File name shortened in the middle so that labels never force the window width.
   var n = File.extractNameAndExtension(path);
   if (n.length <= maxLength) return n;
   var keep = Math.floor((maxLength - 3) / 2);
   return n.substring(0, keep) + "..." + n.substring(n.length - keep);
}

// ------------------------------------------------------------ parallel scan
// PixInsight 1.9.5 runs JavaScript on Thread objects, each in a runtime of its
// own where nothing of this script exists: the source of a scan thread is
// built from the constants and functions listed in threadSource(), which must
// follow every function that analyseFile() calls. Same code, same scores as
// the scan in series.

function threadSource() {
   var c = { FINE_BIN: FINE_BIN, COARSE_STEP: COARSE_STEP, FINE_STEP: FINE_STEP, FINE_HALF: FINE_HALF,
             N_SEG: N_SEG, MIN_RUN: MIN_RUN, SEG_MIN_SIG: SEG_MIN_SIG, SPIKE_MAX_RUN: SPIKE_MAX_RUN,
             MAX_CAND: MAX_CAND, FLOOR: FLOOR, MARGIN: MARGIN, STAR_SUM: STAR_SUM, MAX_LINES: MAX_LINES,
             TYPE_KEYWORDS: TYPE_KEYWORDS };
   var src = [ "var verboseLog = false, abortRequested = null;" ];
   for (var k in c) src.push("var " + k + " = " + JSON.stringify(c[k]) + ";");
   var functions = [ checkAbort, kthSmallest, medianOf, robustSigma, binMean, medianFilter, background,
                     normalise, Projector, continuity, onBrightStar, endpoints, analyseBinned, frameType,
                     frameTypeFromKeywords, stage, keywordsType, readBinnedImage, analyseFile ];
   for (var i = 0; i < functions.length; ++i) src.push(functions[i].toString());
   var methods = [ "project", "significance", "segments" ];
   for (var m = 0; m < methods.length; ++m)
      src.push("Projector.prototype." + methods[m] + " = " + Projector.prototype[methods[m]].toString() + ";");
   src.push("(function (d) { return analyseFile(d.path, d.lightsOnly); })");
   return src.join("\n");
}

function scanThreads(files, setting) {
   // Number of scan threads: 1 (in series) without Thread objects (PixInsight
   // before 1.9.5) or for a single frame; otherwise the setting, and with 0
   // (automatic) as many as the processors allowed by the platform, the frames
   // and the available memory permit (a frame read in full plus working
   // buffers per thread, from the size of the first frame).
   if (typeof Thread == "undefined" || files.length < 2) return 1;
   var n = setting;
   if (!(n >= 1)) {
      n = Thread.numberOfProcessors;
      try {
         var mem = System.physicalMemoryStatus();
         var f = new FileFormatInstance(new FileFormat(File.extractExtension(files[0]), true, false));
         var d = f.open(files[0], "raw cfa verbosity 0");
         f.close();
         if (mem && mem.availableBytes > 0 && d && d.length > 0) {
            var per = 4 * d[0].width * d[0].height * (d[0].numberOfChannels + 1) + 268435456;
            n = Math.min(n, Math.floor(0.6 * mem.availableBytes / per));
         }
      } catch (e) { }
   }
   return Math.max(1, Math.min(Math.round(n), files.length));
}

function scanFiles(files, lightsOnly, threads, onResult, abort) {
   // Analyses every file, on `threads` scan threads, or in series with 1.
   // onResult(index, result) is called as each frame is done (in any order
   // with threads): the analysis result, {skipped}, or {file, error}.
   // abort() returns true to stop. Returns true when stopped.
   var stopped = false;
   if (threads <= 1) {
      abortRequested = abort;
      try {
         for (var k = 0; k < files.length; ++k) {
            if (abort()) { stopped = true; break; }
            try {
               onResult(k, analyseFile(files[k], lightsOnly));
            } catch (e) {
               if (e.message == "__abort__") { stopped = true; break; }
               onResult(k, { file: files[k], error: e.message });
            }
         }
      } finally {
         abortRequested = null;
      }
      return stopped;
   }
   var src = threadSource(), next = 0, running = [];
   try {
      while (next < files.length || running.length > 0) {
         while (running.length < threads && next < files.length) {
            var t = new Thread(src, { path: files[next], lightsOnly: lightsOnly });
            t.start();
            running.push({ thread: t, index: next++ });
         }
         CoreApplication.processEvents();
         if (abort()) { stopped = true; break; }
         var done = null;
         for (var i = 0; i < running.length && !done; ++i)
            if (!running[i].thread.isActive) done = running.splice(i, 1)[0];
         if (!done) { running[0].thread.wait(50); continue; }
         done.thread.wait();
         onResult(done.index, done.thread.error ? { file: files[done.index], error: done.thread.error }
                                                : done.thread.result);
      }
   } finally {
      // every thread joined, also on a stop or an error
      for (var a = 0; a < running.length; ++a) running[a].thread.abort();
      for (var j = 0; j < running.length; ++j) running[j].thread.wait();
   }
   return stopped;
}

function readSetting(key, type, fallback) {
   var v = Settings.read(SETTINGS_KEY + "/" + key, type);
   return Settings.lastReadOK ? v : fallback;
}

function writeSetting(key, type, value) {
   try { Settings.write(SETTINGS_KEY + "/" + key, type, value); } catch (e) { /* settings are a convenience */ }
}

// the last four belong to the Python option of 1.1.x: removed by Reset as well
var SETTING_KEYS = ["alert", "folder", "recursive", "lightsOnly", "threads", "external", "pythonPath", "cliPath", "workers"];

function removeSettings() {
   for (var i = 0; i < SETTING_KEYS.length; ++i)
      try { Settings.remove(SETTINGS_KEY + "/" + SETTING_KEYS[i]); } catch (e) { }
}

// ------------------------------------------------------------------- dialog
class SweeperDialog extends Dialog {
constructor() {
   super();
   var self = this;

   this.results = [];          // all analysed frames
   this.threshold = LIST_THRESHOLD;
   this.alert = readSetting("alert", DataType.Double, DEFAULT_ALERT);
   this.folder = readSetting("folder", DataType.String, "");
   if (this.folder.length && !File.directoryExists(this.folder)) this.folder = "";
   this.threads = readSetting("threads", DataType.Int32, 0);          // 0 = automatic
   this.stopRequested = false;
   this.scanning = false;
   this.bitmap = null;         // preview of the current frame
   this.bitmapIndex = -1;

   this.windowTitle = TITLE + " " + VERSION;
   this.userResizable = true;

   // ---- folder
   this.folderLabel = new Label(this);
   this.folderLabel.text = "Lights folder:";
   this.folderLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   this.folderEdit = new Edit(this);
   this.folderEdit.readOnly = true;
   this.folderEdit.text = this.folder;
   this.folderEdit.toolTip = "Root folder of the light frames to scan (FITS / XISF).";
   this.folderEdit.setMinWidth(this.logicalPixelsToPhysical(200));
   this.folderButton = new ToolButton(this);
   this.folderButton.icon = this.scaledResource(":/icons/select-file.png");
   this.folderButton.setScaledFixedSize(20, 20);
   this.folderButton.toolTip = "Choose the folder";
   this.folderButton.onClick = function () {
      var gdd = new GetDirectoryDialog;
      gdd.caption = "StarlinkSweeper: select the lights folder";
      if (self.folder.length) gdd.initialPath = self.folder;
      if (gdd.execute()) { self.folder = gdd.directory; self.folderEdit.text = self.folder; }
   };
   this.recursiveCheck = new CheckBox(this);
   this.recursiveCheck.text = "Include sub-folders";
   this.recursiveCheck.toolTip = "<p>Scan the sub-folders too. Quarantine folders (names ending with " + QUARANTINE_SUFFIX + ") are skipped.</p>";
   this.recursiveCheck.checked = readSetting("recursive", DataType.Boolean, true);
   this.lightsOnlyCheck = new CheckBox(this);
   this.lightsOnlyCheck.text = "Lights only";
   this.lightsOnlyCheck.checked = readSetting("lightsOnly", DataType.Boolean, true);
   this.lightsOnlyCheck.toolTip = "<p>Skip the frames whose header (IMAGETYP, FRAME or FRAMETYP) says flat, dark "
      + "or bias, so a whole night's folder can be scanned. Frames without the keyword are scanned.</p>";

   var folderSizer = new HorizontalSizer;
   folderSizer.spacing = 4;
   folderSizer.add(this.folderLabel);
   folderSizer.add(this.folderEdit, 100);
   folderSizer.add(this.folderButton);
   folderSizer.addSpacing(8);
   folderSizer.add(this.recursiveCheck);
   folderSizer.addSpacing(8);
   folderSizer.add(this.lightsOnlyCheck);

   // ---- red level + scan
   this.alertControl = new NumericControl(this);
   this.alertControl.label.text = "Red above:";
   this.alertControl.setRange(4, 300);
   this.alertControl.slider.setRange(0, 592);
   this.alertControl.setPrecision(1);
   this.alertControl.setValue(this.alert);
   this.alertControl.toolTip = "<p>Frames whose best trail scores at or above this value are shown in red: "
      + "trails that strong are never a false alarm, so they can be quarantined in one go with "
      + "<b>Quarantine red</b>.</p><p>Frames are listed from a score of " + format("%.0f", LIST_THRESHOLD)
      + " up; those between that level and this value deserve a look at the preview. "
      + "Changing the value re-colours the list without re-scanning.</p>";
   this.alertControl.onValueUpdated = function (v) { self.alert = v; self.rebuildList(); };

   this.scanButton = new PushButton(this);
   this.scanButton.text = "Scan";
   this.scanButton.onClick = function () { self.scan(); };
   this.stopButton = new PushButton(this);
   this.stopButton.text = "Stop";
   this.stopButton.enabled = false;
   this.stopButton.onClick = function () {
      self.stopRequested = true;
      self.stopButton.enabled = false;
      self.progressLabel.text = "Stopping...";
   };

   var scanSizer = new HorizontalSizer;
   scanSizer.spacing = 6;
   scanSizer.add(this.alertControl, 100);
   scanSizer.addSpacing(8);
   scanSizer.add(this.scanButton);
   scanSizer.add(this.stopButton);

   // ---- scanner: frames analysed in parallel on threads (PixInsight 1.9.5)
   this.threadsLabel = new Label(this);
   this.threadsLabel.text = "Threads:";
   this.threadsLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
   this.threadsSpin = new SpinBox(this);
   this.threadsSpin.setRange(0, 256);
   this.threadsSpin.minimumValueText = "Auto";
   this.threadsSpin.value = this.threads;
   this.threadsSpin.toolTip = "<p>Frames analysed at the same time, one per thread. <b>Auto</b> (default): as many as "
      + "the processors allowed in the PixInsight preferences, fewer when the available memory is short (each "
      + "thread holds one frame). <b>1</b>: one frame at a time. The scores are the same either way.</p>"
      + "<p>Needs PixInsight 1.9.5; with earlier versions the scan runs one frame at a time.</p>";
   this.threadsSpin.onValueUpdated = function (v) { self.threads = v; self.updateScannerUi(); };
   this.scannerStatus = new Label(this);
   this.scannerStatus.text = " ";
   this.scannerStatus.wordWrapping = true;
   this.scannerStatus.useRichText = true;

   var threadsRow = new HorizontalSizer;
   threadsRow.spacing = 6;
   threadsRow.add(this.threadsLabel);
   threadsRow.add(this.threadsSpin);
   threadsRow.addSpacing(8);
   threadsRow.add(this.scannerStatus, 100);
   this.scannerBox = new GroupBox(this);
   this.scannerBox.title = "Scanner";
   this.scannerBox.sizer = new VerticalSizer;
   this.scannerBox.sizer.margin = 6;
   this.scannerBox.sizer.add(threadsRow);

   this.progressLabel = new Label(this);
   this.progressLabel.text = "Select a folder and press Scan.";
   this.progressLabel.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   this.progressLabel.wordWrapping = true;

   // ---- results list
   this.tree = new TreeBox(this);
   this.tree.numberOfColumns = 6;
   this.tree.setHeaderText(0, "Score");
   this.tree.setHeaderText(1, "Lines");
   this.tree.setHeaderText(2, "Angle");
   this.tree.setHeaderText(3, "Length");
   this.tree.setHeaderText(4, "Status");
   this.tree.setHeaderText(5, "File");
   this.tree.rootDecoration = false;
   this.tree.alternateRowColor = true;
   this.tree.multipleSelection = false;
   this.tree.setMinSize(this.logicalPixelsToPhysical(420), this.logicalPixelsToPhysical(200));
   this.tree.toolTip = "<p>Frames whose best trail scores " + format("%.0f", LIST_THRESHOLD) + " or more, strongest first; "
      + "in red from the <i>Red above</i> level. Click a frame to see the detected trail on the preview.</p>";
   this.tree.onCurrentNodeUpdated = function (node) { self.showPreview(node ? node.resultIndex : -1); };
   this.tree.onNodeDoubleClicked = function (node) { self.openInPixInsight(node.resultIndex); };

   // ---- actions
   this.quarantineButton = new PushButton(this);
   this.quarantineButton.text = "Quarantine";
   this.quarantineButton.toolTip = "<p>Move the selected frame out of the scanned folder, into a <b>&lt;folder&gt;"
      + QUARANTINE_SUFFIX + "</b> folder created next to it (same sub-folders inside), so that a stacking program "
      + "importing the scanned folder never sees it again. Reversible: move it back by hand if needed.</p>";
   this.quarantineButton.onClick = function () { self.actOnCurrent("quarantine"); };
   this.quarantineAllButton = new PushButton(this);
   this.quarantineAllButton.text = "Quarantine all listed";
   this.quarantineAllButton.toolTip = "<p>Move every listed frame (score " + format("%.0f", LIST_THRESHOLD)
      + " or more) to the quarantine folder next to the scanned folder.</p>";
   this.quarantineAllButton.onClick = function () { self.quarantineAll(false); };
   this.quarantineRedButton = new PushButton(this);
   this.quarantineRedButton.text = "Quarantine red";
   this.quarantineRedButton.toolTip = "<p>Move every frame shown in red (score at or above the <i>Red above</i> value) "
      + "to the quarantine folder next to the scanned folder.</p>";
   this.quarantineRedButton.onClick = function () { self.quarantineAll(true); };
   this.eraseButton = new PushButton(this);
   this.eraseButton.text = "Erase";
   this.eraseButton.icon = this.scaledResource(":/icons/delete.png");
   this.eraseButton.toolTip = "<p><b>Permanently delete</b> the selected frame. A confirmation is asked every time.</p>";
   this.eraseButton.onClick = function () { self.actOnCurrent("erase"); };
   this.openButton = new PushButton(this);
   this.openButton.text = "Open";
   this.openButton.toolTip = "<p>Open the selected frame in PixInsight at full resolution (double-click does the same).</p>";
   this.openButton.onClick = function () { var n = self.tree.currentNode; if (n) self.openInPixInsight(n.resultIndex); };
   this.csvButton = new PushButton(this);
   this.csvButton.text = "Export CSV";
   this.csvButton.toolTip = "<p>Write a CSV report with the score of every scanned frame.</p>";
   this.csvButton.onClick = function () { self.exportCSV(); };
   this.closeButton = new PushButton(this);
   this.closeButton.text = "Close";
   this.closeButton.onClick = function () { self.saveSettings(); self.ok(); };
   this.resetButton = new ToolButton(this);
   this.resetButton.icon = this.scaledResource(":/process-interface/reset.png");
   this.resetButton.setScaledFixedSize(24, 24);
   this.resetButton.toolTip = "<p>Reset: put every setting back to its default and forget the remembered ones "
      + "(red level, options, threads, last folder). The results of the current scan are kept.</p>";
   this.resetButton.onClick = function () { self.resetSettings(); };

   var actionSizer = new HorizontalSizer;
   actionSizer.spacing = 6;
   actionSizer.add(this.resetButton);
   actionSizer.addSpacing(4);
   actionSizer.add(this.quarantineButton);
   actionSizer.add(this.quarantineAllButton);
   actionSizer.add(this.quarantineRedButton);
   actionSizer.add(this.eraseButton);
   actionSizer.add(this.openButton);
   actionSizer.addStretch();
   actionSizer.add(this.csvButton);
   actionSizer.add(this.closeButton);

   // ---- preview
   this.preview = new Control(this);
   this.preview.setMinSize(this.logicalPixelsToPhysical(480), this.logicalPixelsToPhysical(320));
   this.preview.toolTip = "<p>Binned, background-subtracted and stretched view of the selected frame. "
      + "The detected trails are drawn in red over their detected extent.</p>";
   this.preview.onPaint = function () {
      var g = new Graphics(this);
      g.fillRect(this.boundsRect, new Brush(0xFF1E1E1E));
      if (self.bitmap) {
         var bw = self.bitmap.width, bh = self.bitmap.height;
         var sc = Math.min(this.width / bw, this.height / bh);
         var dw = Math.floor(bw * sc), dh = Math.floor(bh * sc);
         var x0 = Math.floor((this.width - dw) / 2), y0 = Math.floor((this.height - dh) / 2);
         g.drawScaledBitmap(new Rect(x0, y0, x0 + dw, y0 + dh), self.bitmap);
      } else {
         g.pen = new Pen(0xFF9A9A9A);
         g.drawTextRect(this.boundsRect, "Select a frame in the list to see the detected trail",
                        TextAlignment.Center | TextAlignment.VertCenter);
      }
      g.end();
   };
   this.previewInfo = new Label(this);
   this.previewInfo.text = "No scan yet.";
   this.previewInfo.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
   this.previewInfo.useRichText = true;
   this.previewInfo.wordWrapping = true;

   // ---- layout
   var leftSizer = new VerticalSizer;
   leftSizer.spacing = 6;
   leftSizer.add(folderSizer);
   leftSizer.add(scanSizer);
   leftSizer.add(this.scannerBox);
   leftSizer.add(this.progressLabel);
   leftSizer.add(this.tree, 100);
   leftSizer.add(actionSizer);

   var rightSizer = new VerticalSizer;
   rightSizer.spacing = 6;
   rightSizer.add(this.preview, 100);
   rightSizer.add(this.previewInfo);

   this.sizer = new HorizontalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 10;
   this.sizer.add(leftSizer, 45);
   this.sizer.add(rightSizer, 55);
   this.adjustToContents();
   this.updateScannerUi();
}
updateScannerUi() {
   if (typeof Thread == "undefined") {
      this.threadsSpin.enabled = false;
      this.scannerStatus.text = "PixInsight before 1.9.5: one frame at a time.";
      return;
   }
   this.scannerStatus.text = this.threads == 1 ? "One frame at a time."
      : this.threads > 1 ? format("Up to %d frames at a time.", this.threads)
      : format("Up to %d frames at a time (processors allowed), fewer when memory is short.", Thread.numberOfProcessors);
}

scan() {
   var self = this;
   if (this.scanning) return;
   if (!this.folder.length || !File.directoryExists(this.folder)) {
      new MessageBox("Please select the folder of your light frames first.", TITLE, StdIcon.Warning, StdButton.Ok).execute();
      return;
   }
   writeSetting("folder", DataType.String, this.folder);
   var files = listFrames(this.folder, this.recursiveCheck.checked);
   if (files.length == 0) {
      new MessageBox("No FITS / XISF file found in\n" + this.folder, TITLE, StdIcon.Warning, StdButton.Ok).execute();
      return;
   }
   this.results = [];
   this.tree.clear();
   this.scanning = true; this.stopRequested = false;
   this.setBitmap(null, -1);
   this.previewInfo.text = this.summaryText();
   this.scanButton.enabled = false; this.stopButton.enabled = true;
   console.show();
   console.abortEnabled = true;
   var threads = scanThreads(files, this.threads);
   console.writeln("<end><cbr><b>" + TITLE + " " + VERSION + "</b>: " + files.length + " frames in " + this.folder
                   + (threads > 1 ? ", " + threads + " at a time" : ""));
   var t0 = Date.now(), flagged = 0, skipped = 0, scanned = 0, done = 0, lightsOnly = this.lightsOnlyCheck.checked;
   this.progressLabel.text = format("Scanning %d frames...", files.length);
   var stopped = scanFiles(files, lightsOnly, threads, function (k, res) {
      ++done;
      var name = File.extractNameAndExtension(files[k]);
      if (res.error) {
         console.criticalln(format("[%d/%d] %s: %s", done, files.length, files[k], res.error));
         self.results.push({ file: files[k], score: -1, lines: [], error: res.error, status: "error", preview: null });
      } else if (res.skipped) {
         ++skipped;
         self.results.push(res);
         console.writeln(format("[%d/%d] %s  skipped (%s)", done, files.length, name, res.skipped.toUpperCase()));
      } else {
         res.status = "";
         self.results.push(res);
         ++scanned;
         var tag = res.score >= self.threshold ? format("TRAIL x%d", self.shownLines(res).length) : "ok";
         if (res.score >= self.threshold) ++flagged;
         console.writeln(format("[%d/%d] %s  score %.1f  %.1fs  %s", done, files.length, name, res.score, res.seconds, tag));
      }
      self.progressLabel.text = format("Scanning %d / %d  (%d listed, %d skipped)  %s", done, files.length,
                                       flagged, skipped, shortName(files[k], 48));
      self.rebuildList();
      CoreApplication.processEvents();
   }, function () { return self.stopRequested || console.abortRequested; });
   if (stopped) console.warningln("Scan stopped by user after " + this.results.length + " of " + files.length + " frames");
   // results arrive in any order with threads: back to the order of the files
   var current = this.tree.currentNode ? this.results[this.tree.currentNode.resultIndex].file : null;
   this.results.sort(function (a, b) { return a.file < b.file ? -1 : (a.file > b.file ? 1 : 0); });
   this.tree.clear();
   this.rebuildList();
   for (var n = 0; current && n < this.tree.numberOfChildren; ++n)
      if (this.results[this.tree.child(n).resultIndex].file == current) { this.tree.currentNode = this.tree.child(n); break; }
   this.scanning = false;
   this.scanButton.enabled = true; this.stopButton.enabled = false;
   var cur = this.tree.currentNode;
   this.showPreview(cur ? cur.resultIndex : -1);
   this.progressLabel.text = format("%s%d frames scanned in %.0f s, %d listed (score %.0f or more), %d skipped as non-light.",
                                    stopped ? "Stopped. " : "", scanned, (Date.now() - t0) / 1000, flagged,
                                    this.threshold, skipped);
   console.writeln(this.progressLabel.text);
}

saveSettings() {
   writeSetting("alert", DataType.Double, this.alert);
   writeSetting("recursive", DataType.Boolean, this.recursiveCheck.checked);
   writeSetting("lightsOnly", DataType.Boolean, this.lightsOnlyCheck.checked);
   writeSetting("threads", DataType.Int32, this.threads);
   if (this.folder.length) writeSetting("folder", DataType.String, this.folder);
}

resetSettings() {
   removeSettings();
   this.alert = DEFAULT_ALERT;
   this.alertControl.setValue(this.alert);
   this.recursiveCheck.checked = true;
   this.lightsOnlyCheck.checked = true;
   this.threads = 0;
   this.threadsSpin.value = 0;
   this.updateScannerUi();
   this.rebuildList();
   console.writeln(TITLE + ": settings reset to defaults.");
}

rebuildList() {
   var current = this.tree.currentNode ? this.tree.currentNode.resultIndex : -1;
   this.tree.clear();
   var order = [];
   for (var i = 0; i < this.results.length; ++i) {
      var r0 = this.results[i];
      if (r0.status == "skipped") continue;
      if (r0.score >= this.threshold || r0.status == "error") order.push(i);
   }
   var self = this;
   order.sort(function (a, b) { return self.results[b].score - self.results[a].score; });
   var again = null;
   for (var k = 0; k < order.length; ++k) {
      var r = this.results[order[k]], node = new TreeBoxNode(this.tree);
      node.resultIndex = order[k];
      if (r.status == "error") {
         node.setText(0, "error"); node.setText(4, "error"); node.setText(5, File.extractNameAndExtension(r.file));
         node.setToolTip(5, r.error);
         continue;
      }
      var shown = this.shownLines(r), L = shown.length ? shown[0] : null;
      node.setText(0, format("%.1f", r.score));
      node.setText(1, String(shown.length));
      node.setText(2, L ? format("%.1f°", L.angle) : "");
      node.setText(3, L ? format("%d%%", Math.round(100 * L.run / N_SEG)) : "");
      node.setText(4, r.status);
      node.setText(5, File.extractNameAndExtension(r.file));
      node.setToolTip(5, r.file);
      for (var c = 0; c < 4; ++c) node.setAlignment(c, TextAlignment.Right);
      if (r.score >= this.alert) {
         for (var c3 = 0; c3 < 6; ++c3) {
            try { node.setTextColor(c3, 0xFFD02020); } catch (e) { }
         }
         if (!r.status.length) node.setToolTip(0, format("Score %.1f: at or above the red level %.1f", r.score, this.alert));
      }
      if (order[k] == current) again = node;
   }
   for (var c2 = 0; c2 < 6; ++c2) this.tree.adjustColumnWidthToContents(c2);
   if (again) { this.tree.currentNode = again; this.showPreview(again.resultIndex); }
   else this.showPreview(-1);
}

buildBitmap(r) {
   var w = r.pw, h = r.ph, bmp = new Bitmap(w, h), p = r.preview;
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x) {
         var v = p[y * w + x];
         bmp.setPixel(x, y, 0xFF000000 | (v << 16) | (v << 8) | v);
      }
   var g = new Graphics(bmp);
   g.antialiasing = true;
   g.pen = new Pen(0xFFFF4040, 2);
   var shown = this.shownLines(r);
   for (var i = 0; i < shown.length; ++i) {
      var L = shown[i];
      g.drawLine(L.x0 / FINE_BIN, L.y0 / FINE_BIN, L.x1 / FINE_BIN, L.y1 / FINE_BIN);
   }
   g.end();
   return bmp;
}

setBitmap(bmp, index) {
   this.bitmap = bmp; this.bitmapIndex = index; this.bitmapThreshold = this.threshold;
   this.preview.update();
}

shownLines(r) {
   // Lines are kept down to the internal floor; only those at or above the
   // listing level are shown.
   var out = [];
   for (var i = 0; i < r.lines.length; ++i) if (r.lines[i].score >= this.threshold) out.push(r.lines[i]);
   return out;
}

summaryText() {
   // What the info line shows when no frame is selected: live counts.
   var scanned = 0, above = 0, red = 0, skipped = 0, errors = 0, done = 0;
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "skipped") { ++skipped; continue; }
      if (r.status == "error") { ++errors; continue; }
      ++scanned;
      if (r.score >= this.threshold) ++above;
      if (r.score >= this.alert) ++red;
      if (r.status == "quarantined" || r.status == "erased") ++done;
   }
   if (!this.results.length) return this.scanning ? "Scanning..." : "No scan yet.";
   var t = format("%d frame%s scanned, <b>%d listed</b> (score %.0f or more)", scanned, scanned > 1 ? "s" : "", above, this.threshold);
   if (red) t += format(", <font color=\"#d02020\"><b>%d at or above %.1f</b></font>", red, this.alert);
   if (skipped) t += format(", %d skipped as non-light", skipped);
   if (errors) t += format(", %d in error", errors);
   if (done) t += format(", %d quarantined or erased", done);
   t += this.scanning ? " (scan in progress)" : ". Select a frame to see its trails.";
   return t;
}

showPreview(index) {
   if (index < 0 || index >= this.results.length || !this.results[index].preview) {
      this.setBitmap(null, -1); this.previewInfo.text = this.summaryText(); return;
   }
   var r = this.results[index];
   if (this.bitmapIndex != index || this.bitmapThreshold != this.threshold) this.setBitmap(this.buildBitmap(r), index);
   var info = "<b>" + File.extractNameAndExtension(r.file) + "</b> &nbsp; score " + format("%.1f", r.score)
      + (r.score >= this.alert ? format(" <font color=\"#d02020\"><b>(at or above the red level %.1f)</b></font>", this.alert) : "")
      + " &nbsp; " + r.width + "x" + r.height;
   var shown = this.shownLines(r);
   for (var i = 0; i < shown.length; ++i) {
      var L = shown[i];
      info += format("<br>line %d: score %.1f, angle %.2f°, %d%% of the frame, from (%d, %d) to (%d, %d)",
                     i + 1, L.score, L.angle, Math.round(100 * L.run / N_SEG), L.x0, L.y0, L.x1, L.y1);
   }
   if (r.status.length) info += "<br><i>" + r.status + "</i>";
   this.previewInfo.text = info;
}

actOnCurrent(action) {
   var node = this.tree.currentNode;
   if (!node) return;
   var r = this.results[node.resultIndex];
   if (r.status == "quarantined" || r.status == "erased") {
      new MessageBox("This frame has already been " + r.status + ".", TITLE, StdIcon.Information, StdButton.Ok).execute();
      return;
   }
   if (!File.exists(r.file)) {
      new MessageBox("File not found:\n" + r.file, TITLE, StdIcon.Error, StdButton.Ok).execute();
      return;
   }
   if (action == "erase") {
      var answer = new MessageBox("Permanently delete this frame?\n\n" + r.file + "\n\nThis cannot be undone.",
                                  TITLE, StdIcon.Warning, StdButton.Yes, StdButton.No).execute();
      if (answer != StdButton.Yes) return;
      File.remove(r.file);
      r.status = "erased";
      console.writeln("Erased " + r.file);
   } else {
      this.quarantine(r);
   }
   this.rebuildList();
   this.showPreview(node.resultIndex);
}

quarantine(r) {
   // Moves the frame to <quarantine root>/<its sub-path under the scanned folder>,
   // the quarantine root being next to the scanned folder (see quarantineRoot).
   var root = normalizedDir(this.folder), qroot = quarantineRoot(root);
   var file = normalizedDir(r.file);
   var rel = (file.indexOf(root + "/") == 0) ? file.substring(root.length) : "/" + File.extractNameAndExtension(file);
   var dst = qroot + rel;
   makeDirs(File.extractDirectory(dst));
   if (File.exists(dst)) throw new Error("Already exists: " + dst);
   moveFile(r.file, dst);
   r.status = "quarantined";
   r.movedTo = dst;
   console.writeln("Moved " + r.file + " -> " + dst);
}

quarantineAll(redOnly) {
   var todo = [], level = redOnly ? Math.max(this.alert, this.threshold) : this.threshold;
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "" && r.score >= level && File.exists(r.file)) todo.push(r);
   }
   if (!todo.length) return;
   var answer = new MessageBox(format("Move %d %sframe(s) to\n%s ?", todo.length,
                                      redOnly ? "red " : "", quarantineRoot(this.folder)),
                               TITLE, StdIcon.Question, StdButton.Yes, StdButton.No).execute();
   if (answer != StdButton.Yes) return;
   for (var k = 0; k < todo.length; ++k) {
      try { this.quarantine(todo[k]); }
      catch (e) { console.criticalln(e.message); }
   }
   this.rebuildList();
}

openInPixInsight(index) {
   if (index < 0 || index >= this.results.length) return;
   var r = this.results[index], path = r.movedTo || r.file;
   if (!File.exists(path)) {
      new MessageBox("File not found:\n" + path, TITLE, StdIcon.Error, StdButton.Ok).execute();
      return;
   }
   var windows = ImageWindow.open(path);
   if (windows.length) { windows[0].show(); windows[0].zoomToFit(); }
}

exportCSV() {
   if (!this.results.length) return;
   var sfd = new SaveFileDialog;
   sfd.caption = "StarlinkSweeper: save CSV report";
   sfd.filters = [["CSV files", "*.csv"]];
   sfd.initialPath = this.folder + "/StarlinkSweeper_report.csv";
   if (!sfd.execute()) return;
   var text = "file,flagged,red,score,coarse_peak,n_lines,status,lines(score@angle:x0,y0-x1,y1),error\n";
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "error") { text += csvEscape(r.file) + ",,,,,,error,," + csvEscape(r.error) + "\n"; continue; }
      if (r.status == "skipped") { text += csvEscape(r.file) + ",,,,,,skipped: " + r.skipped + ",,\n"; continue; }
      var desc = [], shown = this.shownLines(r);
      for (var k = 0; k < shown.length; ++k) {
         var L = shown[k];
         desc.push(format("%.1f@%.2f:%d,%d-%d,%d", L.score, L.angle, L.x0, L.y0, L.x1, L.y1));
      }
      text += csvEscape(r.file) + "," + (r.score >= this.threshold ? 1 : 0) + "," + (r.score >= this.alert ? 1 : 0) + ","
            + format("%.1f", r.score) + ","
            + format("%.1f", r.coarse) + "," + shown.length + "," + r.status + "," + csvEscape(desc.join(" | ")) + ",\n";
   }
   File.writeTextFile(sfd.fileName, text);
   console.writeln("Report written to " + sfd.fileName);
}

}

// --------------------------------------------------------------------- main
function main() {
   console.hide();
   var dialog = new SweeperDialog();
   dialog.execute();
}

if (typeof STARLINKSWEEPER_NO_MAIN === "undefined")
   main();
