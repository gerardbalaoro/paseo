import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { holdFileUploadResponse } from "../support/helpers/file-upload-gate";
import { TerminalE2EHarness } from "../support/helpers/terminal-dsl";
import { getTerminalBufferText, waitForTerminalContent } from "../support/helpers/terminal-perf";

const OSC11_CAPTURE_SCRIPT = `
let captured = Buffer.alloc(0);

function finish() {
  process.stdout.write("PASEO_OSC11_CAPTURE:" + JSON.stringify(captured.toString("latin1")) + "\\n");
  process.exit(0);
}

process.stdout.write("\\x1b]11;?\\x07");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  captured = Buffer.concat([captured, chunk]);
  if (captured.includes(Buffer.from("rgb:"))) {
    finish();
  }
});
setTimeout(finish, 700);
`;

// A TUI stand-in: turns on bracketed paste, reads every pasted quoted path, and
// echoes typed lines, so the PTY output proves what reached the terminal.
const IMAGE_RECEIVER_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
let buffer = "";
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?2004hIMAGE_RECEIVER_READY\r\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const paste = /(\x1b\[200~)?'([^']*)'(\x1b\[201~)?/.exec(buffer);
    if (!paste || (paste[1] && !paste[3])) break;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(paste[2])).digest("hex");
    const location = /[\\/]uploads[\\/]upload_/.test(paste[2]) ? "upload" : "elsewhere";
    const mode = paste[1] ? "bracketed" : "plain";
    process.stdout.write("IMAGE_READ:" + digest + ":" + location + ":" + mode + "\r\n");
    buffer = buffer.slice(0, paste.index) + buffer.slice(paste.index + paste[0].length);
  }
  if (buffer.includes("\x03")) {
    process.stdout.write("INTERRUPTED\r\n");
    buffer = buffer.replaceAll("\x03", "");
  }
  const enter = buffer.indexOf("\r");
  if (enter >= 0 && !buffer.includes("'")) {
    process.stdout.write("TYPED:" + buffer.slice(0, enter) + "\r\n");
    buffer = buffer.slice(enter + 1);
  }
});
`;

function pngBytes(seed: number): Buffer {
  return Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), Buffer.from([seed])]);
}

function imageRead(bytes: Buffer): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `IMAGE_READ:${digest}:upload:bracketed`;
}

function terminalInput(page: Page) {
  return page.locator('[data-testid="terminal-surface"] .xterm-helper-textarea');
}

async function pasteImage(page: Page, bytes: Buffer): Promise<void> {
  await terminalInput(page).evaluate(
    (element, data) => {
      (element as HTMLTextAreaElement).focus();
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array(data)], "image.png", { type: "image/png" }));
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    },
    [...bytes],
  );
}

async function dropFiles(page: Page, files: Array<{ name: string; type: string; bytes: Buffer }>) {
  await terminalInput(page).evaluate(
    (element, entries) => {
      const dataTransfer = new DataTransfer();
      for (const entry of entries) {
        dataTransfer.items.add(
          new File([new Uint8Array(entry.bytes)], entry.name, { type: entry.type }),
        );
      }
      element.dispatchEvent(
        new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }),
      );
    },
    files.map((file) => ({ ...file, bytes: [...file.bytes] })),
  );
}

async function typeLine(page: Page, text: string): Promise<void> {
  await terminalInput(page).pressSequentially(text);
  await terminalInput(page).press("Enter");
}

test.describe("Terminal protocol queries", () => {
  let harness: TerminalE2EHarness;

  test.beforeAll(async () => {
    harness = await TerminalE2EHarness.create({ tempPrefix: "terminal-protocol-query-" });
    await writeFile(path.join(harness.tempRepo.path, "osc11-capture.cjs"), OSC11_CAPTURE_SCRIPT);
    await writeFile(path.join(harness.tempRepo.path, "image-receiver.cjs"), IMAGE_RECEIVER_SCRIPT);
  });

  test.afterAll(async () => {
    await harness?.cleanup();
  });

  test("does not send browser OSC 11 color-query replies back to the PTY", async ({ page }) => {
    const terminalInstance = await harness.createTerminal({ name: "osc11-query" });
    try {
      await harness.openTerminal(page, { terminalId: terminalInstance.id });
      await harness.setupPrompt(page);

      const terminal = harness.terminalSurface(page);
      await terminal.pressSequentially("node osc11-capture.cjs\n", { delay: 0 });

      await waitForTerminalContent(page, (text) => text.includes("PASEO_OSC11_CAPTURE:"), 10_000);
      await page.waitForTimeout(500);

      const text = await getTerminalBufferText(page);

      expect(text).toContain("rgb:0b0b/0b0b/0b0b");
      expect(text).not.toContain("rgb:ffff/ffff/ffff");
    } finally {
      await harness.killTerminal(terminalInstance.id);
    }
  });

  async function openImageReceiver(page: Page, name: string) {
    const terminal = await harness.createTerminal({
      name,
      command: process.execPath,
      args: ["image-receiver.cjs"],
    });
    await harness.openTerminal(page, { terminalId: terminal.id });
    await expectTerminalOutput(terminal.id, "IMAGE_RECEIVER_READY");
    return terminal;
  }

  // Reads the PTY itself, so output from one pane cannot satisfy another's check.
  async function terminalOutput(terminalId: string): Promise<string> {
    const capture = await harness.client.captureTerminal(terminalId);
    return capture.lines.join("").replace(/\s/g, "");
  }

  async function expectTerminalOutput(terminalId: string, text: string): Promise<void> {
    await expect.poll(() => terminalOutput(terminalId), { timeout: 10_000 }).toContain(text);
  }

  test("pastes images from two panes into their own terminals as uploaded host files", async ({
    page,
  }) => {
    const secondPage = await page.context().newPage();
    const first = await openImageReceiver(page, "image-paste-a");
    const second = await openImageReceiver(secondPage, "image-paste-b");
    try {
      await Promise.all([pasteImage(page, pngBytes(1)), pasteImage(secondPage, pngBytes(2))]);

      await expectTerminalOutput(first.id, imageRead(pngBytes(1)));
      await expectTerminalOutput(second.id, imageRead(pngBytes(2)));
      expect(await terminalOutput(first.id)).not.toContain(imageRead(pngBytes(2)));
      expect(await terminalOutput(second.id)).not.toContain(imageRead(pngBytes(1)));
    } finally {
      await secondPage.close();
      await harness.killTerminal(first.id);
      await harness.killTerminal(second.id);
    }
  });

  test("drops an image as an uploaded host file", async ({ page }) => {
    const terminal = await openImageReceiver(page, "image-drop");
    try {
      await dropFiles(page, [
        { name: "shot.png", type: "image/png", bytes: pngBytes(3) },
        { name: "notes.txt", type: "text/plain", bytes: Buffer.from("notes") },
      ]);

      await expectTerminalOutput(terminal.id, imageRead(pngBytes(3)));
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("lands image pastes in gesture order while typing stays live", async ({ page }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openImageReceiver(page, "image-order");
    try {
      await pasteImage(page, pngBytes(4));
      await upload.waitUntilHeld();
      await pasteImage(page, pngBytes(5));
      await expect(page.getByTestId("terminal-image-uploading")).toHaveText("Uploading image…");

      await typeLine(page, "describe");
      await expectTerminalOutput(terminal.id, "TYPED:describe");

      upload.release();
      await expectTerminalOutput(terminal.id, imageRead(pngBytes(5)));
      const output = await terminalOutput(terminal.id);
      expect(output.indexOf(imageRead(pngBytes(4)))).toBeGreaterThanOrEqual(0);
      expect(output.indexOf(imageRead(pngBytes(4)))).toBeLessThan(
        output.indexOf(imageRead(pngBytes(5))),
      );
      await expect(page.getByTestId("terminal-image-uploading")).toHaveCount(0);
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("Ctrl+C abandons an image paste that is still uploading", async ({ page }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openImageReceiver(page, "image-cancel");
    try {
      await pasteImage(page, pngBytes(6));
      await upload.waitUntilHeld();

      await terminalInput(page).press("Control+c");
      await expectTerminalOutput(terminal.id, "INTERRUPTED");
      await expect(page.getByTestId("terminal-image-uploading")).toHaveCount(0);
      upload.release();

      await pasteImage(page, pngBytes(7));
      await expectTerminalOutput(terminal.id, imageRead(pngBytes(7)));
      expect(await terminalOutput(terminal.id)).not.toContain(imageRead(pngBytes(6)));
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });

  test("a disconnect during upload reports one failure and input keeps working", async ({
    page,
  }) => {
    const upload = await holdFileUploadResponse(page);
    const terminal = await openImageReceiver(page, "image-disconnect");
    try {
      await pasteImage(page, pngBytes(8));
      await upload.waitUntilHeld();

      await upload.disconnect();
      await expect(page.getByTestId("app-toast-message")).toHaveText("Failed to paste image");

      await typeLine(page, "after");
      await expectTerminalOutput(terminal.id, "TYPED:after");
      expect(await terminalOutput(terminal.id)).not.toContain(imageRead(pngBytes(8)));
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });
});
