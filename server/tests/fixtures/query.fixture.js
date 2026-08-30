export function makeQueryFixture(overrides = {}) {
  return {
    pageUrl: "https://primo.nlr.ru/discovery/search?query=any,contains,example",
    searchUrl: "https://primo.nlr.ru/discovery/search?query=any,contains,example",
    status: "pending",
    results: null,
    resultsPerPart: null,
    parts: null,
    order: 1,
    downloaded: 0,
    downloadProgress: null,
    ...overrides,
  };
}

export function makeSearchResultFixture(overrides = {}) {
  return {
    title: "A sample document",
    href: "https://primo.nlr.ru/discovery/fulldisplay?docid=sample",
    fileName: "A sample document",
    status: "pending",
    ...overrides,
  };
}
