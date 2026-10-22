import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import {
  extractTerminalDropPaths,
  isTerminalDragLeaveOutside,
  isTerminalFileDrag,
  prepareDroppedPathsForTerminal,
  prepareTerminalPath,
} from "./terminal-file-drop";

function dataTransfer(input: { types?: string[]; files?: File[] }): DataTransfer {
  return {
    types: input.types ?? [],
    files: input.files ?? [],
  } as unknown as DataTransfer;
}

function fakeFile(input: { name: string; type?: string; legacyPath?: string }): File {
  const file = { name: input.name, type: input.type ?? "" } as unknown as File;
  if (input.legacyPath !== undefined) {
    Object.defineProperty(file, "path", {
      configurable: true,
      value: input.legacyPath,
    });
  }
  return file;
}

function makeNode(children: readonly EventTarget[] = []): EventTarget {
  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    contains: (other: EventTarget | null) => other !== null && children.includes(other),
  } as unknown as EventTarget;
}

describe("terminal file drop", () => {
  it("detects file drags", () => {
    expect(isTerminalFileDrag(dataTransfer({ types: ["Files"] }))).toBe(true);
    expect(isTerminalFileDrag(dataTransfer({ types: ["text/plain"] }))).toBe(false);
    expect(isTerminalFileDrag(null)).toBe(false);
  });

  it("keeps drag highlight active when moving between terminal children", () => {
    const child = makeNode();
    const outside = makeNode();
    const root = makeNode([child]);

    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: child })).toBe(false);
    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: outside })).toBe(true);
    expect(isTerminalDragLeaveOutside({ currentTarget: root, relatedTarget: null })).toBe(true);
    expect(isTerminalDragLeaveOutside({ currentTarget: null, relatedTarget: child })).toBe(true);
  });

  it("extracts paths through Electron webUtils", () => {
    const file = fakeFile({ name: "photo.png" });
    const getPathForFile = vi.fn(() => "/Users/me/Desktop/photo.png");
    const bridge: DesktopHostBridge = { webUtils: { getPathForFile } };

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), bridge),
    ).toEqual(["/Users/me/Desktop/photo.png"]);
    expect(getPathForFile).toHaveBeenCalledWith(file);
  });

  it("falls back to legacy Electron file paths", () => {
    const file = fakeFile({ name: "photo.png", legacyPath: "/tmp/legacy-photo.png" });
    const bridge: DesktopHostBridge = {
      webUtils: {
        getPathForFile: vi.fn(() => {
          throw new Error("not available");
        }),
      },
    };

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), bridge),
    ).toEqual(["/tmp/legacy-photo.png"]);
  });

  it("drops browser files that have no filesystem path", () => {
    const file = fakeFile({ name: "photo.png" });

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), null),
    ).toEqual([]);
  });

  it("leaves image files out of the dropped paths", () => {
    const bridge: DesktopHostBridge = {
      webUtils: { getPathForFile: (file) => `/client/${file.name}` },
    };
    const files = [
      fakeFile({ name: "shot.png", type: "image/png" }),
      fakeFile({ name: "notes.txt", type: "text/plain" }),
    ];

    expect(extractTerminalDropPaths(dataTransfer({ types: ["Files"], files }), bridge)).toEqual([
      "/client/notes.txt",
    ]);
  });

  it("prepares POSIX paths with conservative escaping", () => {
    expect(prepareTerminalPath("/tmp/my image.png")).toBe("'/tmp/my image.png'");
    expect(prepareTerminalPath("/tmp/a$(touch bad).png")).toBe("'/tmp/a(touch bad).png'");
    expect(prepareTerminalPath("/tmp/it's.png")).toBe("'/tmp/it\\'s.png'");
  });

  it("prepares Windows paths with space quoting", () => {
    expect(prepareTerminalPath("C:\\Users\\me\\photo.png")).toBe("C:\\Users\\me\\photo.png");
    expect(prepareTerminalPath("C:\\Users\\me\\photo one.png")).toBe(
      '"C:\\Users\\me\\photo one.png"',
    );
    expect(prepareTerminalPath("\\\\server\\share\\photo one.png")).toBe(
      '"\\\\server\\share\\photo one.png"',
    );
  });

  it("joins multiple dropped paths for one terminal input", () => {
    expect(prepareDroppedPathsForTerminal(["/tmp/a.png", "/tmp/b c.png"])).toBe(
      "'/tmp/a.png' '/tmp/b c.png'",
    );
  });
});
