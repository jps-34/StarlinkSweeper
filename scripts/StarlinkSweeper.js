#feature-id    StarlinkSweeper : Utilities > StarlinkSweeper
#feature-info  Finds subframes crossed by satellite or aircraft trails, shows \
   each detection on a preview, and lets you quarantine or erase the affected \
   frames one by one. Nothing is deleted without confirmation.

/*
 * StarlinkSweeper.js  v1.0.1
 * Copyright (c) 2026 Jacques Pouyaud. MIT License (see LICENSE).
 * Code written by Claude (Anthropic),
 * under the direction of Jacques Pouyaud.
 * https://github.com/jps-34/StarlinkSweeper
 *
 * v1.0.1: only light frames are analysed; flats, darks and bias are recognised
 *   from their IMAGETYP (or FRAME / FRAMETYP) header and skipped ("Lights only"
 *   option, on by default). Frames without the keyword are scanned.
 * v1.0.0: first release.
 * ----------------------------------------------------------------------------
 * Point it at the folder tree of your light frames: every FITS / XISF light
 * frame is scanned for straight trails (satellites, Starlink trains, aircraft);
 * flats, darks and bias found in the tree are skipped from their header. The
 * suspect frames are listed with a score and a preview showing the detected
 * trail, so you can check each one and quarantine it (moved to a _trails
 * sub-folder, reversible) or erase it (permanent, confirmed one by one).
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

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/ColorSpace.jsh>

var TITLE = "StarlinkSweeper";
var VERSION = "1.0.1";

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
var FLOOR        = 4.0;    // internal detection floor (the user threshold only filters)
var MARGIN       = 12;     // binned pixels ignored along the frame edges
var STAR_SUM     = 4000;   // 3x3 block sum (binned sigma) above which a star is "saturated"
var MAX_LINES    = 5;      // lines reported per frame
var DEFAULT_THRESHOLD = 10.0;
var EXTENSIONS   = [".fit", ".fits", ".fts", ".xisf", ".FIT", ".FITS", ".FTS", ".XISF"];
var QUARANTINE_DIR = "_trails";

// =============================================================== numeric core
// (no PixInsight object below this line: this section is also run under node
//  for validation against the Python version)

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
   var norm = normalise(s8, w8, h8);
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
   // keywords: Array of FITSKeyword (FileFormatInstance.keywords). null if absent.
   if (!keywords) return null;
   for (var k = 0; k < TYPE_KEYWORDS.length; ++k)
      for (var i = 0; i < keywords.length; ++i)
         if (keywords[i].name == TYPE_KEYWORDS[k]) {
            var t = frameType(keywords[i].value);
            if (t) return t;
         }
   return null;
}

function readBinnedImage(filePath, lightsOnly) {
   // Opens the file in a hidden image window, bins it x8 (average) with
   // IntegerResample and returns {data, w, h, W, H}. Channel 0 only.
   // With lightsOnly, a frame whose header says flat / dark / bias is not
   // read: {skipped: type} is returned instead.
   var ext = File.extractExtension(filePath);
   var F = new FileFormat(ext, true /*toRead*/, false /*toWrite*/);
   if (F.isNull) throw new Error("No installed file format can read " + ext + " files");
   var f = new FileFormatInstance(F);
   if (f.isNull) throw new Error("Unable to instantiate file format " + F.name);
   var d = f.open(filePath, "raw cfa verbosity 0");
   if (d.length < 1) throw new Error("Unable to open file " + filePath);
   if (lightsOnly) {
      var type = frameTypeFromKeywords(f.keywords);
      if (type != null && type != "light") { f.close(); return { skipped: type }; }
   }
   var window = new ImageWindow(d[0].width, d[0].height, d[0].numberOfChannels,
                                32 /*bitsPerSample*/, true /*float*/,
                                d[0].colorSpace != ColorSpace_Gray, "StarlinkSweeper_tmp");
   var view = window.mainView;
   try {
      view.beginProcess(UndoFlag_NoSwapFile);
      if (!f.readImage(view.image)) throw new Error("Unable to read image " + filePath);
      view.endProcess();
      f.close();
      var W = view.image.width, H = view.image.height;
      var P = new IntegerResample;
      P.zoomFactor = -FINE_BIN;
      P.downsamplingMode = IntegerResample.prototype.Average;
      P.noGUIMessages = true;
      P.executeOn(view, false /*swapFile*/);
      var img = view.image, w = img.width, h = img.height;
      var data = new Float32Array(w * h);
      img.getSamples(data, new Rect(0, 0, w, h), 0);
      var touched = false;
      for (var i = 0; i < data.length && !touched; i += 997) touched = data[i] != 0;
      if (!touched) {                       // this PixInsight build ignores typed arrays: use a plain Array
         var tmp = [];
         img.getSamples(tmp, new Rect(0, 0, w, h), 0);
         data.set(tmp);
      }
      return { data: data, w: w, h: h, W: W, H: H };
   } finally {
      window.forceClose();
   }
}

