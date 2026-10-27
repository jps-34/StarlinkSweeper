# Maintenance: development, release and signing

Notes for the author. Nothing here is needed to use the script.

## 1. Repository layout

| Path | Role |
|---|---|
| `scripts/StarlinkSweeper.js` | the PixInsight script, **only source to edit** for the script |
| `python/starlinksweeper.py` | command-line version, same algorithm and constants as the script; a separate tool for batch use outside PixInsight, not packed into the update archive |
| `tests/make_synthetic_subs.py` | generates the synthetic validation frames (a few GB, a few minutes) |
| `tests/run_scan_pi.js` | runs the analysis of the script on a list of frames inside PixInsight, without the dialog: one JSON line per frame |
| `tests/compare_scans.py` | compares two runs of `run_scan_pi.js`, field by field |
| `tools/build_repo.py` | builds the PixInsight update repository into `docs/` |
| `docs/` | served by GitHub Pages: `index.html`, `updates.xri`, the script archive, `.nojekyll` |
| `README.md`, `README.fr.md` | English and French documentation, each linking to the other |
| `CHANGELOG.md` | one entry per published version |

The script runs on the V8 engine of PixInsight (`#engine v8`, PixInsight 1.9.4 and later). The
PJSR classes (sizers, NumericControl, StdIcon, ...) are native: **do not `#include
<pjsr/*.jsh>`**, those headers belong to the legacy SpiderMonkey runtime. Constants are properties
of enumeration objects (`StdIcon.Warning`, `TextAlignment.Right`, `DataType.Int32`, ...), process
constants are read without `.prototype` (`IntegerResample.Average`), and the dialog is a class
extending `Dialog`. The update repository declares PixInsight 1.9.4 and later.

Parallel scan (PixInsight 1.9.5 and later): `scanFiles()` runs `analyseFile()` on `Thread`
objects, one frame per thread, each in a JavaScript runtime of its own where nothing of the script
exists. The source of a scan thread is built by `threadSource()` from an explicit list of constants
and functions: **any function or constant that `analyseFile()` comes to use must be added there**
(a missing one shows as a `ReferenceError` on every frame of a threaded scan, and the threaded run
of `tests/run_scan_pi.js` reveals it). Inside a thread there is no image window and no process:
frames are read with `FileFormatInstance` and binned by hand (`readBinnedImage()`, same values as
`IntegerResample`), and `checkAbort()` polls the abort flag of the thread instead of processing
events. Check every change with `tests/run_scan_pi.js` in series and with `threads=0`.

## 2. Repositories

* **Development**: the private forge repository. Work happens on `dev/<topic>` branches, merged
  into `main` through pull requests reviewed by the author.
* **Publication**: only a final, validated version goes to the public GitHub repository
  `jps-34/StarlinkSweeper`, whose GitHub Pages site serves the PixInsight update repository from
  `docs/` (*Settings > Pages*, branch `main`, folder `/docs`):
  `https://jps-34.github.io/StarlinkSweeper/`.

## 3. Signing (once and for all)

References: *The PixInsight Code Signing System*, installed with PixInsight under
`doc/docs/CodeSigning/CodeSigning.html`.

1. **Keys**: **SigningKeys** script (shipped with PixInsight). It creates a key pair in a
   password-protected `.xssk` file. Use a very strong password, keep the file backed up offline,
   **never in Git** (the `.gitignore` excludes it).
2. **Certified developer status (CPD)**: **SubmitCPD** script, with a developer identifier, the
   public key and an e-mail address. The PixInsight team reviews the request and gets back in touch
   if needed. It is an identity check, not a code review. Without this status, the signature is
   only recognised on your own machines.

## 4. Release of a version

Keep `scripts/StarlinkSweeper.js` and `python/starlinksweeper.py` in step: the detection constants
at the top of both files must stay identical, so that both give the same scores. `VERSION` lives in
both files as well.

1. On a `dev/<topic>` branch of the forge: set `VERSION` in both files, add the version line in the
   header of the script, add the CHANGELOG section, then build the update repository:

   ```bash
   python3 tools/build_repo.py --user jps-34
   ```

   With signing (later), order matters: sign `scripts/StarlinkSweeper.js` with **CodeSign**, run
   `tools/build_repo.py`, sign `docs/updates.xri` last, then commit.
2. Pull request on the forge; after the merge into `main`, tag the merge commit:

   ```bash
   git tag -a vX.Y.Z -m "StarlinkSweeper X.Y.Z"
   git push origin vX.Y.Z
   ```

3. Publication on GitHub, from a separate publication folder (a clone of the GitHub repository,
   never a working clone of the forge): replace its content with the content of the forge `main`
   (`git archive`), check the diff (no local paths, no personal data), commit with the GitHub
   no-reply identity, tag, and push `main` and the tag. Then, in PixInsight, *Check for Updates*.

Test of a development version in PixInsight: *Script > Execute Script File*, pick
`scripts/StarlinkSweeper.js` in the local clone. The script runs without being installed; the
installed version stays in place.

## 5. Validating a change to the detector

1. Generate the synthetic set once: `python3 tests/make_synthetic_subs.py <folder>`.
2. Run the command-line version on it and on a few real subs:
   `python3 python/starlinksweeper.py <folder> --preview-all --preview <output folder>`.
   Every frame whose name starts with `sat_`, `starlink_` or `aircraft` must be flagged, the
   `clean_*` and `star_spikes` frames must not; look at the PNG previews.
3. Port the change to `scripts/StarlinkSweeper.js` (the numeric core is the section between the
   `numeric core` and `end of core` markers) and check both give the same scores on the same files.
4. A change that must not alter the results (porting, refactoring, speed): run
   `tests/run_scan_pi.js` with the previous and the new script on the same frames, in series and
   with `threads=0` (automatic thread count), and compare:

   ```bash
   PixInsight.sh -n --automation-mode --no-startup-scripts \
     -r="<clone>/tests/run_scan_pi.js,<before.jsonl>[,threads=0],<frame1>,<frame2>,..." --force-exit
   python3 -I tests/compare_scans.py <before.jsonl> <after.jsonl>
   ```

## 6. Versions and history

* Numbering `MAJOR.MINOR.PATCH`: patch = bug fixed with no intended change in results, minor = new
  feature, major = incompatible settings or results.
* Each published version has its `vX.Y.Z` tag. The PixInsight repository (`docs/`) only serves
  the latest one; older versions stay available through git.
* Full history: `git log --oneline --decorate`.
* Getting a file from an older version:
  `git show v1.0.0:scripts/StarlinkSweeper.js > StarlinkSweeper-1.0.0.js`

## 7. Still to check

* Behaviour on OSC (CFA) subs and on 3-channel files: only channel 0 is analysed.
* Scan time on very large folders (hundreds of frames): the previews are kept in memory for the
  threshold slider; a lower-resolution preview may be needed if memory becomes a problem.
