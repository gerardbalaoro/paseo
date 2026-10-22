import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import { prepareTerminalPath } from "../drop/terminal-file-drop";

/** Image bytes from a paste or drop gesture, before they become a file on the host. */
export interface TerminalImage {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** The pane's host and terminal: where an image is stored and where its path is pasted. */
export interface TerminalImagePasteTarget {
  /** Stores the image on the host and returns its host path. */
  upload(image: TerminalImage): Promise<string>;
  paste(text: string): void;
}

interface TerminalImagePasteEvents {
  onFailure(): void;
  onUploadingChange(uploading: boolean): void;
}

/**
 * Turns a pane's image gestures into pasted host paths, one at a time and in
 * gesture order. Ordinary input never waits on it.
 */
export class TerminalImagePasteQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private pending = 0;
  private uploading = false;

  constructor(private readonly events: TerminalImagePasteEvents) {}

  /** Queues a gesture. `image` resolves to null when the gesture carried no image. */
  add(image: Promise<TerminalImage | null>, target: TerminalImagePasteTarget): void {
    const generation = this.generation;
    this.pending += 1;
    this.tail = this.tail.then(() => this.paste(image, target, generation));
  }

  /** Drops queued and in-flight gestures. Returns whether any were dropped. */
  cancel(): boolean {
    const dropped = this.pending > 0;
    this.generation += 1;
    this.pending = 0;
    // A cancelled upload can stay unsettled until its connection resolves.
    this.tail = Promise.resolve();
    this.setUploading(false);
    return dropped;
  }

  private async paste(
    read: Promise<TerminalImage | null>,
    target: TerminalImagePasteTarget,
    generation: number,
  ): Promise<void> {
    const isCurrent = () => generation === this.generation;
    try {
      const image = await read;
      if (!image || !isCurrent()) {
        return;
      }
      if (image.bytes.byteLength > FILE_UPLOAD_MAX_BYTES) {
        throw new Error("Image exceeds the upload limit");
      }
      this.setUploading(true);
      const path = await target.upload({ ...image, fileName: toShellSafeFileName(image.fileName) });
      if (isCurrent()) {
        target.paste(prepareTerminalPath(path));
      }
    } catch {
      if (isCurrent()) {
        this.events.onFailure();
      }
    } finally {
      if (isCurrent()) {
        this.pending -= 1;
        this.setUploading(false);
      }
    }
  }

  private setUploading(uploading: boolean): void {
    if (this.uploading === uploading) {
      return;
    }
    this.uploading = uploading;
    this.events.onUploadingChange(uploading);
  }
}

// The host path is pasted into a shell or TUI; keep its last segment unquotable.
function toShellSafeFileName(fileName: string): string {
  return fileName.replace(/[^\w.-]/g, "_");
}

export async function readTerminalImageFile(
  file: Blob & { name?: string },
): Promise<TerminalImage> {
  return {
    fileName: file.name || `image.${imageExtension(file.type)}`,
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}

export function terminalImageFromBase64(input: {
  fileName: string;
  mimeType: string;
  data: string;
}): TerminalImage {
  const binary = atob(input.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { fileName: input.fileName, mimeType: input.mimeType, bytes };
}

const BASE64_CHUNK_SIZE = 0x8000;

export function terminalImageToBase64(image: TerminalImage): string {
  let binary = "";
  for (let offset = 0; offset < image.bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...image.bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

export function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(/[+;]/)[0] ?? "";
  if (subtype === "jpeg") {
    return "jpg";
  }
  return subtype || "png";
}