function analyseFile(filePath, lightsOnly) {
   var t0 = Date.now();
   var b = readBinnedImage(filePath, lightsOnly);
   if (b.skipped) return { file: filePath, skipped: b.skipped, score: -1, lines: [], status: "skipped", preview: null };
   var res = analyseBinned(b.data, b.w, b.h);
   res.file = filePath;
   res.width = b.W; res.height = b.H;
   res.seconds = (Date.now() - t0) / 1000;
   return res;
}

function listFrames(dir, recursive) {
   var files = [];
   for (var i = 0; i < EXTENSIONS.length; ++i) {
      var found = searchDirectory(dir + "/*" + EXTENSIONS[i], recursive);
      for (var k = 0; k < found.length; ++k)
         if (found[k].indexOf("/" + QUARANTINE_DIR + "/") < 0 && files.indexOf(found[k]) < 0) files.push(found[k]);
   }
   files.sort();
   return files;
}

function moveFile(src, dst) {
   if (typeof File.move == "function") File.move(src, dst);
   else { File.copyFile(dst, src); File.remove(src); }   // copyFile(target, source)
}

function csvEscape(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// ------------------------------------------------------------------- dialog
function SweeperDialog() {
   this.__base__ = Dialog;
   this.__base__();
   var self = this;

   this.results = [];          // all analysed frames
   this.threshold = DEFAULT_THRESHOLD;
   this.folder = "";
   this.stopRequested = false;
   this.scanning = false;
   this.bitmap = null;         // preview of the current frame
   this.bitmapIndex = -1;

   this.windowTitle = TITLE + " " + VERSION;
   this.userResizable = true;

   // ---- folder
   this.folderLabel = new Label(this);
   this.folderLabel.text = "Lights folder:";
   this.folderLabel.textAlignment = TextAlign_Right | TextAlign_VertCenter;
   this.folderEdit = new Edit(this);
   this.folderEdit.readOnly = true;
   this.folderEdit.toolTip = "Root folder of the light frames to scan (FITS / XISF).";
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
   this.recursiveCheck.checked = true;
   this.lightsOnlyCheck = new CheckBox(this);
   this.lightsOnlyCheck.text = "Lights only";
   this.lightsOnlyCheck.checked = true;
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

   // ---- threshold + scan
   this.thresholdControl = new NumericControl(this);
   this.thresholdControl.label.text = "Threshold:";
   this.thresholdControl.setRange(4, 60);
   this.thresholdControl.slider.setRange(0, 560);
   this.thresholdControl.setPrecision(1);
   this.thresholdControl.setValue(DEFAULT_THRESHOLD);
   this.thresholdControl.toolTip = "<p>Continuity score (in robust sigma) above which a frame is listed.</p>"
      + "<p>Clean frames score well below the default, a visible trail several times above it. "
      + "Changing the threshold re-filters the list without re-scanning.</p>";
   this.thresholdControl.onValueUpdated = function (v) { self.threshold = v; self.rebuildList(); };

   this.scanButton = new PushButton(this);
   this.scanButton.text = "Scan";
   this.scanButton.onClick = function () { self.scan(); };
   this.stopButton = new PushButton(this);
   this.stopButton.text = "Stop";
   this.stopButton.enabled = false;
   this.stopButton.onClick = function () { self.stopRequested = true; };

   var scanSizer = new HorizontalSizer;
   scanSizer.spacing = 6;
   scanSizer.add(this.thresholdControl, 100);
   scanSizer.add(this.scanButton);
   scanSizer.add(this.stopButton);

   this.progressLabel = new Label(this);
   this.progressLabel.text = "Select a folder and press Scan.";
   this.progressLabel.textAlignment = TextAlign_Left | TextAlign_VertCenter;

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
   this.tree.setMinSize(this.logicalPixelsToPhysical(520), this.logicalPixelsToPhysical(260));
   this.tree.toolTip = "<p>Frames whose best trail score is above the threshold, strongest first. "
      + "Click a frame to see the detected trail on the preview.</p>";
   this.tree.onCurrentNodeUpdated = function (node) { self.showPreview(node ? node.resultIndex : -1); };
   this.tree.onNodeDoubleClicked = function (node) { self.openInPixInsight(node.resultIndex); };

   // ---- actions
   this.quarantineButton = new PushButton(this);
   this.quarantineButton.text = "Quarantine";
   this.quarantineButton.toolTip = "<p>Move the selected frame into a <b>" + QUARANTINE_DIR
      + "</b> sub-folder next to it. Reversible: move it back by hand if needed.</p>";
   this.quarantineButton.onClick = function () { self.actOnCurrent("quarantine"); };
   this.quarantineAllButton = new PushButton(this);
   this.quarantineAllButton.text = "Quarantine all listed";
   this.quarantineAllButton.toolTip = "<p>Move every listed frame into its <b>" + QUARANTINE_DIR + "</b> sub-folder.</p>";
   this.quarantineAllButton.onClick = function () { self.quarantineAll(); };
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
   this.closeButton.onClick = function () { self.ok(); };

   var actionSizer = new HorizontalSizer;
   actionSizer.spacing = 6;
   actionSizer.add(this.quarantineButton);
   actionSizer.add(this.quarantineAllButton);
   actionSizer.add(this.eraseButton);
   actionSizer.add(this.openButton);
   actionSizer.addStretch();
   actionSizer.add(this.csvButton);
   actionSizer.add(this.closeButton);

   // ---- preview
   this.preview = new Control(this);
   this.preview.setMinSize(this.logicalPixelsToPhysical(720), this.logicalPixelsToPhysical(480));
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
                        TextAlign_Center | TextAlign_VertCenter);
      }
      g.end();
   };
   this.previewInfo = new Label(this);
   this.previewInfo.text = " ";
   this.previewInfo.textAlignment = TextAlign_Left | TextAlign_VertCenter;
   this.previewInfo.useRichText = true;

   // ---- layout
   var leftSizer = new VerticalSizer;
   leftSizer.spacing = 6;
   leftSizer.add(folderSizer);
   leftSizer.add(scanSizer);
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
}
SweeperDialog.prototype = new Dialog;

