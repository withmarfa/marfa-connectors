import type { Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { describe } from "./run.js";
import type { Clock } from "./runtime.js";

/** How long a hold is trusted after a renewal is asked for: the instance's three minutes, less one. */
export const trustedMs = 120_000;

/** How long a renewal may take before it counts as failed. */
const renewalMs = 15_000;

/**
 * This process's hold on the registration, so two processes under one key
 * never run at once; its signal fences a run once the hold can't be trusted.
 */
export class Hold {
  private fence = new AbortController();
  private holding = false;
  /** When the last renewal that landed was asked for. */
  private renewedAt = 0;

  constructor(
    private readonly marfa: Marfa,
    private readonly connectorId: string,
    readonly process: string,
    private readonly logger: Logger,
    private readonly clock: Clock,
  ) {}

  /** Aborted when a run under the hold must stop. */
  get signal(): AbortSignal {
    return this.fence.signal;
  }

  /** Takes it before a run; where another process holds it, says until when. */
  async take(): Promise<{ held: true } | { held: false; until: string }> {
    const asked = this.clock.now().getTime();
    const answer = await this.ask();
    if (answer.elsewhere) return { held: false, until: answer.until };
    this.holding = true;
    if (this.fence.signal.aborted) this.fence = new AbortController();
    this.renewedAt = asked;
    return { held: true };
  }

  /** Renews it; time since the last renewal that landed, not a count of failures, decides when to stop. */
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
    this.renewedAt = asked;
  }

  /** Fences the run where the hold can have lapsed since it was last renewed; answers whether it is fenced. */
  check(): boolean {
    if (
      this.holding &&
      this.clock.now().getTime() - this.renewedAt > trustedMs
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
