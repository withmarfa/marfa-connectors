import {
  Unreachable,
  type Log,
  type Secret,
  type State,
} from "@withmarfa/connector";
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

/**
 * What a run hands a Google connector: a run's, or an `onChange`'s,
 * `remake`'s or `preflight`'s, context. A run's also has `forScope`, `held`
 * and `hints`, with which the first run keeps the account; the others
 * have not, so they only check against an account a run kept.
 */
export interface GoogleContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly state: Pick<State, "get">;
  readonly log: Pick<Log, "info" | "warn" | "condition">;
  readonly secret: Secret;
  readonly forScope?:
    | ((scope: string) => {
        readonly state: {
          checkpoint(
            key: string,
            value: unknown,
          ): Promise<{ committed: boolean; reason?: string }>;
        };
      })
    | undefined;
  readonly held?:
    | ((
        type: string,
        options: { state: "any" },
      ) => Promise<readonly { readonly source_id?: string | undefined }[]>)
    | undefined;
  readonly hints?: unknown;
}

/** What a connector signs in to Google for. */
export interface GoogleNeeds {
  /** Every scope the connector needs. */
  readonly scopes: readonly string[];
  /** The connector's own types, whose rows hold the account in their
   *  `source_id`. Read where no account is kept, as after the connector's
   *  state was cleared, so rows from another account are not taken over. */
  readonly types: readonly string[];
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
const accountScope = "google:account";

/** The wanted scopes a grant does not hold. Where Google said which scopes
 *  it holds nowhere, none is known to be missing. */
export function missingScopes(
  granted: ReadonlySet<string> | undefined,
  wanted: readonly string[],
): string[] {
  if (granted === undefined) return [];
  return wanted.filter((scope) => !granted.has(scope));
}

function otherAccount(): GoogleError {
  return new GoogleError(
    "the grant belongs to a different Google account than this connector's rows",
    "account",
    { condition: accountCondition() },
  );
}

/** A row the connector wrote for another account: its `source_id` begins
 *  with an account other than `sub`. */
function fromAnother(sourceId: string | undefined, sub: string): boolean {
  if (sourceId === undefined) return false;
  const at = sourceId.indexOf(":");
  return at > 0 && sourceId.slice(0, at) !== sub;
}

/**
 * A connector's Google sign-in for one run, `onChange`, `remake` or
 * `preflight`. The grant itself lives as long as the process, so a
 * refreshed access token is reused across runs and a grant Google ended
 * stays ended.
 */
export function connectGoogle(
  context: GoogleContext,
  needs: GoogleNeeds,
  options?: GoogleOptions,
): Google {
  const { scopes, types } = needs;
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
    [...new Set(types)],
    used,
    grantFor(credentials, used),
  );
}

export class Google {
  private checked: Promise<string> | undefined;

  constructor(
    private readonly context: GoogleContext,
    private readonly wanted: readonly string[],
    private readonly types: readonly string[],
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
    await this.guarded(() => grant.token(this));
    const account = await this.account();
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
   * time limit, once the account is checked as `ready` checks it. A 401
   * refreshes the token once and sends the request once more; any other
   * answer, a refusal included, is returned as it is.
   */
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    if (!trusts(url, this.settings.endpoints)) {
      throw new Error(`will not send a Google access token to ${url.origin}`);
    }
    await this.account();
    return this.guarded(() => this.request(url, init));
  }

  /** The JSON Google answered, `undefined` for an empty body. Throws a
   *  `GoogleError` for any answer that is not a success. */
  async json(input: string | URL, init: RequestInit = {}): Promise<unknown> {
    return this.parsed(await this.fetch(input, init));
  }

  // `Lent`, for the grant.
  get signal(): AbortSignal {
    return this.context.signal;
  }

  get secret(): Secret {
    return this.context.secret;
  }

  /**
   * The account, checked once for this handle before anything else is sent:
   * against the account the connector kept, or, where it kept none, against
   * the rows it holds, and then kept before the run writes a row. A check
   * that failed is made again on the next call.
   */
  private account(): Promise<string> {
    this.checked ??= this.guarded(() => this.check()).catch(
      (error: unknown) => {
        this.checked = undefined;
        throw error;
      },
    );
    return this.checked;
  }

  private async check(): Promise<string> {
    const { grant, context } = this;
    await grant.token(this);
    const sub = grant.sub ?? (await this.userinfo());
    const kept = context.state.get(accountKey);
    if (typeof kept === "string") {
      if (kept !== sub) throw otherAccount();
      return sub;
    }
    const { forScope, held } = context;
    if (forScope === undefined || held === undefined) {
      throw new Unreachable(
        "No Google account is kept for this connector yet, so nothing is sent to Google until a run has checked the account and kept it",
        { scope: accountScope },
      );
    }
    if (context.hints !== undefined) {
      throw new Error(
        "no Google account is kept for this connector yet, and a run started by a delivery cannot keep one, so the next scheduled run keeps it",
      );
    }
    for (const type of this.types) {
      const rows = await held(type, { state: "any" });
      if (rows.some((row) => fromAnother(row.source_id, sub))) {
        throw otherAccount();
      }
    }
    const saved = await forScope(accountScope).state.checkpoint(
      accountKey,
      sub,
    );
    if (!saved.committed) {
      throw new Error(
        `the Google account could not be kept before anything was written (${saved.reason ?? "not committed"}), so nothing was read`,
      );
    }
    return sub;
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
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
  }

  private async parsed(response: Response): Promise<unknown> {
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

  private async userinfo(): Promise<string> {
    const body = await this.parsed(
      await this.request(new URL(this.settings.endpoints.userinfo), {}),
    );
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