SweeperDialog.prototype.scan = function () {
   if (this.scanning) return;
   if (!this.folder.length || !File.directoryExists(this.folder)) {
      new MessageBox("Please select the folder of your light frames first.", TITLE, StdIcon_Warning, StdButton_Ok).execute();
      return;
   }
   var files = listFrames(this.folder, this.recursiveCheck.checked);
   if (files.length == 0) {
      new MessageBox("No FITS / XISF file found in\n" + this.folder, TITLE, StdIcon_Warning, StdButton_Ok).execute();
      return;
   }
   this.results = [];
   this.tree.clear();
   this.setBitmap(null, -1);
   this.scanning = true; this.stopRequested = false;
   this.scanButton.enabled = false; this.stopButton.enabled = true;
   console.show();
   console.abortEnabled = true;
   console.writeln("<end><cbr><b>" + TITLE + " " + VERSION + "</b>: " + files.length + " frames in " + this.folder);
   var t0 = Date.now(), flagged = 0, skipped = 0, scanned = 0, lightsOnly = this.lightsOnlyCheck.checked;
   for (var k = 0; k < files.length; ++k) {
      if (this.stopRequested || console.abortRequested) { console.warningln("Scan stopped by user"); break; }
      this.progressLabel.text = format("Scanning %d / %d  (%d flagged, %d skipped)  %s", k + 1, files.length,
                                       flagged, skipped, File.extractNameAndExtension(files[k]));
      processEvents();
      try {
         var res = analyseFile(files[k], lightsOnly);
         if (res.skipped) {
            ++skipped;
            this.results.push(res);
            console.writeln(format("[%d/%d] %s  skipped (%s)", k + 1, files.length,
                                   File.extractNameAndExtension(files[k]), res.skipped.toUpperCase()));
            continue;
         }
         res.status = "";
         this.results.push(res);
         ++scanned;
         var tag = res.score >= this.threshold ? format("TRAIL x%d", res.lines.length) : "ok";
         if (res.score >= this.threshold) ++flagged;
         console.writeln(format("[%d/%d] %s  score %.1f  %.1fs  %s", k + 1, files.length,
                                File.extractNameAndExtension(files[k]), res.score, res.seconds, tag));
      } catch (e) {
         console.criticalln("[" + (k + 1) + "/" + files.length + "] " + files[k] + ": " + e.message);
         this.results.push({ file: files[k], score: -1, lines: [], error: e.message, status: "error", preview: null });
      }
      this.rebuildList();
   }
   this.scanning = false;
   this.scanButton.enabled = true; this.stopButton.enabled = false;
   this.progressLabel.text = format("%d frames scanned in %.0f s, %d above threshold %.1f, %d skipped as non-light.",
                                    scanned, (Date.now() - t0) / 1000, flagged, this.threshold, skipped);
   console.writeln(this.progressLabel.text);
};

