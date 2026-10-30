# StarlinkSweeper

## UPDATE 1.3.0: SNR-preserving masking

> **Your trailed frames no longer have to be thrown away.** With WBPP, a new event script keeps the
> frames crossed by a satellite trail and masks only the pixels of the trail, wings included. The
> rest of the frame still goes into the integration, so the signal-to-noise ratio of the master is
> almost untouched, where the quarantine loses the whole frame. This is a big improvement over the
> quarantine, available for now only through a WBPP integration: see
> [Masking in WBPP](#masking-in-wbpp-keep-the-frames).

**A PixInsight script that finds the light frames crossed by satellite trails, so you can leave
them out of the integration.** Point it at the folder of your subs, scan, check each suspect frame
on a preview with the trail drawn in red, then quarantine it or erase it. **With WBPP, you can also
keep those frames**: an event script masks only the pixels of their trails (see *Masking in WBPP*).

*Sweeps away the trails a certain billionaire's constellation leaves on your subs.*

*Version française : [README.fr.md](README.fr.md)*

![Starlink train detected on a narrowband sub](docs/example_starlink_train.png)

*A Starlink train on a real narrowband sub. Binned, background-subtracted, stretched; the detected
trails are drawn in red.*

## Why

Sigma-clipping rejection (Astro Pixel Processor, PixInsight ImageIntegration, Siril...) removes the
**core** of a satellite trail, but not its **wings**: a few pixels away from the centre, the trail
is only slightly above the noise of the sub, under any reasonable kappa. When there are not enough
subs to average them out, those wings survive as a faint straight band in the master, invisible on
the linear data, obvious once you stretch hard. The quality score of the pre-processing software
does not see it either: a trail changes neither star count, FWHM nor roundness, so the sub is kept.

When you do not have enough subs, the best fix is to leave the contaminated sub out of the
integration. StarlinkSweeper finds it. With WBPP you do not even have to give up the sub: the
masking option keeps it and leaves out only the pixels of the trail, wings included.

## What it does

1. **Scan.** Every FITS / XISF light frame of the chosen folder (sub-folders included) is binned,
   background-subtracted and searched for straight lines in every direction. Flats, darks and bias
   found in the tree are recognised from their header and skipped, so a whole night's folder can be
   scanned as it is. Expect a few seconds per 60 Mpx frame and per processor: with PixInsight 1.9.5
   the frames are analysed in parallel (see *Parallel scan*).
2. **List.** Frames whose best trail scores 20 or more are listed, strongest first, with the angle
   of the trail and the fraction of the frame it covers; from the adjustable *Red above* level they
   are shown in red. A Starlink train shows as several parallel lines at the same angle.
3. **Check.** Click a frame to see it on the preview, the detected trails drawn in red over their
   detected extent; double-click to open the sub at full resolution in PixInsight.
4. **Act.** **Quarantine** moves the frame out of the scanned folder, into a `<folder>_trails`
   folder created next to it with the same sub-folders inside (scanning `.../Target/S1` puts them
   under `.../Target/S1_trails/...`), so that a stacking program importing the scanned folder
   recursively never sees them again; reversible by hand. **Erase** deletes the frame permanently,
   after a confirmation every time. **Quarantine red** moves every frame shown in red (score at or
   above the *Red above* level), **Quarantine all listed** the whole list. **Export CSV** writes the
   score of every scanned frame.

The *Red above* slider re-colours the list without re-scanning. Nothing is ever modified in the
frames themselves; quarantine folders (names ending with `_trails`) are never scanned.

## Requirements

| File | PixInsight |
|---|---|
| `scripts/StarlinkSweeper.js` + `scripts/StarlinkSweeperCore.js` (dialog: scan, quarantine) | 1.9.4 and later (1.9.5 for the parallel scan) |
| `scripts/StarlinkSweeper-WBPP.js` + `StarlinkSweeperCore.js`, `StarlinkSweeperMaskCore.js`, `StarlinkSweeperMaskEngine.js` (masking in WBPP) | 1.9.4 and later, WBPP with event scripts (tested with WBPP 3.1.2 in PixInsight 1.9.5; parallel detection needs 1.9.5) |

Input: FITS or XISF light frames, mono or CFA (read raw), calibrated or not.

## Installation

### From the PixInsight update repository (recommended)

1. *Resources > Updates > Manage Repositories*, add
   `https://jps-34.github.io/StarlinkSweeper/`
2. *Resources > Updates > Check for Updates*, then restart PixInsight.
3. The script appears under *Script > JPS > StarlinkSweeper* (*Script > Utilities* up to 1.2.1).

Until the repository is code-signed, PixInsight only accepts it with the
*Allow unsigned update repositories* security preference enabled.

### Manual

Download **all the files of `scripts/`** into the same folder (the dialog includes
`StarlinkSweeperCore.js`, the WBPP event script loads the three others), then either run
`StarlinkSweeper.js` with *Script > Execute Script File*, or
add its folder with *Script > Feature Scripts > Add* so it shows up in the *Script > JPS*
menu.

## Quick start

1. **Lights folder**: choose the root folder of the subs (one filter, one target, or the whole
   night: it does not matter). *Include sub-folders* is on by default. The quarantine will be
   created next to this folder.
2. **Scan**. Progress is shown in the dialog and in the console; **Stop** interrupts cleanly.
3. Go through the list: click a frame, look at the preview, then **Quarantine** or **Erase**.
4. Re-run the integration without the quarantined frames.

Run it before integration, on the raw or calibrated lights. If a master already shows a faint
straight band after stretching, scan the subs that went into it: the contaminated one stands out
far above the others.

## Language

The interface is in English or French: **Langue / Language** list, next to the *Scan* button. The
choice is remembered; by default the language of the system. The window reopens in the chosen
language and keeps the results of the scan. The console and the CSV report stay in English.

## Parallel scan

With PixInsight 1.9.5 and later, the frames are analysed in parallel inside PixInsight, one per
thread, and the results stream into the list as they come; the scores are the same as one frame at
a time. **Threads**, in the *Scanner* box: **Auto** (default) uses as many threads as the
processors allowed in the PixInsight preferences, fewer when the available memory is short (each
thread holds one frame); **1** analyses one frame at a time. With PixInsight 1.9.4 the scan runs one
frame at a time. Nothing to install.

## Masking in WBPP (keep the frames)

Instead of setting a frame aside, WBPP can keep it and leave out only the pixels of its trails.
**This is the recommended way when you stack with WBPP**: a quarantined frame is lost entirely and the
signal-to-noise ratio of the master drops accordingly, while a masked frame keeps everything but its
trails (usually 0.1 to 2 % of the frame), so the signal-to-noise ratio is almost untouched (measured
below). For now it needs a WBPP integration; the quarantine remains for any other stacking software.

1. In WBPP, *Pipeline* tab, tick **Event Script** and select `StarlinkSweeper-WBPP.js` in the
   StarlinkSweeper folder (the *Masking in WBPP* box of the dialog shows its path).
2. Run WBPP as usual, on all your lights: do **not** quarantine the frames you stack this way.

Right after registration, every registered light frame is scanned in every direction. Each trail
found is masked, wings included, each member of a Starlink train separately; the masked pixels are
set to 0 in the registered frame, and WBPP's integration rejects them (range rejection at 0, the
default for lights). Each pixel is integrated from the frames that are clean there; the frame keeps
everything else. Local normalization then works on the masked frames. Your source frames are never touched:
only the registered frames of the WBPP output folder are modified.

