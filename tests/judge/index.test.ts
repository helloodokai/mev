import { describe, expect, it } from "bun:test";
import { stripThinking } from "../../src/judge/index.js";

describe("stripThinking", () => {
  it("removes thinking blocks from output", () => {
    const input = "Some text<thinking>internal reasoning here</thinking>More text";
    const result = stripThinking(input);
    expect(result).toBe("Some textMore text");
  });

  it("handles multiple thinking blocks", () => {
    const input = "<thinking>first</thinking>Hello<thinking>second</thinking>World";
    const result = stripThinking(input);
    expect(result).toBe("HelloWorld");
  });

  it("handles multiline thinking blocks", () => {
    const input = "Before<thinking>\nline1\nline2\n</thinking>After";
    const result = stripThinking(input);
    expect(result).toBe("BeforeAfter");
  });

  it("returns unchanged text without thinking blocks", () => {
    const input = "No thinking blocks here";
    const result = stripThinking(input);
    expect(result).toBe("No thinking blocks here");
  });
});
