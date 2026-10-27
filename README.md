# StarlinkSweeper

**A PixInsight script that finds the light frames crossed by satellite trails, so you can leave
them out of the integration.** Point it at the folder of your subs, scan, check each suspect frame
on a preview with the trail drawn in red, then quarantine it or erase it. A Python command-line
version does the same in batch.

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
integration. StarlinkSweeper finds it.

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
| `scripts/StarlinkSweeper.js` | 1.9.4 and later (1.9.5 for the parallel scan) |

Input: FITS or XISF light frames, mono or CFA (read raw), calibrated or not.

The command-line version, `python/starlinksweeper.py`, is a separate tool for batch use outside
PixInsight; the script does not need it. It needs Python 3 with `numpy`, `scipy` and `astropy`,
installed once:

* Debian, Ubuntu and derivatives: `sudo apt install python3-numpy python3-scipy python3-astropy`
  (pip refuses to write into the system Python there);
* Windows, macOS, other Linux: `pip install numpy scipy astropy` (or `py -3 -m pip ...`);
* or a virtual environment: `python3 -m venv <folder> && <folder>/bin/pip install numpy scipy astropy`.

## Installation

### From the PixInsight update repository (recommended)

1. *Resources > Updates > Manage Repositories*, add
   `https://jps-34.github.io/StarlinkSweeper/`
2. *Resources > Updates > Check for Updates*, then restart PixInsight.
3. The script appears under *Script > JPS > StarlinkSweeper* (*Script > Utilities* up to 1.2.1).

Until the repository is code-signed, PixInsight only accepts it with the
*Allow unsigned update repositories* security preference enabled.

### Manual

Download `scripts/StarlinkSweeper.js`, then either run it with *Script > Execute Script File*, or
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

## Parallel scan

With PixInsight 1.9.5 and later, the frames are analysed in parallel inside PixInsight, one per
thread, and the results stream into the list as they come; the scores are the same as one frame at
a time. **Threads**, in the *Scanner* box: **Auto** (default) uses as many threads as the
processors allowed in the PixInsight preferences, fewer when the available memory is short (each
thread holds one frame); **1** analyses one frame at a time. With PixInsight 1.9.4 the scan runs one
frame at a time. Nothing to install.

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

## Command line

```
python3 python/starlinksweeper.py /path/to/lights -r                 # scan recursively, CSV report
python3 python/starlinksweeper.py /path/to/lights -r --preview out/   # also a PNG per flagged frame
python3 python/starlinksweeper.py /path/to/lights -r --move /path/to/lights_trails
python3 python/starlinksweeper.py /path/to/lights -t 15 -j 4 -o report.csv --list flagged.txt
```

Options: `-r` recursive, `-t` score from which a frame is flagged (default 20, the listing level of the script), `-j` parallel processes (default `auto`: one core is left free and the count is capped by the available memory, about 100 MB plus 5 bytes per pixel per worker; the chosen count and the reason are printed),
`-o` CSV path, `--preview DIR` (PNG for flagged frames, `--preview-all` for every frame),
`--move DIR` (move flagged frames, never deletes; put it next to the scanned folder, not inside), `--list FILE` (flagged file names, one per
line, handy to deselect them in your stacking software), `--all-types` (also scan flats, darks and
bias, which are skipped by default from their header). The CLI never deletes anything.

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
comes near it. The PixInsight script and the command-line version give the same scores to the
decimal.

### Limits

* Very faint trails (below about 0.5 σ per pixel in the sub) are not detected; they leave nothing
  measurable in a master either.
* Long, bright and very straight nebula filaments can come near the listing level. That is what the
  preview is for.
* Trails shorter than a quarter of the frame are ignored by design.
* The command-line version does not read compressed XISF files (the PixInsight script does).

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
