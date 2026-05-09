import { describe, expect, it } from "bun:test";
import { buildStarterPrompt } from "../../src/phase/optimize.js";
import type { TaskSpec } from "../../src/types/index.js";

describe("buildStarterPrompt", () => {
  it("includes input, output, and success criteria context", () => {
    const spec: TaskSpec = {
      taskSummary: "Extract entities from business text into JSON.",
      inputs: [
        { name: "document", description: "Raw business document text", example: "Acme signed..." },
      ],
      outputs: [
        {
          name: "entities",
          description: "JSON array of extracted entities",
          example: '{"entities": [{"text": "Acme", "type": "ORG", "start": 0}]}',
        },
      ],
      successCriteria: [
        "Extracts the required entity types.",
        "Outputs valid JSON only.",
      ],
      failureModes: ["hallucination"],
      difficultyAxes: ["density"],
      outOfScope: [],
    };

    const prompt = buildStarterPrompt(spec);
    expect(prompt).toContain("## Input Contract");
    expect(prompt).toContain("Raw business document text");
    expect(prompt).toContain("## Output Contract");
    expect(prompt).toContain("JSON array of extracted entities");
    expect(prompt).toContain("## Output Examples");
    expect(prompt).toContain('{"entities": [{"text": "Acme", "type": "ORG", "start": 0}]}');
    expect(prompt).toContain("## Success Criteria");
    expect(prompt).toContain("Outputs valid JSON only.");
  });
});
