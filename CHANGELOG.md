# Changelog

## Unreleased
* README (English and French), *Limits*: masking with 6 frames or fewer leaves faint dark lines in
  the master, a side effect of the percentile clipping WBPP uses for small stacks (tighter on the
  high side, applied to one value less where a trail was masked); none with 15 frames or more (ESD),
  untested between 7 and 14 (Winsorized sigma clipping). Run WBPP without the event script for such
  small stacks.

## 1.3.0 (2026-10-28)
* **SNR-preserving masking option for WBPP** (`StarlinkSweeper-WBPP.js`, a WBPP event script):
  instead of setting a frame aside, WBPP keeps it and only the pixels of its trails are left out of
  the integration, so the signal-to-noise ratio of the master is almost untouched (the quarantine
  loses the whole frame). Available for now only through a WBPP integration.
  Right after registration, every registered light frame is scanned in every direction; each trail
  (each member of a Starlink train separately) is masked with its wings, the masked pixels are set
  to 0 and WBPP's integration rejects them. One compressed mask file per masked frame, a coverage
  map, CSV reports and a log in `<WBPP output>/StarlinkSweeper/`. The quarantine of the dialog is
  unchanged.
* The mask geometry (trail width, ends, drawing) comes from ClarkeMask: `StarlinkSweeperMaskCore.js`
  is a copy of its core.
* The scan of registered frames leaves out their registration borders (pixels at 0), whose edges
  were taken for horizontal and vertical lines and hid faint trails. The scan of the dialog, on
  unregistered frames, is unchanged (same scores to the bit).
* Dialog: a *Masking in WBPP (recommended)* box explains why masking is better than quarantine (the
  signal-to-noise ratio of the master is almost untouched) and gives the path of the event script to
  select in WBPP.
* Interface in English or French (*Langue / Language* list), remembered, the language of the system
  by default; the window reopens in the chosen language with the results of the scan kept. The
  console and the CSV report stay in English.
* README (English and French): an *UPDATE 1.3.0* banner at the top announces the SNR-preserving
  masking.
* The command-line Python version (`python/starlinksweeper.py`) is removed from the repository: the
  parallel scan of the dialog and the masking in WBPP cover its uses, with nothing to install. Its
  last version stays available in the history (tag `v1.2.2`).
* Code: the detection core (parameters, analysis of a frame, file reading, parallel scan) moves
  from `scripts/StarlinkSweeper.js` to `scripts/StarlinkSweeperCore.js`. A manual installation
  needs all the files of `scripts/`.

## 1.2.2 (2026-10-27)
* Menu: the script moves from *Script > Utilities* to *Script > JPS*, the folder that groups
  the PixInsight scripts of Jacques Pouyaud. No change to the behaviour.

## 1.2.1 (2026-10-27)
* Licence changed from MIT to the GNU General Public License, version 3 or later
  (GPL-3.0-or-later). Versions up to 1.2.0 remain available under the MIT License. No change to
  the behaviour. The command-line Python version follows (1.2.1).
* README: credit request for reuse of the method or the code.

## 1.2.0 (2026-10-27)
* Script ported to the V8 JavaScript engine of PixInsight (`#engine v8`, PixInsight 1.9.4 and
  later): legacy `#include <pjsr/*.jsh>` removed, constants read from the enumeration objects,
  dialog written as a class, deprecated global functions replaced. Same results as 1.1.5, frame by
  frame (every score, angle and line end identical on a set of real subs). The legacy SpiderMonkey
  engine, which ran the script until now, is to be removed from PixInsight.
* **Parallel scan in PixInsight** (1.9.5 and later): the frames are analysed on PJSR threads, one
  per thread, and stream into the list as they come; same scores as one frame at a time. New
  **Threads** setting in the *Scanner* box (Auto by default: the processors allowed by the
  PixInsight preferences, fewer when the available memory is short; 1 = one frame at a time). Stop
  interrupts the threads. With PixInsight 1.9.4 the scan runs one frame at a time.
* The **Parallel scan with Python** option is removed from the dialog (Python, Script, Workers and
  Detect with it): the threads replace it, with nothing to install. The command-line version
  `python/starlinksweeper.py` stays in the repository as a separate tool and is no longer packed
  into the update archive. Reset also forgets the settings of the former Python option.
* Frames read without an image window (`FileFormatInstance`) and binned by hand, with the same
  values as IntegerResample: the same reading for the threads and for the scan in series.
* Tests: `tests/run_scan_pi.js` (analysis of a list of frames inside PixInsight, without the
  dialog, in series or on threads) and `tests/compare_scans.py` (two runs compared field by
  field).
* Maintenance notes: development on the forge, publication of validated versions only on GitHub.

