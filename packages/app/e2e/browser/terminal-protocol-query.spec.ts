import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
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

// Real PTY consumer: acknowledgement deliberately precedes file consumption, so
// a page reload/reconnect cannot masquerade as proof that the image was read.
const IMAGE_RECEIVER_SCRIPT = `
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
let pending = '', imagePath;
function readImage(prefix) {
  const bytes = fs.readFileSync(imagePath);
  const mode = fs.statSync(imagePath).mode & 0o777;
  process.stdout.write(prefix + crypto.createHash('sha256').update(bytes).digest('hex') + ':' + mode.toString(8) + '\\r\\n');
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('IMAGE_RECEIVER_READY\\r\\n');
process.stdin.on('data', chunk => {
  if (chunk.toString() === 'e') { process.stdout.write('\\x1b[?2004hIMAGE_ENABLED\\r\\n'); return; }
  if (chunk.toString() === 'd') { process.stdout.write('\\x1b[?2004lIMAGE_DISABLED\\r\\n'); return; }
  pending += chunk.toString();
  let end = pending.indexOf('\\x1b[201~');
  while (end >= 0) {
    const start = pending.indexOf('\\x1b[200~');
    const reference = pending.slice(start + 6, end);
    if (start < 0 || reference.length < 3) throw new Error('Empty image file reference');
    imagePath = reference.startsWith('file:') ? fileURLToPath(reference) : reference.slice(1, -1);
    pending = pending.slice(end + 6);
    process.stdout.write('IMAGE_STAGED\\r\\n');
    if (process.argv.includes('--read-on-arrival')) readImage('DROP_READ:');
    end = pending.indexOf('\\x1b[201~');
  }
  if (imagePath && pending.includes('r')) {
    readImage('IMAGE_READ:');
    pending = '';
  }
  if (pending.includes('\\r')) { process.stdout.write((imagePath ? 'ENTER_AFTER_IMAGE' : 'ENTER_WITHOUT_IMAGE') + '\\r\\n'); pending = ''; }
});
`;

async function expectCapturedImageOutput(
  harness: TerminalE2EHarness,
  terminalId: string,
  output: string,
) {
  // The browser's __paseoTerminal hook is global and can point at another mounted
  // tab. Read the exact PTY to prove uploads cannot cross terminal boundaries.
  await expect
    .poll(
      async () => {
        const capture = await harness.client.captureTerminal(terminalId);
        return capture.lines.join("").replace(/\s/g, "");
      },
      { timeout: 10_000 },
    )
    .toContain(output);
}

async function pasteImageInTerminal(
  target: Page,
  harness: TerminalE2EHarness,
  terminalId: string,
  payload: Buffer,
) {
  await harness.openTerminal(target, { terminalId: terminalId });
  await expectCapturedImageOutput(harness, terminalId, "IMAGE_RECEIVER_READY");
  // Change modes after attachment: a replay-time cache still says disabled.
  harness.client.sendTerminalInput(terminalId, { type: "input", data: "e" });
  await expectCapturedImageOutput(harness, terminalId, "IMAGE_ENABLED");
  await dispatchImagePaste(target, payload);
  await expectCapturedImageOutput(harness, terminalId, "IMAGE_STAGED");
  await target.locator('[data-testid="terminal-surface"] .xterm-helper-textarea').press("Enter");
  await expectCapturedImageOutput(harness, terminalId, "ENTER_AFTER_IMAGE");
}