In `<WBPP output>/StarlinkSweeper/`: the log `StarlinkSweeper.log`, and per group of frames one
compressed `<frame>_mask.xisf` per masked frame, `coverage.xisf` (fraction of the frames kept at
each pixel), `coverage.csv`, `frames.csv` (score, trails and masked fraction of every frame) and
`trails.csv` (angle, length and width of every masked trail).

**Disk space.** Besides WBPP's own files: about 0.1 MB per masked 61 Mpx frame and about 1 MB per
group (coverage map and reports). On a 76-frame narrowband set, 0.5 to 0.85 MB per filter.

**One event script per WBPP run**: StarlinkSweeper's or ClarkeMask's, not both.

Measured on a raw (uncalibrated) narrowband set of 76 frames of 61 Mpx (H, S, O; 300 s), WBPP 3.1.2
with local normalization: 9 frames masked, among them a Starlink train of seven parallel trails
masked on 2.1 % of its frame and 8 single trails on 0.1 to 0.2 % of theirs; about 20 s per group of
23 to 27 frames on 28 processors. In the masters integrated by WBPP from all the frames, the trails
left a faint straight trace along their path (0.1 to 0.2 σ of the master's noise per pixel, the kind
of band a hard stretch reveals); with the masking, the trace is gone (at the noise level, like with
masks drawn by hand two to three times wider) and the noise of the masters is unchanged. Two faint
trails that the quarantine scan of the unregistered frames had missed were found and masked.

On a galaxy field rich in stars (109 raw luminance frames of 61 Mpx, 150 s): 53 frames masked, each
one crossed by a real trail (checked against an independent scan of the unregistered frames and on
full-resolution crops), no false positive found; a median of 0.2 % of a frame masked, at most 0.9 %;
82 s for the 109 frames on 28 processors, 6.75 MB of masks and reports.

## Settings

| Setting | Meaning |
|---|---|
| **Lights folder** | Root folder to scan. FITS (`.fit`, `.fits`, `.fts`) and XISF files, any case. |
| **Include sub-folders** | Recursive scan (on by default). Quarantine folders (names ending with `_trails`) are skipped. |
| **Lights only** | On by default: frames whose `IMAGETYP` (or `FRAME`, `FRAMETYP`) header says flat, dark or bias are skipped and listed as such in the CSV report. Frames without the keyword are scanned. Untick to scan every frame. |
| **Red above** | Frames whose best trail scores at or above this value are shown in red: a trail that strong is never a false alarm, so **Quarantine red** moves them all in one go. Frames between the listing level and this value deserve a look at the preview. Changing it re-colours the list without re-scanning. |
| **Threads** | Frames analysed at the same time; see *Parallel scan*. |

