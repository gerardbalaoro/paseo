import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import {
  extractTerminalDropPaths,
  isTerminalDragLeaveOutside,
  isTerminalFileDrag,
  prepareDroppedPathForTerminal,
  prepareDroppedPathsForTerminal,
} from "./terminal-file-drop";

function dataTransfer(input: { types?: string[]; files?: File[] }): DataTransfer {
  return {
    types: input.types ?? [],
    files: input.files ?? [],
  } as unknown as DataTransfer;
}

function fakeFile(input: { name: string; legacyPath?: string }): File {
  const file = { name: input.name } as unknown as File;
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
    const file = fakeFile({ name: "notes.txt" });
    const getPathForFile = vi.fn(() => "/Users/me/Desktop/notes.txt");
    const bridge: DesktopHostBridge = { webUtils: { getPathForFile } };

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), bridge),
    ).toEqual(["/Users/me/Desktop/notes.txt"]);
    expect(getPathForFile).toHaveBeenCalledWith(file);
  });

  it("falls back to legacy Electron file paths", () => {
    const file = fakeFile({ name: "notes.txt", legacyPath: "/tmp/legacy-notes.txt" });
    const bridge: DesktopHostBridge = {
      webUtils: {
        getPathForFile: vi.fn(() => {
          throw new Error("not available");
        }),
      },
    };

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), bridge),
    ).toEqual(["/tmp/legacy-notes.txt"]);
  });

  it("drops browser files that have no filesystem path", () => {
    const file = fakeFile({ name: "notes.txt" });

    expect(
      extractTerminalDropPaths(dataTransfer({ types: ["Files"], files: [file] }), null),
    ).toEqual([]);
  });

  it("prepares POSIX paths with conservative escaping", () => {
    const bridge: DesktopHostBridge = { platform: "darwin" };

    expect(prepareDroppedPathForTerminal("/tmp/my image.png", bridge)).toBe("'/tmp/my image.png'");
    expect(prepareDroppedPathForTerminal("/tmp/a$(touch bad).png", bridge)).toBe(
      "'/tmp/a(touch bad).png'",
    );
    expect(prepareDroppedPathForTerminal("/tmp/it's.png", bridge)).toBe("'/tmp/it\\'s.png'");
  });

  it("prepares Windows paths with space quoting", () => {
    const bridge: DesktopHostBridge = { platform: "win32" };

    expect(prepareDroppedPathForTerminal("C:\\Users\\me\\photo.png", bridge)).toBe(
      "C:\\Users\\me\\photo.png",
    );
    expect(prepareDroppedPathForTerminal("C:\\Users\\me\\photo one.png", bridge)).toBe(
      '"C:\\Users\\me\\photo one.png"',
    );
  });

  it("joins multiple dropped paths for one terminal input", () => {
    const bridge: DesktopHostBridge = { platform: "darwin" };

    expect(prepareDroppedPathsForTerminal(["/tmp/a.png", "/tmp/b c.png"], bridge)).toBe(
      "'/tmp/a.png' '/tmp/b c.png'",
    );
  });
});

it("never inserts client-local image paths from mixed drops", () => {
  const files = [
    new File(["png"], "photo.PNG", { type: "image/png" }),
    new File(["jpeg"], "photo.jpeg"),
    new File(["gif"], "animation.gif", { type: "image/gif" }),
    new File(["text"], "notes.txt", { type: "text/plain" }),
  ];
  const bridge: DesktopHostBridge = {
    webUtils: { getPathForFile: (file) => `/client/${file.name}` },
  };
  expect(extractTerminalDropPaths(dataTransfer({ files }), bridge)).toEqual(["/client/notes.txt"]);
});
