/** Serializes image gestures while ordinary terminal input remains live. */
export class TerminalPasteQueue {
  private pending: Array<{
    run: (signal: AbortSignal) => Promise<boolean>;
    resolve: (ok: boolean) => void;
  }> = [];
  private active: { abort: AbortController } | undefined;

  constructor(
    private readonly options: {
      timeoutMs?: number;
      schedule?: (callback: () => void, milliseconds: number) => () => void;
      onFailure?: () => void;
    } = {},
  ) {}

  input(data: string, send: (data: string) => void): void {
    // Ctrl+C explicitly cancels the pending paste, including queued image gestures.
    if (data.includes("\x03")) this.cancel();
    send(data);
  }

  action(send: () => void): void {
    send();
  }

  paste(run: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    return new Promise((resolve) => {
      this.pending.push({ run, resolve });
      this.drain();
    });
  }

  cancel(): void {
    for (const entry of this.pending) entry.resolve(false);
    this.pending = [];
    this.active?.abort.abort();
  }

  dispose(): void {
    for (const entry of this.pending) entry.resolve(false);
    this.pending = [];
    this.active?.abort.abort();
  }

  private drain(): void {
    if (this.active) return;
    const next = this.pending.shift();
    if (!next) return;
    const abort = new AbortController();
    let settled = false;
    let clear = () => {};
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clear();
      if (!ok) {
        abort.abort();
        this.options.onFailure?.();
      }
      this.active = undefined;
      next.resolve(ok);
      this.drain();
    };
    this.active = { abort };
    const schedule =
      this.options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      });
    // Abort requests cancellation; only the operation can confirm its outcome.
    clear = schedule(() => abort.abort(), this.options.timeoutMs ?? 30_000);
    try {
      void next.run(abort.signal).then(finish, () => finish(false));
    } catch {
      finish(false);
    }
  }
}