Frames and lines are listed from a fixed score of 20 up. The score is a significance in units of
the frame's own noise (see *How it works*), so this level does not depend on exposure, gain or
camera: clean frames stay far below it, a visible trail lands several times above it. Red level,
options, threads and the last folder are remembered from one session to the next; the
**Reset** button (bottom left, PixInsight style) forgets them all and restores the defaults.

Whatever the level, look at the preview before erasing.

## How it works, in short

1. The frame is binned 8×8 (mean). A large-scale background (median on a coarser grid, two passes)
   is subtracted; the result is expressed in robust σ and clipped to ±3 σ so stars and hot pixels
   weigh little.
2. A Radon-type line projection is computed every 0.25° at bin 16. Along each direction the broad
   structures (nebulae, gradients, clouds) are removed with a running low percentile, so only thin
   lines survive. The map is normalised by its own robust σ.
3. Each candidate line is refined at bin 8 with 0.05° steps.
4. Continuity test: the line is cut into 24 segments, each compared with its own local baseline
   (parallel bands on both sides). A trail must be present in at least 6 consecutive segments; the
   score is √run × median(segment significance), so a few bright crossings (nebula chord, star)
   cannot carry a line alone. A short line through a saturated star is a diffraction spike and is
   rejected.
5. Up to 5 lines are reported per frame. The frame score is the best line's score.

Validated on a synthetic full-frame set (clean sky, cloud, strong gradient, bright filaments,
diffraction spikes, trails from very faint to saturated, a satellite train, an aircraft, a trail
covering only part of the frame; `tests/make_synthetic_subs.py`) and on real subs: every trail is
detected and clean frames stay well below the listing level; only the bright-filament stress case
comes near it.

**Masking (WBPP event script).** On each registered frame, the scan above runs on the mean of the
channels with the bins of the registration borders (pixels at 0) left out, so that their edges are
not taken for lines, and with every line kept. Candidate lines score 15 or more (the list of the
dialog starts at 20: masking a few pixels costs little, a trail left in costs a band in the
master). Along each direction found, the trail detector of ClarkeMask (`StarlinkSweeperMaskCore.js`,
a copy of its core) works on the 2x2 mean of the frame: it rectifies the frame along the direction,
finds each thin trail (each member of a train separately, a slight bend allowed: long low-orbit trails
are not perfectly straight), measures where it rises above the noise (down to 0.5 σ per pixel on each
side: the wings) and where it ends, and draws the mask at full
resolution, 4 px wider on each side and 16 px longer at each end. Only the trails within 120 px of
a candidate line are masked.

### Limits

* Very faint trails (below about 0.5 σ per pixel in the sub) are not detected; they leave nothing
  measurable in a master either.
* Long, bright and very straight nebula filaments can come near the listing level. That is what the
  preview is for.
* Trails shorter than a quarter of the frame are ignored by design.
* Masking: a trail must span about a quarter of the line it lies on to be found (as for the scan), so a
  short trail is found in a corner, from about a tenth of the smaller image side, and not in the middle of
  the frame. A trail
  that fades in places can be masked in pieces, with short unmasked gaps. Not tested with drizzle
  integration. The local normalization reference built by WBPP from the masked frames has not been
  checked on its own (the masters were).
* ImageAnalysis (PixInsight 1.9.6): with the masking, do not reject frames on its `Trails` property
  (for example `Trails < 1`): those frames would be lost instead of masked. WBPP does not use this
  property; the other measurements of ImageAnalysis are not affected.
* Masking with 6 frames or fewer: WBPP then integrates with percentile clipping, whose default
  thresholds are tighter on the high side (0.10) than on the low side (0.20). Where a trail was
  masked, the pixel keeps one frame less, and on such a small stack the clipping drops the higher of
  the remaining values more often: the masked trails come out as faint dark lines in the master. It
  is a side effect of WBPP's rejection for small stacks, not of the masks (the masked pixels are
  rejected). With 15 frames or more (ESD rejection) there is no such effect; between 7 and 14 frames
  (Winsorized sigma clipping) it has not been tested. For 6 frames or fewer, run WBPP without the
  event script.

## License

Copyright (c) 2026 Jacques Pouyaud. Released under the
[GNU General Public License, version 3 or later](LICENSE) (GPL-3.0-or-later): you may use, study,
share and modify it; any distributed work that includes this code must be released under the same
licence, with its source code. Versions up to 1.2.0 were released under the MIT License, which
still applies to copies of those versions.

**Credit request.** If you reuse the method or the code of StarlinkSweeper, in a script, an
application or a tutorial, please credit it by name with a link to this repository. This is a
request, not a licence condition; when the code itself is reused, the GPL already requires keeping
the copyright notice.

Bug reports and suggestions are welcome as GitHub issues.

## Credits

*Code written by Claude (Anthropic), under the direction of Jacques Pouyaud, who defined the need,
tested it on his own data and validated the results.*