## 1.1.5 (2026-10-18)
* The machine probe (Detect) works with no folder selected; the command line refused the call,
  so Detect failed right after a Reset.

## 1.1.4 (2026-10-18)
* **Reset** button, PixInsight style at the bottom left: forgets every remembered setting (red
  level, options, Python and script paths, workers, last folder) and restores the defaults.
* The scanner status shows the path of the command-line script in use and warns in red when its
  version differs from the script's (typically a copy left over from a test).

## 1.1.3 (2026-10-18)
* The quarantine folder is now created **next to** the scanned folder (`<folder>_trails`, same
  sub-folders inside) instead of inside it, so that a stacking program importing the scanned folder
  recursively never sees the quarantined frames. Quarantine folders are skipped by the scan, in the
  script and in the command line.

## 1.1.2 (2026-10-18)
* Installation hints for the Python modules per system (apt on Debian and Ubuntu, pip elsewhere,
  or a virtual environment) in the dialog and the READMEs; wording only.

## 1.1.1 (2026-10-18)
* The parallel scan no longer depends on capturing the scanner's standard output, which is not
  available in every PixInsight build: the Python version and the machine probe go through files,
  and the scan progress through a progress file written by the command line (`--progress-file`).
  When Python is not found, the status line says what happened with each interpreter tried.

## 1.1.0 (2026-10-18)
* **Parallel scan**: the dialog can delegate the scan to the bundled command-line version
  (`starlinksweeper.py`, installed next to the script, same algorithm and scores), which analyses
  several frames at once. *Scanner* box with the option, the Python and script paths, a **Workers**
  slider bounded by what the machine allows (CPU threads, capped by the available memory) and a
  **Detect** button. Results stream into the list; previews are built on demand. Needs Python 3 with
  numpy, scipy and astropy; otherwise the built-in single-core scan is used.
* Command line: `-j auto` (default) fits the number of workers to the machine, `--probe` reports
  the machine capacity as JSON, `--json-lines` streams one record per frame; the CSV gains the
  frame size and the extent of each line. Frames are no longer converted to float before binning,
  which cuts the memory of each worker by about a third.
* Script: the window can be made narrower (wrapping labels, shortened file names, smaller minimum
  sizes). *Verbose log* option removed.

## 1.0.6 (2026-10-18)
* One adjustable level only, **Red above**. Frames and lines are listed from a fixed score of 20
  up; the former threshold slider is gone. Weaker candidates, kept internally, are no longer drawn
  on the preview nor counted. The command-line default (`-t`) is 20 as well.

## 1.0.5 (2026-10-18)
* **Red above** level: frames whose best trail scores at or above it are shown in red in the list
  and counted in the summary; **Quarantine red** moves them all in one go; `red` column in the CSV.
* Threshold, red level, options and the last folder are remembered between sessions.

## 1.0.4 (2026-10-18)
* The information line under the preview is reset when a new scan starts and shows live counts
  (frames scanned, above threshold, skipped) whenever no frame is selected; the details of a
  selected frame follow the list refreshes instead of lingering from a previous scan.

## 1.0.3 (2026-10-18)
* Fixes 1.0.1, which stopped with an error right after the first frame (list refresh) and left
  the dialog frozen. 1.0.2 was a development build with the same fault and was never released.
* The frame type is read from the file keywords before loading (a flat is not loaded at all), with
  the image window keywords as fallback.
* **Stop** now takes effect within a second or two: the scan checks for it between the stages of
  each frame's analysis, not only between frames, and the button gives immediate feedback. The
  console's own abort does the same.
* *Verbose log* option: one console line per stage of each frame (open, header, read, bin,
  analyse), to locate where a scan stops.

## 1.0.1 (2026-10-18)
* Only light frames are analysed: flats, darks and bias are recognised from their `IMAGETYP`
  (or `FRAME` / `FRAMETYP`) header and skipped, in the script (*Lights only* option, on by default)
  and in the command-line version (`--all-types` to scan everything). Frames without the keyword
  are scanned. Skipped frames are listed in the CSV report.

## 1.0.0 (2026-10-18)
* First release. PixInsight script (`scripts/StarlinkSweeper.js`): folder scan, list of the frames
  crossed by trails with score, angle and extent, preview with the detected trails, quarantine to a
  `_trails` sub-folder, confirmed erase, open at full resolution, threshold re-filtering, CSV
  export.
* Command-line version (`python/starlinksweeper.py`) with the same algorithm and scores: parallel
  scan, CSV report, PNG previews, optional move of the flagged frames, list of flagged names.
* Detector: binned Radon-type line projection with removal of broad structures, fine angular
  refinement, continuity test over 24 segments with local baselines, diffraction-spike rejection
  through saturated stars.
* PixInsight update repository served from `docs/` (unsigned for now).
