import { createHash } from "node:crypto";
import type { Secret } from "@withmarfa/connector";
import { GoogleError } from "./errors.js";
import type { Settings } from "./endpoints.js";
import { requestTokens } from "./token.js";

/** An access token this close to its end is refreshed first. */
const margin = 60_000;

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/** What a run lends the grant for the call it makes. */
export interface Lent {
  readonly signal: AbortSignal;
  readonly secret: Secret;
}

/**
 * One Google grant as a process holds it: its access token, the scopes it
 * holds and whether Google still accepts it. It lives as long as the process
 * and is shared by every run, so a grant that ended stays ended: nothing
 * calls Google for it again until the process restarts with a new refresh
 * token, and nothing retries in a loop.
 */
export class Grant {
  scopes: ReadonlySet<string> | undefined;
  sub: string | undefined;
  /** Google issued a new refresh token, which only this process holds. */
  reissued = false;
  /** When time-based access ends, as milliseconds. */
  endsAt: number | undefined;
  private refreshToken: string;
  private access: { token: string; until: number } | undefined;
  private ended: GoogleError | undefined;
  private notBefore: { at: number; error: GoogleError } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly credentials: Credentials,
    private readonly settings: Settings,
  ) {
    this.refreshToken = credentials.refreshToken;
  }

  /**
   * A working access token, refreshed when there is none or it is near its
   * end. `stale` names a token the caller was just refused: it is replaced
   * unless another call already did.
   */
  token(lent: Lent, stale?: string): Promise<string> {
    if (this.ended !== undefined) return Promise.reject(this.ended);
    const now = this.settings.now();
    if (
      this.access !== undefined &&
      this.access.token !== stale &&
      this.access.until - margin > now
    ) {
      return Promise.resolve(this.access.token);
    }
    if (this.notBefore !== undefined && now < this.notBefore.at) {
      return Promise.reject(this.notBefore.error);
    }
    this.inflight ??= this.refresh(lent).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async refresh(lent: Lent): Promise<string> {
    let tokens;
    try {
      tokens = await requestTokens(this.settings, lent.signal, lent.secret, {
        grant_type: "refresh_token",
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.refreshToken,
      });
    } catch (error) {
      if (error instanceof GoogleError) {
        if (error.kind === "reconnect" || error.kind === "client") {
          this.ended = error;
        } else if (error.retryAt !== undefined) {
          this.notBefore = { at: Date.parse(error.retryAt), error };
        }
      }
      throw error;
    }
    this.notBefore = undefined;
    this.access = {
      token: tokens.accessToken,
      until: this.settings.now() + tokens.expiresInMs,
    };
    if (tokens.scope !== undefined) this.scopes = tokens.scope;
    if (tokens.sub !== undefined) this.sub = tokens.sub;
    if (
      tokens.refreshToken !== undefined &&
      tokens.refreshToken !== this.refreshToken
    ) {
      this.refreshToken = tokens.refreshToken;
      this.reissued = true;
    }
    this.endsAt = tokens.endsAt;
    return tokens.accessToken;
  }
}

const grants = new Map<string, Grant>();

/** The process's grant for these credentials, made on first use. The key is
 *  a digest, so the registry holds no value a person could read. */
export function grantFor(credentials: Credentials, settings: Settings): Grant {
  const key = createHash("sha256")
    .update(
      [
        credentials.clientId,
        credentials.clientSecret,
        credentials.refreshToken,
        settings.endpoints.token,
      ].join("\0"),
    )
    .digest("hex");
  let grant = grants.get(key);
  if (grant === undefined) {
    grant = new Grant(credentials, settings);
    grants.set(key, grant);
  }
  return grant;
}
