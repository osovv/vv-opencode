#!/usr/bin/env bun
// FILE: scripts/check-exports.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate package export source files and ensure discovered server/TUI plugin declarations have public export paths.
//   SCOPE: package.json subpath parsing, TypeScript/TSX source lookup, plugin declaration discovery, and pre-commit failure reporting.
//   DEPENDS: [node:fs, node:path, package.json]
//   LINKS: [M-RELEASE-AUTOMATION, V-M-RELEASE-AUTOMATION]
//   ROLE: SCRIPT
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   check-exports script - Verify root, server plugin, and TUI package subpaths before commit.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added TSX source lookup and TUI plugin export recognition.]
// END_CHANGE_SUMMARY

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
const PKG_PATH = new URL("../package.json", import.meta.url).pathname;

interface ExportEntry {
  types?: string;
  import: string;
}

interface PackageExports {
  [key: string]: ExportEntry | string;
}

interface PackageJson {
  name: string;
  exports: PackageExports;
}

interface PluginDeclaration {
  name: string;
  filePath: string;
  line: number;
}

function readPackageJson(): PackageJson {
  const content = readFileSync(PKG_PATH, "utf8");
  return JSON.parse(content) as PackageJson;
}

function getExportPaths(exports: PackageExports): Map<string, ExportEntry> {
  const paths = new Map<string, ExportEntry>();
  for (const [key, value] of Object.entries(exports)) {
    if (key === ".") continue;
    if (typeof value === "string") {
      paths.set(key, { import: value });
    } else {
      paths.set(key, value as ExportEntry);
    }
  }
  return paths;
}

function resolveDistPath(importPath: string): string | null {
  const match = importPath.match(/^\.\/dist\/(.+)\.js$/);
  if (!match) return null;
  const basePath = "src/" + match[1];
  for (const extension of [".ts", ".tsx"]) {
    const candidate = basePath + extension;
    if (checkExportExists(candidate).exists) return candidate;
  }
  return basePath + ".ts";
}

function findPluginDeclarations(): PluginDeclaration[] {
  const { globSync } = require("node:fs");

  const tsFiles = globSync("**/*.ts", {
    cwd: SRC_DIR,
    ignore: ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
  });

  const plugins: PluginDeclaration[] = [];

  for (const file of tsFiles) {
    const filePath = join(SRC_DIR, file);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(/^export\s+(?:const|function|class)\s+(\w+Plugin)\s*[:=]/);
      if (match) {
        plugins.push({
          name: match[1],
          filePath: file,
          line: i + 1,
        });
      }
    }
  }

  return plugins;
}

function getPluginExportPath(pluginFilePath: string): string | null {
  const match = pluginFilePath.match(/^plugins\/(.+)\/index\.ts$/);
  if (match) return `./plugins/${match[1]}`;
  if (pluginFilePath.startsWith("tui/")) return "./tui";
  return null;
}

function checkExportExists(filePath: string): { exists: boolean; reason?: string } {
  const fullPath = join(PKG_PATH.replace("package.json", ""), filePath);

  try {
    readFileSync(fullPath, "utf8");
    return { exists: true };
  } catch {
    return { exists: false, reason: `File not found: ${filePath}` };
  }
}

function main() {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pkg = readPackageJson();
  const exportPaths = getExportPaths(pkg.exports);

  console.log("Checking package.json exports...\n");

  for (const [exportKey, exportEntry] of exportPaths) {
    console.log(`  Checking export: ${exportKey}`);
    const resolved = resolveDistPath(exportEntry.import);
    if (!resolved) {
      errors.push(`  ✗ ${exportKey}: Cannot parse import path "${exportEntry.import}"`);
      continue;
    }

    const result = checkExportExists(resolved);
    if (result.exists) {
      console.log(`    ✓ ${resolved} exists`);
    } else {
      errors.push(`  ✗ ${exportKey}: ${result.reason}`);
    }
  }

  console.log("\nChecking Plugin declarations in codebase...\n");

  const plugins = findPluginDeclarations();

  for (const plugin of plugins) {
    console.log(`  Found: ${plugin.name} at ${plugin.filePath}:${plugin.line}`);
  }

  console.log("\nVerifying all *Plugin declarations have corresponding exports...\n");

  const rootIndexContent = readFileSync(join(SRC_DIR, "index.ts"), "utf8");

  for (const plugin of plugins) {
    const exportPath = getPluginExportPath(plugin.filePath);

    if (exportPath) {
      const hasPluginPathExport = exportPaths.has(exportPath);
      const rootExportMatch = new RegExp(`export\\s+{\\s*${plugin.name}\\s*}`).test(
        rootIndexContent,
      );

      if (hasPluginPathExport) {
        console.log(`  ✓ ${plugin.name}: exported via ${exportPath}`);
      } else if (rootExportMatch) {
        errors.push(`  ✗ ${plugin.name}: exported via root but missing ${exportPath} export path`);
      } else {
        errors.push(`  ✗ ${plugin.name}: not exported anywhere`);
      }
    } else {
      const rootExportMatch = new RegExp(`export\\s+{\\s*${plugin.name}\\s*}`).test(
        rootIndexContent,
      );
      if (rootExportMatch) {
        console.log(`  ✓ ${plugin.name}: exported via root (index.ts)`);
      } else {
        errors.push(`  ✗ ${plugin.name}: not exported anywhere`);
      }
    }
  }

  console.log("\n" + "=".repeat(50));

  if (errors.length > 0) {
    console.log("\nERRORS:");
    errors.forEach((e) => console.log(e));
  }

  if (warnings.length > 0) {
    console.log("\nWARNINGS:");
    warnings.forEach((w) => console.log(w));
  }

  if (errors.length === 0) {
    console.log("\n✓ All checks passed!");
    process.exit(0);
  } else {
    console.log(`\n✗ Found ${errors.length} error(s)`);
    process.exit(1);
  }
}

main();
