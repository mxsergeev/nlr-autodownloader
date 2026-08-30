import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard.js";

describe("copyToClipboard", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    document.execCommand = vi.fn().mockReturnValue(true);
  });

  it("rejects when the insecure-context fallback reports failure", async () => {
    document.execCommand.mockReturnValue(false);

    await expect(copyToClipboard("https://example.test/document")).rejects.toThrow(
      "Clipboard copy was rejected"
    );
    expect(document.querySelector("textarea")).toBeNull();
  });
});
