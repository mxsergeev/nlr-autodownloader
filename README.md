# NLR-AUTODOWNLOADER

Command line tool that downloads digitized documents from [National Library of Russia](https://primo.nlr.ru/) search results.

Everything runs over plain HTTP, no browser: searching uses the site's JSON API, and downloads make the same requests as the "Скачать" button on a document's Vivaldi page (register, prepare, poll progress, fetch the parts).

## Setup

Requires Node.js 20+.

```sh
npm install
```

Optionally `npm link` to get a global `nlr` command; otherwise use `node src/cli.js`.

## Usage

```sh
# See what a search would download, without downloading
nlr "Северная пчела" --years 1870-1920 --dry-run

# Every document up to 500 pages matching the query, one search per year
nlr "Северная пчела" --years 1870-1920

# Also the big ones (e.g. whole-year newspaper volumes)
nlr "Северная пчела" --years 1870-1920 --big

# A single year, 3 parallel downloads, custom output folder
nlr "Северная пчела" -y 1885 -w 3 -o ~/papers

# Every result of a search you already made on the website (copy the URL of the results page)
nlr --url "https://primo.nlr.ru/primo-explore/search?..." --name my-search
```

| Option            | Default       | Description                                                                     |
| ----------------- | ------------- | ------------------------------------------------------------------------------- |
| `-y, --years`     |               | Year (`1885`) or range (`1870-1920`)                                            |
| `-u, --url`       |               | primo.nlr.ru results page to download instead of a query (filters are ignored)  |
| `-n, --name`      | `url_<hash>`  | Folder name for `--url` downloads                                               |
| `-p, --max-pages` | `500`         | Skip documents with more pages                                                  |
| `--big`           |               | No page limit; wait up to 3 min (instead of 30 s) for the site to prepare files |
| `-d, --dry-run`   |               | Only list what would be downloaded                                              |
| `-w, --workers`   | `2`           | Parallel downloads. More than 2 is often rate limited by the site               |
| `-o, --out`       | `./downloads` | Output directory                                                                |

A query search is the same as the site's advanced search with the query matching exactly (`совпадает`) and `Год издания` equal to the year, sorted by issue date.

## Big documents

Before a download starts, the site prepares the file ("Проверка возможности загрузки"). Small documents are ready almost immediately; a ~1200 page year volume took about 2 minutes in tests, which is why big documents are opt-in with `--big`.

- Page counts come from the catalog record (`с.` pages or `л.` sheets). Documents over `--max-pages` are skipped.
- Some records have no page count (newspaper issues and year volumes). These are downloaded anyway. Without `--big`, if the site needs more than 30 s to prepare one, it is reported as `Too big … Add --big to download it.` It is not retried and does not trigger the rate-limit cooldown.
- `--big` removes the page limit and waits up to 3 min for preparation.
- The site splits big documents into parts of roughly 200 MB, saved as `<title> (1 of 3).pdf`, `<title> (2 of 3).pdf`, … The parts are renamed into place only after all of them are downloaded.

## Dry run

`--dry-run` prints one line per file that would be downloaded (year, pages, file name), cut to the terminal width, then a totals line. Groups with a zero count are left out:

```
1900      4 p.  Новое время 1900-01-05.pdf
1900      ? p.  Новое время 1900.pdf

2 files, 4 pages, 1 of unknown size. Skipped: 6 over 500 pages (add --big), 79 not online.
```

`nlr.log` gets the full, uncut names.

## File names

Names are the catalog title with characters not allowed in file names (`/ \ ? % * : | " < >`) replaced by `_` and all dots removed (`Газ. полит.` → `Газ полит`). Names are cut to 200 bytes of UTF-8 so long titles can be saved. This keeps names compatible with files downloaded by earlier versions of the tool, so a dry run recognizes them.

## Output

```
downloads/
  nlr.log                     # everything printed to the terminal, with timestamps
  Северная_пчела_1885/        # <query>_<year>
    .results.json             # cached search results
    <document title>.pdf
    <big document title> (1 of 3).pdf
```

Re-running the same command resumes: search results are cached (delete `.results.json` to search again) and documents that already have a PDF are skipped. Results without an electronic copy are counted as "not available online".

The exit code is `0` when everything selected was downloaded, `1` if anything failed, `2` on invalid arguments.

## Rate limiting

Downloads run in parallel. When a download fails, all workers pause for a shared cooldown (15 s, doubling on each failure in a row, max 5 min) and the document is retried later (up to 3 attempts). After 8 failures in a row the run stops; re-run later to resume.

## OCR

`nlr ocr` makes downloaded PDFs searchable with ABBYY FineReader PDF 16 (Windows), keeping NLR's original scans: FineReader only supplies the text, which is put invisibly onto the original pages. Pages that already have NLR's text (1917–1918) keep it.

```sh
# The 1901–1918 folders of ./downloads into ./ocr/<folder>/, same file names
nlr ocr downloads --out ocr

# Keep running and pick up new downloads every 5 min
nlr ocr downloads --out ocr --watch
```

| Option         | Default                                                 | Description                                                   |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `-o, --out`    |                                                         | Output directory (required)                                   |
| `-y, --years`  | `1901-1918`                                             | Years of the `<name>_<year>` folders to OCR                   |
| `-w, --watch`  |                                                         | Look for new files every 5 min instead of stopping            |
| `--chunk`      | `1`                                                     | Pages per FineReader job; more pages per job gave worse OCR   |
| `--day-ram`    | `20`                                                    | GB of RAM for FineReader by day                               |
| `--night-ram`  | `36`                                                    | GB of RAM for FineReader at night                             |
| `--day-cpus`   | `16`                                                    | CPU threads for FineReader by day                             |
| `--night-cpus` | all                                                     | CPU threads for FineReader at night                           |
| `--night`      | `0-8`                                                   | Night hours                                                   |
| `--settings`   |                                                         | JSON file that overrides the limits above, re-read every 10 s |
| `--finereader` | `C:\Software\ABBYY FineReader PDF 16\FineReaderOCR.exe` | FineReader's command line tool                                |

- FineReader's image preprocessing must be set to deskew and ISO noise reduction only (orientation correction may stay on). `nlr ocr` checks this at start and refuses otherwise; keep FineReader's window closed while it runs.
- Jobs start while they fit into the RAM budget (about 2 GB per one-page job) and leave Windows at least 6 GB free; below 3 GB free the youngest job is stopped and queued again.
- A failed job is retried once. Files that still fail are logged and tried again on the next run. Finished files are skipped, so re-running resumes.
- The log is `<out>/nlr-ocr.log`. The exit code is `0` when everything was OCRed, `1` if anything failed, `2` on invalid arguments.

## Binding

`nlr bind` binds the issues of each year folder into one PDF per quarter, with a bookmark per issue (e.g. `№ 172 (25 июня)`), sorted by date. Run it on the OCR output:

```sh
# ./ocr/<folder>/ → ./tomes/<folder>/Новая Петроградская газета 1912, янв–март.pdf, апр–июнь, июль–сент, окт–дек
nlr bind ocr --out tomes
```

| Option        | Default     | Description                                  |
| ------------- | ----------- | -------------------------------------------- |
| `-o, --out`   |             | Output directory (required)                  |
| `-y, --years` | `1901-1918` | Years of the `<name>_<year>` folders to bind |

- A quarter is bound only once every issue the folder's `.results.json` lists for it (with an electronic copy) is there; `nlr ocr` copies that file along. Until then it is logged as waiting.
- The date is the first one in the issue's name; for 1918 that is the old-style date (`8 (21) мая` → 8 May).
- Pages, images and text are copied unchanged. The tome is written one issue at a time, so memory stays low (a few hundred MB) however big it gets; a quarter is about 3 GB.
- Existing tomes are skipped. The log is `<out>/nlr-bind.log`.

## Nextcloud and the web page

`scripts/nextcloud-ocr-transport.js` moves the work between Nextcloud and this PC, one year folder at a time, and `scripts/nlr-ui.js` is a small web page that runs it together with `nlr ocr`:

```sh
node scripts/nlr-ui.js --in D:\nlr --ocr D:\nlr-ocr --tomes D:\nlr-tomes
# then open http://localhost:8080
```

The page starts and stops both, shows each year folder's progress and both logs, and changes FineReader's RAM, CPU threads and night hours while it runs (saved in `<tomes>/nlr-settings.json`, which both re-read; running jobs finish with the old limits). It is only reachable from this PC. Stopping OCR also stops FineReader; an interrupted issue is OCRed again on the next start.

For each `<folder>_<year>` on Nextcloud (`nlr/` by default) the transport:

1. downloads the originals that aren't in `--in` yet, while fewer than 2 (`ahead`) folders wait for OCR and at least 20 GB of disk stay free. The issue list, `.results.json`, must already be in `--in/<folder>/`; `nlr <query> --years <y> --dry-run --out <in>` makes it without downloading anything.
2. binds the quarters once every listed issue is OCRed,
3. uploads the tomes, then the issue list, to `nlr/ocr/<folder>/` (in 100 MB chunks; each upload's size is checked),
4. deletes the folder's originals, OCRed issues and tomes here, but only if every original here is on Nextcloud with the same size. Otherwise it keeps them and says why.

It never deletes anything on Nextcloud. The credentials are read from `~/.nextcloud-dav.json` (`{ "url", "user", "password" }`) and never logged. Run `node scripts/nextcloud-ocr-transport.js --help` for its options; it logs to `<tomes>/nlr-transport.log`.
