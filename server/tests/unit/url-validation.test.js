import { describe, expect, it } from "vitest";
import {
  MAX_NLR_URL_LENGTH,
  UrlValidationError,
  isAllowedNlrUrl,
  validateFinalNavigation,
  validateNlrUrl,
  validateScrapedUrl,
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
});
