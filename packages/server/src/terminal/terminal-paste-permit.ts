import { mkdtempSync, writeFileSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalImageError } from "@getpaseo/protocol/terminal-image-error";

/** The rename/unlink race gives the parent and worker one atomic decision.
 * IPC cancellation alone cannot overtake a paste already queued in a stopped worker.
 * This directory contains no image data or paths; only an empty, single-use permit.
 */
export function createTerminalPastePermit() {
  const directory = mkdtempSync(join(tmpdir(), "paseo-paste-permit-"));
  const path = join(directory, "pending");
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  return {
    path,
    revoke(): boolean {
      try {
        unlinkSync(path);
        return true;
      } catch {
        // Missing means claimed; other I/O failures also cannot prove revocation.
        return false;
      }
    },
    dispose(): void {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Cleanup of an empty permit must not replace the authoritative paste outcome.
      }
    },
  };
}

export function claimTerminalPastePermit(path: string, deadline: number): void {
  if (Date.now() >= deadline)
    throw new TerminalImageError("upload_failed", "Image paste expired before insertion");
  try {
    renameSync(path, `${path}.claimed`);
  } catch {
    throw new TerminalImageError("upload_failed", "Image paste cancelled before insertion");
  }
}
