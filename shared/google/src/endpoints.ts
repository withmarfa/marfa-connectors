export interface GoogleEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly userinfo: string;
  /** An origin besides Google's own that may receive an access token, which
   *  a test points at its stub. */
  readonly api?: string | undefined;
}

export const googleEndpoints: GoogleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
};

/** Where the sign-in reaches Google, and how it keeps time. A connector
 *  passes none of it; a test passes the address of its stub. */
export interface GoogleOptions {
  readonly endpoints?: Partial<GoogleEndpoints> | undefined;
  readonly now?: (() => number) | undefined;
  /** Longest a call to Google may take, in milliseconds. */
  readonly timeoutMs?: number | undefined;
}

export interface Settings {
  readonly endpoints: GoogleEndpoints;
  readonly now: () => number;
  readonly timeoutMs: number;
}

export function settings(options: GoogleOptions = {}): Settings {
  return {
    endpoints: { ...googleEndpoints, ...options.endpoints },
    now: options.now ?? Date.now,
    timeoutMs: options.timeoutMs ?? 30_000,
  };
}

/** Whether an access token may be sent to `url`: Google's own API hosts over
 *  HTTPS, so a link in an answer cannot lead the token elsewhere. */
export function trusts(url: URL, endpoints: GoogleEndpoints): boolean {
  if (
    url.protocol === "https:" &&
    (url.hostname === "googleapis.com" ||
      url.hostname.endsWith(".googleapis.com"))
  ) {
    return true;
  }
  return (
    endpoints.api !== undefined && url.origin === new URL(endpoints.api).origin
  );
}
