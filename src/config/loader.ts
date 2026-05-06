import { parse, stringify } from "smol-toml";
import { sha256 } from "../provider/utils.js";
import {
  type CaseFile,
  CaseFileSchema,
  type MevConfig,
  MevConfigSchema,
  type TaskSpecFile,
} from "../types/index.js";

export async function loadConfig(path: string): Promise<MevConfig> {
  const file = Bun.file(path);
  const text = await file.text();
  const raw = parse(text);
  const config = MevConfigSchema.parse(raw);
  return config;
}

export async function saveConfig(config: MevConfig, path: string): Promise<void> {
  const raw = MevConfigSchema.parse(config);
  await Bun.write(path, stringify(raw as Record<string, unknown>));
}

export async function loadCase(path: string): Promise<CaseFile> {
  const file = Bun.file(path);
  const text = await file.text();
  const raw = parse(text);
  return CaseFileSchema.parse(raw);
}

export async function saveCase(caseFile: CaseFile, dir: string): Promise<string> {
  const filename = `${caseFile.id.padStart(4, "0")}.toml`;
  const filepath = `${dir}/${filename}`;
  await Bun.write(filepath, stringify(caseFile as Record<string, unknown>));
  return filepath;
}

export async function loadAllCases(dir: string): Promise<CaseFile[]> {
  const glob = new Bun.Glob("*.toml");
  const cases: CaseFile[] = [];
  for await (const file of glob.scan({ cwd: dir })) {
    const fullPath = `${dir}/${file}`;
    const c = await loadCase(fullPath);
    cases.push(c);
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadSpec(path: string): Promise<TaskSpecFile> {
  const file = Bun.file(path);
  const text = await file.text();
  return JSON.parse(text);
}

export async function saveSpec(spec: TaskSpecFile, path: string): Promise<void> {
  await Bun.write(path, JSON.stringify(spec, null, 2));
}

export function computeCaseSetSha(cases: ReadonlyArray<CaseFile>): string {
  const concatenated = cases
    .map((c) => `${c.id}::${c.input.content}`)
    .sort()
    .join("||");
  return sha256(concatenated);
}

export function computePromptSha(promptText: string): string {
  return sha256(promptText);
}
