import type { Log, Secret, State } from "@withmarfa/connector";
import {
  accountCondition,
  endsCondition,
  newTokenCondition,
  scopeCondition,
} from "./conditions.js";
import {
  settings,
  trusts,
  type GoogleOptions,
  type Settings,
} from "./endpoints.js";
import { classify, GoogleError, type Condition } from "./errors.js";
import { grantFor, type Credentials, type Grant } from "./grant.js";
import { largest, readText, send } from "./token.js";

/** What a run hands a Google connector: a run's, or an `onChange`'s, context. */
export interface GoogleContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly state: State;
  readonly log: Pick<Log, "info" | "warn" | "condition">;
  readonly secret: Secret;
}

/** What `ready` found out about the grant. */
export interface Access {
  /** The Google account's stable `sub`; put it in each `source_id`, as
   *  `<sub>:<id>`, so two accounts never share a row. */
  readonly account: string;
  /** The scopes the grant holds, or `undefined` where Google did not say. */
  readonly granted: readonly string[] | undefined;
  /** The scopes this connector declared that the grant lacks. */
  readonly missing: readonly string[];
  /** Whether the connector may do what needs `scope`. */
  has(scope: string): boolean;
}

const accountKey = "google_account";

/** The wanted scopes a grant does not hold. Where Google said which scopes
 *  it holds nowhere, none is known to be missing. */
export function missingScopes(
  granted: ReadonlySet<string> | undefined,
  wanted: readonly string[],
): string[] {
  if (granted === undefined) return [];
  return wanted.filter((scope) => !granted.has(scope));
}

/**
 * Keeps the first account in the connector's state, and refuses a later run
 * whose grant belongs to another: its rows came from the first, so reading
 * or writing as the second would mix them.
 */
export function checkAccount(
  state: State,
  sub: string,
  log: Pick<Log, "condition">,
): void {
  const known = state.get(accountKey);
  if (typeof known !== "string") {
    state.set(accountKey, sub);
    return;
  }
  if (known === sub) return;
  const condition = accountCondition();
  log.condition(condition.key, condition.message);
  throw new GoogleError(
    "the grant belongs to a different Google account than this connector's rows",
    "account",
    { condition },
  );
}

/**
 * A connector's Google sign-in for one run. The grant itself lives as long
 * as the process, so a refreshed access token is reused across runs and a
 * grant Google ended stays ended.
 */
export function connectGoogle(
  context: GoogleContext,
  scopes: readonly string[],
  options?: GoogleOptions,
): Google {
  if (
    scopes.length === 0 ||
    scopes.some((scope) => scope === "" || /\s/.test(scope))
  ) {
    throw new Error(
      "a Google connector declares each scope it needs, without spaces",
    );
  }
  const clientId = context.env["GOOGLE_CLIENT_ID"];
  const clientSecret = context.env["GOOGLE_CLIENT_SECRET"];
  const refreshToken = context.env["GOOGLE_REFRESH_TOKEN"];
  if (
    clientId === undefined ||
    clientSecret === undefined ||
    refreshToken === undefined
  ) {
    throw new Error(
      "a Google connector needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in its environment",
    );
  }
  const used = settings(options);
  const credentials: Credentials = { clientId, clientSecret, refreshToken };
  return new Google(
    context,
    [...new Set(scopes)],
    used,
    grantFor(credentials, used),
  );
}

export class Google {
  constructor(
    private readonly context: GoogleContext,
    private readonly wanted: readonly string[],
    private readonly settings: Settings,
    private readonly grant: Grant,
  ) {}

  /**
   * Refreshes the access token if need be and checks the grant: the account
   * is the one the rows came from, and each scope the connector declared was
   * granted. Throws, after raising its condition, where Google no longer
   * accepts the grant or the account differs, so call it before reading or
   * writing anything. A missing scope raises one condition each and is
   * listed in `missing`; the connector does nothing that needs it.
   */
  async ready(): Promise<Access> {
    const { grant, context } = this;
    const account = await this.guarded(async () => {
      await grant.token(this);
      const sub = grant.sub ?? (await this.userinfo());
      checkAccount(context.state, sub, context.log);
      return sub;
    });
    for (const notice of this.notices()) {
      context.log.condition(notice.key, notice.message);
    }
    const missing = missingScopes(grant.scopes, this.wanted);
    for (const scope of missing) {
      const condition = scopeCondition(scope);
      context.log.condition(condition.key, condition.message);
    }
    if (grant.scopes === undefined) {
      context.log.warn(
        "Google did not say which permissions the grant holds, so they are not checked here",
      );
    }
    const held = grant.scopes;
    return {
      account,
      granted: held === undefined ? undefined : [...held],
      missing,
      has: (scope) => !missing.includes(scope),
    };
  }

  /**
   * Sends a request with the access token, within the run's signal and a
   * time limit. A 401 refreshes the token once and sends the request once
   * more; any other answer, a refusal included, is returned as it is.
   */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    if (!trusts(url, this.settings.endpoints)) {
      throw new Error(`will not send a Google access token to ${url.origin}`);
    }
    return this.guarded(async () => {
      let stale: string | undefined;
      for (let attempt = 0; ; attempt += 1) {
        const token = await this.grant.token(this, stale);
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        const response = await send(
          this.settings,
          this.context.signal,
          "Google",
          url.toString(),
          { ...init, headers },
        );
        if (response.status !== 401 || attempt > 0) return response;
        await response.body?.cancel();
        stale = token;
      }
    });
  }

  /** The JSON Google answered, `undefined` for an empty body. Throws a
   *  `GoogleError` for any answer that is not a success. */
  async json(input: string | URL, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetch(input, init);
    const text = await readText(response, largest);
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      if (response.ok) {
        throw new GoogleError(
          "Google answered something that is not JSON",
          "passing",
          {
            status: response.status,
          },
        );
      }
    }
    if (!response.ok) {
      throw classify(
        response.status,
        body,
        response.headers.get("Retry-After"),
        this.settings.now(),
      );
    }
    return body;
  }

  // `Lent`, for the grant.
  get signal(): AbortSignal {
    return this.context.signal;
  }

  get secret(): Secret {
    return this.context.secret;
  }

  private async userinfo(): Promise<string> {
    const body = await this.json(this.settings.endpoints.userinfo);
    const sub: unknown =
      typeof body === "object" && body !== null
        ? Reflect.get(body, "sub")
        : undefined;
    if (typeof sub !== "string" || sub === "") {
      throw new GoogleError(
        "Google did not say which Google account this is",
        "refused",
      );
    }
    this.grant.sub = sub;
    return sub;
  }

  private notices(): Condition[] {
    const notices: Condition[] = [];
    if (this.grant.reissued) notices.push(newTokenCondition());
    if (this.grant.endsAt !== undefined) {
      notices.push(endsCondition(new Date(this.grant.endsAt)));
    }
    return notices;
  }

  /** Raises the condition of an error that carries one, then rethrows it. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GoogleError && error.condition !== undefined) {
        this.context.log.condition(
          error.condition.key,
          error.condition.message,
        );
      }
      throw error;
    }
  }
}
