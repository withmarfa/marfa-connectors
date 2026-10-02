import type { Logger } from "./log.js";
import { causeOf, type Marfa } from "./marfa.js";
import { describe } from "./run.js";
import type { Clock } from "./runtime.js";

/** How the instance's window, which each answer names, sets the rest: a
 *  renewal is asked a third of it apart, measured from the start of one ask
 *  to the start of the next, and given a twelfth of it to answer. Past five
 *  sixths of it since the last ask that landed, a write is no longer
 *  trusted to land inside the window. So one renewal that times out leaves
 *  the next asked at two thirds, well inside the trust, and two in a row
 *  are what fence a run. */
const renewalShare = 3;
const timeoutShare = 12;
const trustShare = 5 / 6;

/** The server's default window, assumed until an answer names the real one. */
const defaultTtlMs = 180_000;

/** What a failed renewal says about the connector itself: its key or its
 *  registration is gone, which no run mends. */
export type Lost = "key" | "registration";

export class Hold {
  private fence = new AbortController();
  private holding = false;
  private renewedAt = 0;
  private ttlMs = defaultTtlMs;
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
    this.trusted(asked, answer.ttlMs);
    return { held: true };
  }

  /** Time since the last renewal landed, not a count of failures, decides
   *  when to stop. */
  async renew(): Promise<Lost | undefined> {
    if (!this.holding || this.fence.signal.aborted) return undefined;
    const asked = this.clock.now().getTime();
    let answer;
    try {
      answer = await this.ask();
    } catch (error) {
      this.logger.warn(`the hold could not be renewed: ${describe(error)}`);
      this.check();
      const cause = causeOf(error);
      return cause === "key" || cause === "registration" ? cause : undefined;
    }
    if (answer.elsewhere) {
      this.stop(
        `another process holds this connector until ${answer.until}, so this one stops`,
      );
      this.holding = false;
      return undefined;
    }
    // Another process may have run and written meanwhile.
    if (!answer.renewed) {
      this.stop("the hold lapsed before it was renewed, so this run stops");
      return undefined;
    }
    this.trusted(asked, answer.ttlMs);
    return undefined;
  }

  get renewEvery(): number {
    return this.ttlMs / renewalShare;
  }

  get rearmed(): AbortSignal {
    return this.rearm.signal;
  }

  private trusted(asked: number, ttlMs: number): void {
    this.renewedAt = asked;
    const before = this.ttlMs;
    this.ttlMs = ttlMs;
    if (ttlMs < before) {
      this.rearm.abort();
      this.rearm = new AbortController();
    }
  }

  check(): boolean {
    if (
      this.holding &&
      this.clock.now().getTime() - this.renewedAt > this.ttlMs * trustShare
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
      AbortSignal.timeout(this.ttlMs / timeoutShare),
    );
  }

  private stop(why: string): void {
    if (this.fence.signal.aborted) return;
    this.logger.warn(why);
    this.fence.abort();
  }
}
