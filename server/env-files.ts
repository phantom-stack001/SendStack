import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

export type EnvValueSource = "process" | string;

export type EnvFileLoadResult = {
  files: string[];
  sources: Record<string, EnvValueSource>;
};

const preexistingKeys = new Set(Object.keys(process.env));
let loadResult: EnvFileLoadResult = { files: [], sources: {} };

function applyParsedFile(path: string, sources: Record<string, EnvValueSource>) {
  if (!existsSync(path)) return;
  const parsed = parse(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    if (preexistingKeys.has(key)) {
      sources[key] ??= "process";
      continue;
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      sources[key] = path;
    }
  }
}

/**
 * Load one server env file without replacing variables already set in the process.
 * `--production` or SENDSTACK_ENV_FILE selects that file. Otherwise `.env` is used.
 * A selected file does not fall back to `.env`, so a missing key stays missing.
 */
export function loadConfiguredEnvFiles(): EnvFileLoadResult {
  const sources: Record<string, EnvValueSource> = {};
  const files: string[] = [];
  const explicit = process.env.SENDSTACK_ENV_FILE?.trim();
  if (explicit) {
    files.push(explicit);
  } else if (process.argv.includes("--production")) {
    files.push(".env.production");
  } else {
    files.push(".env");
  }
  for (const file of files) {
    applyParsedFile(file, sources);
  }
  loadResult = { files, sources };
  return loadResult;
}

export function getEnvFileLoadResult() {
  return loadResult;
}

export function envValueSource(key: string): EnvValueSource | "missing" {
  if (preexistingKeys.has(key) && process.env[key] !== undefined) return "process";
  return loadResult.sources[key] ?? "missing";
}
