import type { Logger } from "./log.js";
import type { Marfa } from "./marfa.js";
import { describe } from "./run.js";

/**
 * This process's hold on the registration, so two processes under one key
 * never run at once. Its signal fences a run once the hold can no longer be
 * trusted: another process took it, or two renewals in a row failed, which
 * leaves a minute of the instance's three before it would lapse.
 */
export class Hold {
  private fence = new AbortController();
  private failures = 0;
  private holding = false;

  constructor(
    private readonly marfa: Marfa,
    private readonly connectorId: string,
    readonly process: string,
    private readonly logger: Logger,
  ) {}

  /** Aborted when a run under the hold must stop. */
  get signal(): AbortSignal {
    return this.fence.signal;
  }

  /** Takes it before a run; where another process holds it, says until when. */
  async take(): Promise<{ held: true } | { held: false; until: string }> {
    const answer = await this.marfa.hold(this.connectorId, this.process);
    if (answer.elsewhere) return { held: false, until: answer.until };
    this.holding = true;
    this.failures = 0;
    if (this.fence.signal.aborted) this.fence = new AbortController();
    return { held: true };
  }

  /** Renews it on the heartbeat's beat. */
  async renew(): Promise<void> {
    if (!this.holding || this.fence.signal.aborted) return;
    try {
      const answer = await this.marfa.hold(this.connectorId, this.process);
      if (answer.elsewhere) {
        this.logger.warn(
          `another process holds this connector until ${answer.until}, so this one stops`,
        );
        this.holding = false;
        this.fence.abort();
        return;
      }
      this.failures = 0;
      if (!answer.renewed) {
        // Another process may have run and written meanwhile, so what this
        // run read is stale; the next run reads it again.
        this.logger.warn(
          "the hold lapsed before it was renewed, so this run stops",
        );
        this.fence.abort();
      }
    } catch (error) {
      this.failures += 1;
      this.logger.warn(`the hold could not be renewed: ${describe(error)}`);
      if (this.failures >= 2) this.fence.abort();
    }
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
}
