/*
 * StarlinkSweeperCore.js
 * Copyright (c) 2026 Jacques Pouyaud.
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Free software under the GNU General Public License, version 3 or (at your
 * option) any later version, WITHOUT ANY WARRANTY; see LICENSE.
 * Code written by Claude (Anthropic), under the direction of Jacques Pouyaud.
 * https://github.com/jps-34/StarlinkSweeper
 *
 * Detection core of StarlinkSweeper: parameters, numeric analysis of a frame,
 * file reading and the parallel scan on threads. No dialog here: the dialog
 * script (StarlinkSweeper.js) includes this file, and the WBPP event script
 * loads it with an indirect eval, where #include is not available; so this
 * file has no #include and only top-level var and function declarations.
 */

// ---------------------------------------------------------------- parameters
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
var NODATA_GROW  = 2;      // bins left out around no-data bins (masking option)

// =============================================================== numeric core
// (no PixInsight object below this line: this section is also run under node
//  for validation)

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
   // {med, sig}: median and 1.4826 * MAD, with fallbacks for degenerate data
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
   // Mean binning b x b; the remainder rows/columns are dropped .
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

function fillNoData(s, n, invalid) {
   // Copy of s where the no-data bins hold the median of the others.
   var vals = new Float32Array(n), m = 0;
   for (var i = 0; i < n; ++i) if (!invalid[i]) vals[m++] = s[i];
   var med = m ? medianOf(vals, m) : 0, out = new Float32Array(n);
   for (var k = 0; k < n; ++k) out[k] = invalid[k] ? med : s[k];
   return out;
}

function binMeanNoData(src, w, h, b) {
   // Mean binning b x b (as binMean) for a whole frame, plus the no-data map:
   // 1 for a block holding any pixel at 0 (registration border) or NaN.
   var W = Math.floor(w / b), H = Math.floor(h / b);
   var out = new Float32Array(W * H), invalid = new Uint8Array(W * H), inv = 1.0 / (b * b);
   for (var Y = 0; Y < H; ++Y)
      for (var X = 0; X < W; ++X) {
         var s = 0, bad = 0;
         for (var dy = 0; dy < b; ++dy) {
            var row = (Y * b + dy) * w + X * b;
            for (var dx = 0; dx < b; ++dx) {
               var v = src[row + dx];
               if (!(v != 0)) bad = 1;     // 0 or NaN
               else s += v;
            }
         }
         out[Y * W + X] = s * inv;
         invalid[Y * W + X] = bad;
      }
   return { data: out, invalid: invalid, w: W, h: H };
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

function normalise(s, w, h, invalid) {
   // Returns {z (clipped, sigma units), valid (Uint8Array), stars [[x,y],...]
   // centred coordinates, preview (Uint8Array, display stretch)}
   // invalid (optional, masking option): Uint8Array, 1 where the bin holds
   // no data (registration border, pixels at 0). Those bins are filled with
   // the median of the others before the background is estimated, and they
   // and their neighbours (NODATA_GROW bins) are left out of the line search,
   // so that the edges of a registration border are not taken for trails.
   // Without it, the scan of a whole frame is unchanged.
   var n = w * h;
   if (invalid) s = fillNoData(s, n, invalid);
   var bg = background(s, w, h), r = new Float64Array(n);
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
   if (invalid) {
      var g = NODATA_GROW;
      for (var iy = 0; iy < h; ++iy)
         for (var ix = 0; ix < w; ++ix) {
            if (!invalid[iy * w + ix]) continue;
            for (var gy = Math.max(0, iy - g); gy <= Math.min(h - 1, iy + g); ++gy)
               for (var gx = Math.max(0, ix - g); gx <= Math.min(w - 1, ix + g); ++gx) {
                  valid[gy * w + gx] = 0;
                  z[gy * w + gx] = 0;
               }
         }
   }
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

function analyseBinned(s8, w8, h8, invalid, maxLines) {
   // s8: bin-8 mean image (Float32Array). Returns the analysis result.
   // invalid: optional no-data map of the bins (masking option, see normalise).
   // maxLines: lines kept, MAX_LINES when not given (the masking option keeps
   // every line, so that each member of a Starlink train is found).
   var nKeep = maxLines || MAX_LINES;
   checkAbort();
   var norm = normalise(s8, w8, h8, invalid);
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
   for (var L = 0; L < lines.length && kept.length < nKeep; ++L) {
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

// ------------------------------------------------------------ parallel scan
// PixInsight 1.9.5 runs JavaScript on Thread objects, each in a runtime of its
// own where nothing of this script exists: the source of a scan thread is
// built from the constants and functions listed in threadSource(), which must
// follow every function that analyseFile() calls. Same code, same scores as
// the scan in series.

function coreSource() {
   // Source of the constants and functions of this core, for a Thread (which
   // has a runtime of its own, where nothing of the calling script exists).
   // Any function or constant that analyseFile() or the masking engine comes
   // to use must be listed here.
   var c = { FINE_BIN: FINE_BIN, COARSE_STEP: COARSE_STEP, FINE_STEP: FINE_STEP, FINE_HALF: FINE_HALF,
             N_SEG: N_SEG, MIN_RUN: MIN_RUN, SEG_MIN_SIG: SEG_MIN_SIG, SPIKE_MAX_RUN: SPIKE_MAX_RUN,
             MAX_CAND: MAX_CAND, FLOOR: FLOOR, MARGIN: MARGIN, STAR_SUM: STAR_SUM, MAX_LINES: MAX_LINES,
             NODATA_GROW: NODATA_GROW, TYPE_KEYWORDS: TYPE_KEYWORDS };
   var src = [ "var verboseLog = false, abortRequested = null;" ];
   for (var k in c) src.push("var " + k + " = " + JSON.stringify(c[k]) + ";");
   var functions = [ checkAbort, kthSmallest, medianOf, robustSigma, binMean, medianFilter, fillNoData,
                     binMeanNoData, background, normalise, Projector, continuity, onBrightStar, endpoints,
                     analyseBinned, frameType, frameTypeFromKeywords, stage, keywordsType, readBinnedImage,
                     analyseFile ];
   for (var i = 0; i < functions.length; ++i) src.push(functions[i].toString());
   var methods = [ "project", "significance", "segments" ];
   for (var m = 0; m < methods.length; ++m)
      src.push("Projector.prototype." + methods[m] + " = " + Projector.prototype[methods[m]].toString() + ";");
   return src.join("\n");
}

function threadSource() {
   return coreSource() + "\n(function (d) { return analyseFile(d.path, d.lightsOnly); })";
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

// ------------------------------------------------------------- namespace
// What the masking engine uses. The WBPP event script loads this file inside a
// function, so that its many top-level names stay out of WBPP's global scope,
// and keeps only this object.
var StarlinkSweeperScan = {
   FINE_BIN: FINE_BIN,
   binMeanNoData: binMeanNoData,
   analyseBinned: analyseBinned,
   coreSource: coreSource,
   checkAbort: checkAbort,
   setAbort: function (f) { abortRequested = f; }
};