SweeperDialog.prototype.rebuildList = function () {
   var current = this.tree.currentNode ? this.tree.currentNode.resultIndex : -1;
   this.tree.clear();
   var order = [];
   for (var i = 0; i < this.results.length; ++i)
      if (this.results[i].status == "skipped") continue;
      if (this.results[i].score >= this.threshold || this.results[i].status == "error") order.push(i);
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
      var L = r.lines.length ? r.lines[0] : null;
      node.setText(0, format("%.1f", r.score));
      node.setText(1, String(r.lines.length));
      node.setText(2, L ? format("%.1f°", L.angle) : "");
      node.setText(3, L ? format("%d%%", Math.round(100 * L.run / N_SEG)) : "");
      node.setText(4, r.status);
      node.setText(5, File.extractNameAndExtension(r.file));
      node.setToolTip(5, r.file);
      for (var c = 0; c < 4; ++c) node.setAlignment(c, TextAlign_Right);
      if (order[k] == current) again = node;
   }
   for (var c2 = 0; c2 < 6; ++c2) this.tree.adjustColumnWidthToContents(c2);
   if (again) this.tree.currentNode = again;
};

SweeperDialog.prototype.buildBitmap = function (r) {
   var w = r.pw, h = r.ph, bmp = new Bitmap(w, h), p = r.preview;
   for (var y = 0; y < h; ++y)
      for (var x = 0; x < w; ++x) {
         var v = p[y * w + x];
         bmp.setPixel(x, y, 0xFF000000 | (v << 16) | (v << 8) | v);
      }
   var g = new Graphics(bmp);
   g.antialiasing = true;
   g.pen = new Pen(0xFFFF4040, 2);
   for (var i = 0; i < r.lines.length; ++i) {
      var L = r.lines[i];
      g.drawLine(L.x0 / FINE_BIN, L.y0 / FINE_BIN, L.x1 / FINE_BIN, L.y1 / FINE_BIN);
   }
   g.end();
   return bmp;
};

SweeperDialog.prototype.setBitmap = function (bmp, index) {
   this.bitmap = bmp; this.bitmapIndex = index;
   this.preview.update();
};

SweeperDialog.prototype.showPreview = function (index) {
   if (index < 0 || index >= this.results.length || !this.results[index].preview) {
      this.setBitmap(null, -1); this.previewInfo.text = " "; return;
   }
   var r = this.results[index];
   if (this.bitmapIndex != index) this.setBitmap(this.buildBitmap(r), index);
   var info = "<b>" + File.extractNameAndExtension(r.file) + "</b> &nbsp; score " + format("%.1f", r.score)
      + " &nbsp; " + r.width + "x" + r.height;
   for (var i = 0; i < r.lines.length; ++i) {
      var L = r.lines[i];
      info += format("<br>line %d: score %.1f, angle %.2f°, %d%% of the frame, from (%d, %d) to (%d, %d)",
                     i + 1, L.score, L.angle, Math.round(100 * L.run / N_SEG), L.x0, L.y0, L.x1, L.y1);
   }
   if (r.status.length) info += "<br><i>" + r.status + "</i>";
   this.previewInfo.text = info;
};

