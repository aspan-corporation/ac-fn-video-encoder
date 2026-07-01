import { normalizeEtag, shouldSkipEncode } from "./encodeSkip.js";

describe("normalizeEtag", () => {
  it("strips surrounding quotes", () => {
    expect(normalizeEtag('"abc123"')).toBe("abc123");
  });
  it("passes through an unquoted value", () => {
    expect(normalizeEtag("abc123")).toBe("abc123");
  });
  it("returns undefined for undefined", () => {
    expect(normalizeEtag(undefined)).toBeUndefined();
  });
});

describe("shouldSkipEncode", () => {
  it("skips when the destination exists and its stored source ETag matches", () => {
    expect(
      shouldSkipEncode({
        destinationExisted: true,
        sourceEtag: "abc",
        destinationSourceEtag: "abc",
      }),
    ).toBe(true);
  });

  it("does not skip when the stored source ETag differs (genuine re-upload)", () => {
    expect(
      shouldSkipEncode({
        destinationExisted: true,
        sourceEtag: "new",
        destinationSourceEtag: "old",
      }),
    ).toBe(false);
  });

  it("does not skip on a first-time encode (destination absent)", () => {
    expect(
      shouldSkipEncode({
        destinationExisted: false,
        sourceEtag: "abc",
        destinationSourceEtag: undefined,
      }),
    ).toBe(false);
  });

  it("does not skip when the source ETag is unknown", () => {
    expect(
      shouldSkipEncode({
        destinationExisted: true,
        sourceEtag: undefined,
        destinationSourceEtag: undefined,
      }),
    ).toBe(false);
  });

  it("does not skip when the destination carries no source ETag (legacy output)", () => {
    expect(
      shouldSkipEncode({
        destinationExisted: true,
        sourceEtag: "abc",
        destinationSourceEtag: undefined,
      }),
    ).toBe(false);
  });
});
