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
1900      4 p.  Новое время - 1900-01-05.pdf
1900      ? p.  Новое время - 1900.pdf

2 files, 4 pages, 1 of unknown size. Skipped: 6 over 500 pages (add --big), 79 not online.
```

`nlr.log` gets the full, uncut names.

## File names

Names are built from the catalog title: the repeated `A : A` tail is dropped, `:` becomes `-`, unmatched `[` and `]` are removed, and characters not allowed in file names (`/ \ ? * | " < >`) become `_`. Names are cut to 200 bytes of UTF-8 so long titles can be saved.

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
