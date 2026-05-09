import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLockedArtifact } from "../../src/phase/regress.js";

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `mev-regress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("loadLockedArtifact", () => {
  it("loads locked prompt text and persisted examples", async () => {
    const tmpDir = makeTmpDir();
    mkdirSync(path.join(tmpDir, "prompts"), { recursive: true });

    try {
      writeFileSync(
        path.join(tmpDir, "prompts", "locked.md"),
        "# mev locked prompt\n# Run: abc\n#\nSystem prompt body\n",
      );
      writeFileSync(
        path.join(tmpDir, "prompts", "locked.examples.json"),
        JSON.stringify([{ input: "input", output: "output", caseId: "0001" }], null, 2),
      );

      const artifact = await loadLockedArtifact(tmpDir);
      expect(artifact.promptText).toBe("System prompt body");
      expect(artifact.examples).toEqual([{ input: "input", output: "output", caseId: "0001" }]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
