import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { excalidrawToMermaid } from "@src/components/assets/editor/whiteboard/excalidrawToMermaid";

// Repo root is three levels up from ui/tests/react/unit/.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CORPUS_DIR = path.join(REPO_ROOT, "tests", "fixtures", "mermaid_corpus");

function listCorpusCases(): string[] {
  return fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".excalidraw.json"))
    .map((f) => f.replace(/\.excalidraw\.json$/, ""))
    .filter((stem) => fs.existsSync(path.join(CORPUS_DIR, `${stem}.mermaid`)))
    .sort();
}

describe("excalidrawToMermaid (corpus parity with Python)", () => {
  const cases = listCorpusCases();

  it("found corpus cases on disk", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const stem of cases) {
    it(`produces byte-identical output for ${stem}`, () => {
      const jsonPath = path.join(CORPUS_DIR, `${stem}.excalidraw.json`);
      const mermaidPath = path.join(CORPUS_DIR, `${stem}.mermaid`);
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const expected = fs.readFileSync(mermaidPath, "utf-8");
      const actual = excalidrawToMermaid(data);
      expect(actual).toBe(expected);
    });
  }
});

describe("excalidrawToMermaid (edge cases)", () => {
  it("empty / non-dict input returns empty board", () => {
    const empty = "flowchart TD\n  %% empty board\n";
    expect(excalidrawToMermaid({})).toBe(empty);
    expect(excalidrawToMermaid({ elements: [] })).toBe(empty);
    expect(excalidrawToMermaid(null)).toBe(empty);
    expect(excalidrawToMermaid("nope" as unknown)).toBe(empty);
  });

  it("deleted elements are skipped", () => {
    const out = excalidrawToMermaid({
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 80, height: 40, isDeleted: true },
        { id: "r2", type: "rectangle", x: 200, y: 0, width: 80, height: 40 },
      ],
    });
    expect(out).toContain("N1[Untitled]");
    expect(out).not.toContain("N2");
  });

  it("label with special chars gets wrapped in quotes", () => {
    const out = excalidrawToMermaid({
      elements: [
        { id: "r1", type: "rectangle", x: 0, y: 0, width: 200, height: 40 },
        { id: "t1", type: "text", x: 10, y: 10, width: 100, height: 20, text: "a[b]c" },
      ],
    });
    expect(out).toContain('N1["a[b]c"]');
  });
});
