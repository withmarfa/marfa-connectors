import type { Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { describe } from "./run.js";
import type { Clock } from "./runtime.js";

const defaultTrustMs = 120_000;

const renewalMs = 15_000;

export class Hold {
  private fence = new AbortController();
  private holding = false;
  private renewedAt = 0;
  private trustMs = defaultTrustMs;
  private rearm = new AbortController();

  constructor(
    private readonly marfa: Marfa,
    private readonly connectorId: string,
    readonly process: string,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  get signal(): AbortSignal {
    return this.fence.signal;
  }

  async take(): Promise<{ held: true } | { held: false; until: string }> {
    const asked = this.clock.now().getTime();
    const answer = await this.ask();
    if (answer.elsewhere) return { held: false, until: answer.until };
    this.holding = true;
    if (this.fence.signal.aborted) this.fence = new AbortController();
    this.trusted(asked, answer.window);
    return { held: true };
  }

  /** Renews it; time since the last renewal landed, not a count of
   *  failures, decides when to stop. */
  async renew(): Promise<void> {
    if (!this.holding || this.fence.signal.aborted) return;
    const asked = this.clock.now().getTime();
    let answer;
    try {
      answer = await this.ask();
    } catch (error) {
      this.logger.warn(`the hold could not be renewed: ${describe(error)}`);
      this.check();
      return;
    }
    if (answer.elsewhere) {
      this.stop(
        `another process holds this connector until ${answer.until}, so this one stops`,
      );
      this.holding = false;
      return;
    }
    // Another process may have run and written meanwhile.
    if (!answer.renewed) {
      this.stop("the hold lapsed before it was renewed, so this run stops");
      return;
    }
    this.trusted(asked, answer.window);
  }

  get renewEvery(): number {
    return this.trustMs / 2;
  }

  get rearmed(): AbortSignal {
    return this.rearm.signal;
  }

  private trusted(asked: number, window: number | undefined): void {
    this.renewedAt = asked;
    const before = this.trustMs;
    this.trustMs = window === undefined ? defaultTrustMs : (window * 2) / 3;
    if (this.trustMs < before) {
      this.rearm.abort();
      this.rearm = new AbortController();
    }
  }

  check(): boolean {
    if (
      this.holding &&
      this.clock.now().getTime() - this.renewedAt > this.trustMs
    ) {
      this.stop("the hold went unrenewed too long, so this run stops");
    }
    return this.fence.signal.aborted;
  }

  async release(): Promise<void> {
    if (!this.holding) return;
    this.holding = false;
    try {
      await this.marfa.release(this.connectorId, this.process);
    } catch (error) {
      this.logger.warn(`the hold could not be released: ${describe(error)}`);
    }
  }

  private ask() {
    return this.marfa.hold(
      this.connectorId,
      this.process,
      AbortSignal.timeout(renewalMs),
    );
  }

  private stop(why: string): void {
    if (this.fence.signal.aborted) return;
    this.logger.warn(why);
    this.fence.abort();
  }
}
