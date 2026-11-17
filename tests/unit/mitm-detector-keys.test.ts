import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("MITM detector dispatch keys are unique", () => {
  const path = new URL("../../src/mitm/detection/index.ts", import.meta.url);
  const source = ts.createSourceFile(
    path.pathname,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const keys: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "DETECTORS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        assert.ok(property.name);
        keys.push(property.name.getText(source).replace(/^"|"$/g, ""));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(keys.includes("ghe-copilot"));
  assert.equal(new Set(keys).size, keys.length, "duplicate detector dispatch key");
});
