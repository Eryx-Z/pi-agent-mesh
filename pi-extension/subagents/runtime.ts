import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Reuse the current Pi installation, including standalone compiled binaries. */
export function piInvocation(packageDir: string, execPath = process.execPath): { command: string; baseArgs: string[] } {
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) {
    return { command: execPath, baseArgs: [] };
  }
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const cli = join(packageDir, manifest.bin.pi);
  if (!existsSync(cli)) throw new Error(`Pi CLI entrypoint not found: ${cli}`);
  return { command: execPath, baseArgs: [cli] };
}