SweeperDialog.prototype.actOnCurrent = function (action) {
   var node = this.tree.currentNode;
   if (!node) return;
   var r = this.results[node.resultIndex];
   if (r.status == "quarantined" || r.status == "erased") {
      new MessageBox("This frame has already been " + r.status + ".", TITLE, StdIcon_Information, StdButton_Ok).execute();
      return;
   }
   if (!File.exists(r.file)) {
      new MessageBox("File not found:\n" + r.file, TITLE, StdIcon_Error, StdButton_Ok).execute();
      return;
   }
   if (action == "erase") {
      var answer = new MessageBox("Permanently delete this frame?\n\n" + r.file + "\n\nThis cannot be undone.",
                                  TITLE, StdIcon_Warning, StdButton_Yes, StdButton_No).execute();
      if (answer != StdButton_Yes) return;
      File.remove(r.file);
      r.status = "erased";
      console.writeln("Erased " + r.file);
   } else {
      this.quarantine(r);
   }
   this.rebuildList();
   this.showPreview(node.resultIndex);
};

SweeperDialog.prototype.quarantine = function (r) {
   var dir = File.extractDirectory(r.file) + "/" + QUARANTINE_DIR;
   if (!File.directoryExists(dir)) File.createDirectory(dir);
   var dst = dir + "/" + File.extractNameAndExtension(r.file);
   if (File.exists(dst)) throw new Error("Already exists: " + dst);
   moveFile(r.file, dst);
   r.status = "quarantined";
   r.movedTo = dst;
   console.writeln("Moved " + r.file + " -> " + dst);
};

SweeperDialog.prototype.quarantineAll = function () {
   var todo = [];
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.score >= this.threshold && r.status == "" && File.exists(r.file)) todo.push(r);
   }
   if (!todo.length) return;
   var answer = new MessageBox(format("Move %d frame(s) into their %s sub-folder?", todo.length, QUARANTINE_DIR),
                               TITLE, StdIcon_Question, StdButton_Yes, StdButton_No).execute();
   if (answer != StdButton_Yes) return;
   for (var k = 0; k < todo.length; ++k) {
      try { this.quarantine(todo[k]); }
      catch (e) { console.criticalln(e.message); }
   }
   this.rebuildList();
};

SweeperDialog.prototype.openInPixInsight = function (index) {
   if (index < 0 || index >= this.results.length) return;
   var r = this.results[index], path = r.movedTo || r.file;
   if (!File.exists(path)) {
      new MessageBox("File not found:\n" + path, TITLE, StdIcon_Error, StdButton_Ok).execute();
      return;
   }
   var windows = ImageWindow.open(path);
   if (windows.length) { windows[0].show(); windows[0].zoomToFit(); }
};

SweeperDialog.prototype.exportCSV = function () {
   if (!this.results.length) return;
   var sfd = new SaveFileDialog;
   sfd.caption = "StarlinkSweeper: save CSV report";
   sfd.filters = [["CSV files", "*.csv"]];
   sfd.initialPath = this.folder + "/StarlinkSweeper_report.csv";
   if (!sfd.execute()) return;
   var text = "file,flagged,score,coarse_peak,n_lines,status,lines(score@angle:x0,y0-x1,y1),error\n";
   for (var i = 0; i < this.results.length; ++i) {
      var r = this.results[i];
      if (r.status == "error") { text += csvEscape(r.file) + ",,,,,error,," + csvEscape(r.error) + "\n"; continue; }
      if (r.status == "skipped") { text += csvEscape(r.file) + ",,,,,skipped: " + r.skipped + ",,\n"; continue; }
      var desc = [];
      for (var k = 0; k < r.lines.length; ++k) {
         var L = r.lines[k];
         desc.push(format("%.1f@%.2f:%d,%d-%d,%d", L.score, L.angle, L.x0, L.y0, L.x1, L.y1));
      }
      text += csvEscape(r.file) + "," + (r.score >= this.threshold ? 1 : 0) + "," + format("%.1f", r.score) + ","
            + format("%.1f", r.coarse) + "," + r.lines.length + "," + r.status + "," + csvEscape(desc.join(" | ")) + ",\n";
   }
   File.writeTextFile(sfd.fileName, text);
   console.writeln("Report written to " + sfd.fileName);
};

// --------------------------------------------------------------------- main
function main() {
   console.hide();
   var dialog = new SweeperDialog();
   dialog.execute();
}

main();
