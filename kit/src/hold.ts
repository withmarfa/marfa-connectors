import type { Logger } from "./log.js";
import { causeOf, type Cause, type Marfa } from "./marfa.js";
import { describe } from "./run.js";
import { Stopped } from "./rows.js";
import type { Clock } from "./runtime.js";

/** How the instance's window, which each answer names and which may be any
 *  length, sets the rest. A renewal is asked a third of it apart, measured
 *  from the start of one ask to the start of the next, and each is given a
 *  twelfth of it to answer. A run is trusted for five sixths of it from the
 *  last ask that landed, and its signal aborts then. Every call the run
 *  makes to Marfa, its report apart, is ended by that signal, and a call to
 *  the vendor that is handed it is too, so nothing is waited on past the
 *  trust; a request already received may still land, inside the sixth of
 *  the window left before the hold lapses. One renewal that times out
 *  leaves the next asked at two thirds of the window, well inside the trust;
 *  two in a row are what fence a run. */
const renewalShare = 3;
const timeoutShare = 12;
const trustShare = 5 / 6;

/** The server's default window, assumed until an answer names the real one. */
const defaultTtlMs = 180_000;

/** What a failed renewal says about the connector itself, which no run
 *  mends: its key or registration is gone, or its address cannot be used. */
export type Ended = "key" | "registration" | "address";

const unrenewed = "the hold went unrenewed too long, so this run stops";

export class Hold {
  private fence = new AbortController();
  private holding = false;
  private renewedAt = 0;
  private ttlMs = defaultTtlMs;
  private rearm = new AbortController();
  private lapse: NodeJS.Timeout | undefined;
  private failedBecause: Cause | undefined;
  private fencedFor: string | undefined;

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
    if (this.fence.signal.aborted) {
      this.fence = new AbortController();
      this.fencedFor = undefined;
    }
    this.trusted(asked, answer.ttlMs);
    return { held: true };
  }

  /** Time since the last renewal landed, not a count of failures, decides
   *  when to stop. */
  async renew(): Promise<Ended | undefined> {
    if (!this.holding || this.fence.signal.aborted) return undefined;
    const asked = this.clock.now().getTime();
    let answer;
    try {
      answer = await this.ask();
    } catch (error) {
      this.logger.warn(`the hold could not be renewed: ${describe(error)}`);
      const cause = causeOf(error);
      this.failedBecause = cause;
      this.check();
      return cause === "key" || cause === "registration" || cause === "address"
        ? cause
        : undefined;
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

  /** Marfa, where the run was fenced because renewals went unanswered. */
  get fencedBy(): "marfa" | undefined {
    return this.fencedFor === unrenewed && this.failedBecause === "marfa"
      ? "marfa"
      : undefined;
  }

  get renewEvery(): number {
    return this.ttlMs / renewalShare;
  }

  get rearmed(): AbortSignal {
    return this.rearm.signal;
  }

  private trusted(asked: number, ttlMs: number): void {
    this.renewedAt = asked;
    this.failedBecause = undefined;
    const before = this.ttlMs;
    this.ttlMs = ttlMs;
    if (ttlMs < before) {
      this.rearm.abort();
      this.rearm = new AbortController();
    }
    clearTimeout(this.lapse);
    // By the process's own timer, which a renewal moves, so the run's signal
    // aborts when the trust runs out even while a call is in flight.
    this.lapse = setTimeout(
      () => {
        this.stop(unrenewed);
      },
      Math.max(0, asked + ttlMs * trustShare - this.clock.now().getTime()),
    );
    this.lapse.unref();
  }

  check(): boolean {
    if (
      this.holding &&
      this.clock.now().getTime() - this.renewedAt > this.ttlMs * trustShare
    ) {
      this.stop(unrenewed);
    }
    return this.fence.signal.aborted;
  }

  /** Lets go of the timer, for a hold that cannot be released. */
  abandon(): void {
    clearTimeout(this.lapse);
    this.holding = false;
  }

  async release(): Promise<void> {
    clearTimeout(this.lapse);
    if (!this.holding) return;
    this.holding = false;
    try {
      await this.marfa.release(this.connectorId, this.process);
    } catch (error) {
      // A registration that is gone took its hold with it.
      if (causeOf(error) === "registration") return;
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
    if (this.fence.signal.aborted || !this.holding) return;
    this.fencedFor = why;
    this.logger.warn(why);
    this.fence.abort(new Stopped());
  }
}