async function dispatchImagePaste(target: Page, payload: Buffer, enter = false) {
  await target.locator('[data-testid="terminal-surface"] .xterm-helper-textarea').evaluate(
    (element, { bytes, enter: submit }) => {
      (element as HTMLTextAreaElement).focus();
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      if (submit)
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    { bytes: [...payload], enter },
  );
}

async function dispatchImageDrop(target: Page, payloads: Buffer[], mixed = false) {
  await target.locator('[data-testid="terminal-surface"] .xterm-helper-textarea').evaluate(
    (element, { images, mixed: includeTextFile }) => {
      const dataTransfer = new DataTransfer();
      for (const bytes of images) {
        dataTransfer.items.add(
          new File([new Uint8Array(bytes)], "local-only.png", { type: "image/png" }),
        );
      }
      if (includeTextFile)
        dataTransfer.items.add(new File(["ordinary file"], "notes.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }),
      );
    },
    { images: payloads.map((payload) => [...payload]), mixed },
  );
}

async function delayImageRequest(page: Page) {
  let release: (() => void) | undefined;
  let held!: () => void;
  const pending = new Promise<void>((resolve) => {
    held = resolve;
  });
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    server.onMessage((message) => browser.send(message));
    browser.onMessage((message) => {
      let type: unknown;
      try {
        const envelope = JSON.parse(message.toString());
        type = (envelope.message ?? envelope).type;
      } catch {
        /* Binary terminal input passes through. */
      }
      if (!release && type === "terminal.clipboard.write_image.request") {
        release = () => server.send(message);
        held();
      } else server.send(message);
    });
  });
  return { pending, release: () => release?.() };
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

  test("routes two pane image pastes to private files that survive browser reconnect", async ({
    page,
  }) => {
    const secondPage = await page.context().newPage();
    const terminals = await Promise.all(
      ["image-a", "image-b"].map((name) =>
        harness.createTerminal({ name, command: process.execPath, args: ["image-receiver.cjs"] }),
      ),
    );
    const payloads = [
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
        "base64",
      ),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC",
        "base64",
      ),
    ];
    try {
      await Promise.all([
        pasteImageInTerminal(page, harness, terminals[0]!.id, payloads[0]!),
        pasteImageInTerminal(secondPage, harness, terminals[1]!.id, payloads[1]!),
      ]);
      harness.client.sendTerminalInput(terminals[0]!.id, { type: "input", data: "d" });
      await expectCapturedImageOutput(harness, terminals[0]!.id, "IMAGE_DISABLED");
      await dispatchImagePaste(page, payloads[0]!);
      await expect(page.getByTestId("app-toast-message")).toContainText(
        "This program does not accept image file pastes.",
      );
      await page.reload();
      await harness.openTerminal(page, { terminalId: terminals[0]!.id });
      await expectCapturedImageOutput(harness, terminals[0]!.id, "IMAGE_STAGED");
      for (const [index, payload] of payloads.entries()) {
        // Release the fixture consumer only after the browser reconnects.
        harness.client.sendTerminalInput(terminals[index]!.id, { type: "input", data: "r" });
        const digest = createHash("sha256").update(payload).digest("hex");
        await expectCapturedImageOutput(harness, terminals[index]!.id, `IMAGE_READ:${digest}:600`);
      }
    } finally {
      await secondPage.close();
      await Promise.all(terminals.map((terminal) => harness.killTerminal(terminal.id)));
    }
  });
  for (const gesture of ["paste", "drop"] as const) {
    test(`${gesture} shows upload progress while typing and submission stay live`, async ({
      page,
    }, testInfo) => {
      const gate = await delayImageRequest(page);
      const terminal = await harness.createTerminal({
        name: "background-image",
        command: process.execPath,
        args: ["image-receiver.cjs"],
      });
      try {
        await harness.openTerminal(page, { terminalId: terminal.id });
        await expectCapturedImageOutput(harness, terminal.id, "IMAGE_RECEIVER_READY");
        harness.client.sendTerminalInput(terminal.id, { type: "input", data: "e" });
        await expectCapturedImageOutput(harness, terminal.id, "IMAGE_ENABLED");
        const payload = Buffer.from("iVBORw0KGgo=", "base64");
        if (gesture === "drop") await dispatchImageDrop(page, [payload]);
        else await dispatchImagePaste(page, payload);
        await gate.pending;
        await expect(page.getByTestId("terminal-image-uploading")).toHaveText("Uploading image…");
        const input = page.locator('[data-testid="terminal-surface"] .xterm-helper-textarea');
        await input.pressSequentially("describe");
        await input.press("Enter");
        await expectCapturedImageOutput(harness, terminal.id, "ENTER_WITHOUT_IMAGE");
        await page.screenshot({ path: testInfo.outputPath("uploading-image.png") });
        gate.release();
        await expectCapturedImageOutput(harness, terminal.id, "IMAGE_STAGED");
        await expect(page.getByTestId("terminal-image-uploading")).toHaveCount(0);
      } finally {
        await harness.killTerminal(terminal.id);
      }
    });
  }
  test("multiple, repeated and mixed image drops deliver remote readable private files", async ({
    page,
  }) => {
    const terminal = await harness.createTerminal({
      name: "image-drops",
      command: process.execPath,
      args: ["image-receiver.cjs", "--read-on-arrival"],
    });
    const payloads = [1, 2, 3].map((value) =>
      Buffer.concat([Buffer.from("iVBORw0KGgo=", "base64"), Buffer.from([value])]),
    );
    try {
      await harness.openTerminal(page, { terminalId: terminal.id });
      await expectCapturedImageOutput(harness, terminal.id, "IMAGE_RECEIVER_READY");
      harness.client.sendTerminalInput(terminal.id, { type: "input", data: "e" });
      await expectCapturedImageOutput(harness, terminal.id, "IMAGE_ENABLED");
      await dispatchImageDrop(page, payloads.slice(0, 2), true);
      await dispatchImageDrop(page, payloads.slice(2));
      for (const payload of payloads) {
        await expectCapturedImageOutput(
          harness,
          terminal.id,
          `DROP_READ:${createHash("sha256").update(payload).digest("hex")}:600`,
        );
      }
      await expect(page.getByTestId("terminal-image-uploading")).toHaveCount(0);
      await dispatchImageDrop(page, [Buffer.from("invalid image")]);
      await expect(page.getByTestId("app-toast-message")).toBeVisible();
      await page.locator('[data-testid="terminal-surface"] .xterm-helper-textarea').press("Enter");
      await expectCapturedImageOutput(harness, terminal.id, "ENTER_AFTER_IMAGE");
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });
  test("failed image paste does not gate terminal submission", async ({ page }) => {
    const terminal = await harness.createTerminal({
      name: "image-failure",
      command: process.execPath,
      args: ["image-receiver.cjs"],
    });
    try {
      await harness.openTerminal(page, { terminalId: terminal.id });
      await expectCapturedImageOutput(harness, terminal.id, "IMAGE_RECEIVER_READY");
      await dispatchImagePaste(page, Buffer.from("iVBORw0KGgo=", "base64"), true);
      await expect(page.getByTestId("app-toast-message")).toContainText(
        "This program does not accept image file pastes.",
      );
      await expectCapturedImageOutput(harness, terminal.id, "ENTER_WITHOUT_IMAGE");
    } finally {
      await harness.killTerminal(terminal.id);
    }
  });
});
