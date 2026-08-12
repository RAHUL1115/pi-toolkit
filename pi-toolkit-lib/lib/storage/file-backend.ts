import { mkdir, readFile, rename, unlink, writeFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RawBackend } from "./types.js";

export interface FileBackendOptions {
  dir: string;
}

export function createFileBackend(options: FileBackendOptions): RawBackend {
  const { dir } = options;
  let ensured = false;

  async function ensureDir() {
    if (ensured) return;
    await mkdir(dir, { recursive: true });
    ensured = true;
  }

  function pathFor(name: string): string {
    return join(dir, name);
  }

  return {
    async read(name) {
      try {
        return await readFile(pathFor(name), "utf8");
      } catch {
        return undefined;
      }
    },

    async write(name, content) {
      await ensureDir();
      const target = pathFor(name);
      // Unique temp name per process/call: concurrent sessions sharing this
      // directory must not clobber each other's temp file (rename ENOENT).
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, "utf8");
        await rename(temp, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Directory may have been removed after ensureDir() cached it.
          ensured = false;
          await ensureDir();
          await writeFile(temp, content, "utf8");
          await rename(temp, target);
          return;
        }
        await unlink(temp).catch(() => {});
        throw err;
      }
    },

    async append(name, line) {
      await ensureDir();
      await appendFile(pathFor(name), `${line}\n`, "utf8");
    },

    async readLines(name, options) {
      const text = await this.read(name);
      if (!text) return [];
      const lines = text.split("\n").filter((l) => l.trim());
      if (options?.last !== undefined && options.last > 0) {
        return lines.slice(-options.last);
      }
      return lines;
    },

    async trimLines(name, keepLast) {
      const lines = await this.readLines(name);
      if (lines.length <= keepLast) return;
      const kept = lines.slice(-keepLast);
      await this.write(name, kept.map((l) => `${l}\n`).join(""));
    },
  };
}
