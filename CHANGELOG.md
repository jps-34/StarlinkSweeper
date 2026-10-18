# Changelog

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
