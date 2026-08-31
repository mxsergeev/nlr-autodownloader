import { describe, expect, it } from "vitest";
import {
  MAX_NLR_URL_LENGTH,
  PRIMO_NLR_HOST,
  UrlValidationError,
  isAllowedNlrUrl,
  validateFinalNavigation,
  validateNlrUrl,
  validatePrimoUrl,
  validateScrapedUrl,
  validateVivaldiDetailsUrl,
  validateVivaldiPartUrl,
  validateVivaldiViewerUrl,
} from "../../services/url.service.js";

describe("NLR URL validation", () => {
  it.each([
    "https://primo.nlr.ru/discovery/search?query=any,contains,book",
    "https://primo.nlr.ru:443/discovery/search?query=book",
  ])("accepts an HTTPS URL on the Primo host: %s", (value) => {
    expect(validateNlrUrl(value)).toBeInstanceOf(URL);
    expect(isAllowedNlrUrl(value)).toBe(true);
  });

  it.each([
    "http://primo.nlr.ru/discovery/search?query=book",
    "https://example.com/discovery/search?query=book",
    "https://primo.nlr.ru.evil.example/discovery/search",
    "https://user:password@primo.nlr.ru/discovery/search",
    "https://primo.nlr.ru:8443/discovery/search",
    `https://primo.nlr.ru/discovery/search?query=${"x".repeat(MAX_NLR_URL_LENGTH)}`,
  ])("rejects an unsafe queue URL: %s", (value) => {
    expect(() => validateNlrUrl(value)).toThrow(UrlValidationError);
    expect(isAllowedNlrUrl(value)).toBe(false);
  });

  it("resolves and validates links scraped from an allowed page", () => {
    expect(
      validateScrapedUrl(
        "/discovery/fulldisplay?docid=123",
        "https://primo.nlr.ru/discovery/search"
      ).href
    ).toBe("https://primo.nlr.ru/discovery/fulldisplay?docid=123");

    expect(() =>
      validateScrapedUrl("https://attacker.example/steal", "https://primo.nlr.ru/discovery/search")
    ).toThrow("allowed NLR host");
  });

  it("checks the final URL after a browser redirect", () => {
    expect(
      validateFinalNavigation({ url: () => "https://primo.nlr.ru/discovery/search?redirected=1" })
        .hostname
    ).toBe("primo.nlr.ru");

    expect(() => validateFinalNavigation({ url: () => "https://127.0.0.1/admin" })).toThrow(
      "allowed NLR host"
    );
  });

  it("keeps queue/source URLs Primo-only", () => {
    expect(validatePrimoUrl("https://primo.nlr.ru/discovery/search").hostname).toBe(PRIMO_NLR_HOST);
    expect(() => validatePrimoUrl("https://vivaldi.nlr.ru/pm000053466/details")).toThrow(
      "allowed NLR host"
    );
  });

  it("accepts exact internal Vivaldi viewer, details, and part routes", () => {
    expect(validateVivaldiViewerUrl("https://vivaldi.nlr.ru/pm000053466/view").pathname).toBe(
      "/pm000053466/view"
    );
    expect(validateVivaldiDetailsUrl("https://vivaldi.nlr.ru/pm000053466/details").pathname).toBe(
      "/pm000053466/details"
    );
    expect(
      validateVivaldiPartUrl("https://vivaldi.nlr.ru/pm000053466/partfile?part=0", {
        documentId: "000053466",
      }).pathname
    ).toBe("/pm000053466/partfile");
  });

  it.each([
    "https://vivaldi.nlr.ru/pm000053466/view?part=0",
    "https://vivaldi.nlr.ru/pm000053466/details/",
    "https://vivaldi.nlr.ru/pm000053466/partfile",
    "https://vivaldi.nlr.ru/pm000053467/partfile?part=0",
    "https://vivaldi.nlr.ru/pm000053466/partfile?part=1",
    "https://vivaldi.nlr.ru/pm000053466/partfile?part=0&other=1",
    "https://vivaldi.nlr.ru/pm000053466/partfile?part=0#fragment",
  ])("rejects unsafe Vivaldi document routes: %s", (value) => {
    expect(() => {
      if (value.includes("/view")) return validateVivaldiViewerUrl(value);
      if (value.includes("/details")) return validateVivaldiDetailsUrl(value);
      return validateVivaldiPartUrl(value, { documentId: "000053466" });
    }).toThrow(UrlValidationError);
  });

  it.each([
    "http://vivaldi.nlr.ru/pm000053466/view",
    "https://vivaldi.nlr.ru:8443/pm000053466/details",
    "https://vivaldi.nlr.ru.evil.example/pm000053466/details",
    "https://user:password@vivaldi.nlr.ru/pm000053466/details",
  ])("rejects unsafe Vivaldi host/protocol routes: %s", (value) => {
    expect(() => validateVivaldiDetailsUrl(value)).toThrow(UrlValidationError);
  });

  it.each([
    "http://vivaldi.nlr.ru/pm000053466/partfile?part=0",
    "https://vivaldi.nlr.ru:8443/pm000053466/partfile?part=0",
    "https://vivaldi.nlr.ru.evil.example/pm000053466/partfile?part=0",
  ])("rejects unsafe Vivaldi part hosts/protocols: %s", (value) => {
    expect(() => validateVivaldiPartUrl(value, { documentId: "000053466" })).toThrow(
      UrlValidationError
    );
  });
});
