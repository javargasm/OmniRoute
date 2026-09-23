import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const CALLER_RUNTIME_IMPORTS = [
  {
    file: "src/mitm/inspector/conversationNormalizer.ts",
    imports: ['import { mergeStream, parseSseStream } from "./sseMerger.ts";'],
  },
  {
    file: "src/mitm/inspector/llmMetadataExtractor.ts",
    imports: [
      'import { detectKind } from "./kindDetector.ts";',
      'import { estimateCost } from "./pricing.ts";',
      'import { mergeStream, parseSseStream } from "./sseMerger.ts";',
    ],
  },
  {
    file: "src/mitm/cert/generate.ts",
    imports: [
      'import { resolveMitmDataDir } from "../dataDir.ts";',
      'import { ANTIGRAVITY_TARGET } from "../targets/antigravity.ts";',
    ],
  },
  {
    file: "src/mitm/cert/install.ts",
    imports: [
      'import {\n  execFileText,\n  execFileWithPassword,\n  getErrorMessage,\n  quotePowerShell,\n  runElevatedPowerShell,\n} from "../systemCommands.ts";',
    ],
  },
  {
    file: "src/mitm/detection/index.ts",
    imports: [
      'import { detectAntigravity } from "./antigravity.ts";\n' +
        'import { detectKiro } from "./kiro.ts";',
      'import { detectCopilot } from "./copilot.ts";',
      'import { detectCodex } from "./codex.ts";',
      'import { detectCursor } from "./cursor.ts";',
      'import { detectZed } from "./zed.ts";',
      'import { detectClaudeCode } from "./claudeCode.ts";',
      'import { detectOpenCode } from "./openCode.ts";',
    ],
  },
  {
    file: "src/mitm/dns/dnsConfig.ts",
    imports: [
      'import {\n  execFileWithPassword,\n  isRoot,\n  quotePowerShell,\n  runElevatedPowerShell,\n} from "../systemCommands.ts";',
      'import { ALL_TARGETS } from "../targets/index.ts";',
    ],
  },
  {
    file: "src/mitm/inspector/buffer.ts",
    imports: [
      'import { computeContextKey } from "./contextKey.ts";',
      'import { detectKind } from "./kindDetector.ts";',
    ],
  },
  {
    file: "src/mitm/inspector/httpProxyServer.ts",
    imports: ['import { sanitizeHeaders } from "../sanitizeHeaders.ts";'],
  },
] as const;

test("MITM webpack callers use TypeScript runtime import specifiers", () => {
  for (const { file, imports } of CALLER_RUNTIME_IMPORTS) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const runtimeImport of imports) {
      assert.ok(
        source.includes(runtimeImport),
        `${file} must retain the TypeScript runtime import: ${runtimeImport}`
      );
    }
  }
});

test("MITM imports do not use .js specifiers for TypeScript source files", () => {
  const mitmRoot = join(process.cwd(), "src/mitm");
  const pending = [mitmRoot];

  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!entry.isFile() || !file.endsWith(".ts")) continue;

      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from\s*|import\s*\()["'](\.{1,2}\/[^"']+)\.js["']/g)) {
        const specifier = match[1];
        const tsTarget = resolve(dirname(file), `${specifier}.ts`);
        assert.ok(
          !existsSync(tsTarget),
          `${relative(process.cwd(), file)} must import ${relative(process.cwd(), tsTarget)} as .ts`
        );
      }
    }
  }
});
