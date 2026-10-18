import { describe, expect, test } from "vitest";
import { TerminalPasteQueue } from "./terminal-paste-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let timeout = () => {};
  const output: string[] = [];
  const queue = new TerminalPasteQueue({
    schedule: (callback) => {
      timeout = callback;
      return () => {};
    },
  });
  const send = (data: string) => output.push(data);
  return { queue, output, send, expire: () => timeout() };
}

describe("terminal paste ordering", () => {
  test("sends typing and Enter during uploads without blocking another terminal", async () => {
    const a = setup();
    const b = setup();
    const upload = deferred<boolean>();
    const paste = a.queue.paste(() => upload.promise);
    a.queue.input("describe\r", a.send);
    b.queue.input("other\r", b.send);
    expect(a.output).toEqual(["describe\r"]);
    expect(b.output).toEqual(["other\r"]);
    a.send("image");
    upload.resolve(true);
    await paste;
    expect(a.output).toEqual(["describe\r", "image"]);
  });
  test("failure leaves already-sent text and Enter unchanged", async () => {
    const a = setup();
    const upload = deferred<boolean>();
    const paste = a.queue.paste(() => upload.promise);
    a.queue.input("describe\r\n", a.send);
    upload.resolve(false);
    await paste;
    expect(a.output).toEqual(["describe\r\n"]);
    a.queue.input("\r", a.send);
    expect(a.output).toEqual(["describe\r\n", "\r"]);
  });
  test("consecutive images remain ordered with intervening input", async () => {
    const a = setup();
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const one = a.queue.paste(() => first.promise);
    a.queue.input("a", a.send);
    const two = a.queue.paste(() => {
      a.send("second");
      return second.promise;
    });
    a.queue.input("\r", a.send);
    a.send("first");
    first.resolve(true);
    await one;
    expect(a.output).toEqual(["a", "\r", "first", "second"]);
    second.resolve(true);
    await two;
    expect(a.output).toEqual(["a", "\r", "first", "second"]);
  });
  test("timeout requests cancellation and waits for the authoritative outcome", async () => {
    const a = setup();
    const late = deferred<boolean>();
    let signal!: AbortSignal;
    const paste = a.queue.paste((value) => {
      signal = value;
      return late.promise;
    });
    a.queue.input("text\r", a.send);
    a.expire();
    expect(signal.aborted).toBe(true);
    expect(a.output).toEqual(["text\r"]);
    late.resolve(true);
    expect(await paste).toBe(true);
    expect(a.output).toEqual(["text\r"]);
  });
  test("Ctrl+C requests cancellation while input and Enter stay live", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const one = a.queue.paste(() => gate.promise);
    const two = a.queue.paste(async () => {
      a.send("unexpected");
      return true;
    });
    a.queue.input("text\r", a.send);
    a.queue.input("\x03", a.send);
    gate.resolve(false);
    expect(await one).toBe(false);
    expect(await two).toBe(false);
    expect(a.output).toEqual(["text\r", "\x03"]);
  });
  test("disconnect/disposal never replays queued input into a replacement connection", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const paste = a.queue.paste(() => gate.promise);
    a.queue.input("old\r", a.send);
    a.queue.dispose();
    gate.resolve(false);
    expect(await paste).toBe(false);
    await gate.promise;
    a.queue.input("new", a.send);
    expect(a.output).toEqual(["old\r", "new"]);
  });
  test("enhanced Enter actions remain live during uploads", async () => {
    const a = setup();
    const gate = deferred<boolean>();
    const paste = a.queue.paste(() => gate.promise);
    a.queue.action(() => {
      a.send("enhanced Enter");
    });
    gate.resolve(false);
    await paste;
    expect(a.output).toEqual(["enhanced Enter"]);
  });
});

test("failed paste never rewrites terminal key sequences", async () => {
  const a = setup();
  const gate = deferred<boolean>();
  const paste = a.queue.paste(() => gate.promise);
  a.queue.input("text\x1b[13;5u\x1b[27;2;13~\x1b[A", a.send);
  gate.resolve(false);
  await paste;
  expect(a.output).toEqual(["text\x1b[13;5u\x1b[27;2;13~\x1b[A"]);
});
