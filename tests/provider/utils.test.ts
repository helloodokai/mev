import { describe, expect, it } from "bun:test";
import { computeCost, redactKey, sha256 } from "../../src/provider/utils.js";

describe("computeCost", () => {
  it("computes cost from token counts", () => {
    const cost = computeCost(1000, 500, { input: 0.003, output: 0.015 });
    expect(cost).toBeCloseTo(0.003 * 1 + 0.015 * 0.5, 6);
  });

  it("returns zero for zero tokens", () => {
    const cost = computeCost(0, 0, { input: 0.003, output: 0.015 });
    expect(cost).toBe(0);
  });
});

describe("sha256", () => {
  it("produces deterministic hash", () => {
    const a = sha256("hello world");
    const b = sha256("hello world");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", () => {
    const a = sha256("hello");
    const b = sha256("world");
    expect(a).not.toBe(b);
  });

  it("produces 64-char hex string", () => {
    const hash = sha256("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("redactKey", () => {
  it("redacts a full API key", () => {
    expect(redactKey("sk-ant-1234567890abcdef")).toBe("sk-a...cdef");
  });

  it("handles null", () => {
    expect(redactKey(null)).toBe("(none)");
  });

  it("handles short keys", () => {
    expect(redactKey("abc")).toBe("****");
  });
});
