import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { migrateSettings } from "./domain.js";
import type { SettingsConfig } from "./types.js";

const NAMESPACE = "pi-toolkit";
const FOOTER_KEY = "footer";
const DEFAULT_PATH = join(getAgentDir(), "settings.json");
const LEGACY_PATH = join(getAgentDir(), "observability", "settings.json");

type JsonObject = Record<string, unknown>;

export interface SettingsStorage {
  load(): Promise<unknown>;
  save(config: SettingsConfig): Promise<void>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function withSettingsLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, factor: 1, minTimeout: 20, maxTimeout: 20 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

export function createSettingsStorage(options?: {
  path?: string;
  legacyPath?: string;
}): SettingsStorage {
  const path = options?.path ?? DEFAULT_PATH;
  const legacyPath = options?.legacyPath ?? LEGACY_PATH;

  const storage: SettingsStorage = {
    async load() {
      const root = await withSettingsLock(path, () => readJsonObject(path));
      const toolkit = root?.[NAMESPACE];
      if (isJsonObject(toolkit) && toolkit[FOOTER_KEY] !== undefined) {
        await unlink(legacyPath).catch(() => {});
        return toolkit[FOOTER_KEY];
      }

      const legacy = await readJsonObject(legacyPath);
      if (legacy !== undefined) {
        await storage.save(migrateSettings(legacy));
        await unlink(legacyPath).catch(() => {});
        return legacy;
      }
      return undefined;
    },

    async save(config) {
      await withSettingsLock(path, async () => {
        const root = (await readJsonObject(path)) ?? {};
        const currentToolkit = root[NAMESPACE];
        root[NAMESPACE] = {
          ...(isJsonObject(currentToolkit) ? currentToolkit : {}),
          [FOOTER_KEY]: config,
        };
        await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
      });
    },
  };

  return storage;
}

export function createMemorySettingsStorage(initial?: unknown): SettingsStorage {
  let value = initial;
  return {
    async load() {
      return value;
    },
    async save(config) {
      value = structuredClone(config);
    },
  };
}

export async function loadSettings(storage: SettingsStorage): Promise<SettingsConfig> {
  try {
    return migrateSettings(await storage.load());
  } catch {
    return migrateSettings(undefined);
  }
}

export async function saveSettings(
  config: SettingsConfig,
  storage: SettingsStorage,
): Promise<void> {
  await storage.save(config);
}
