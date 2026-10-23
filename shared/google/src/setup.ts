import { createHash, randomBytes } from "node:crypto";
import type { EnvDeclaration, SetupContext } from "@withmarfa/connector";
import { when } from "./conditions.js";
import { settings, type GoogleOptions, type Settings } from "./endpoints.js";
import { GoogleError } from "./errors.js";
import { requestTokens, type Tokens } from "./token.js";

/** What `signIn` needs of the kit's setup context. */
export type GoogleSetupContext = Pick<
  SetupContext<EnvDeclaration>,
  "signal" | "log" | "secret" | "listen"
> & { readonly env: Readonly<Record<string, string | undefined>> };

const everywhere =
  "put it in the environment of every Google connector, since they share one grant";

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** What Google's own error from the redirect means to the person, beside
 *  the error as Google worded it. */
function redirectProblem(error: string, description: string | null): Error {
  const said = description === null ? error : `${error} (${description})`;
  const hints: Record<string, string> = {
    access_denied:
      " The person did not give consent, or Google blocked the app: an account in Google's Advanced Protection Program can block an app Google has not verified. Run setup again and continue on each screen, or use another account.",
    admin_policy_enforced:
      " An administrator of the Google Workspace account has blocked this app or one of its permissions. Ask the administrator, or use another account.",
  };
  return new Error(
    `Google did not complete the sign-in: ${said}.${hints[error] ?? ""}`,
  );
}

/** The scopes the grant already held, so the new one keeps them. */
async function held(
  context: GoogleSetupContext,
  used: Settings,
  credentials: { id: string; secret: string; token: string },
): Promise<Tokens | undefined> {
  try {
    return await requestTokens(used, context.signal, context.secret, {
      grant_type: "refresh_token",
      client_id: credentials.id,
      client_secret: credentials.secret,
      refresh_token: credentials.token,
    });
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error;
    if (error.kind === "reconnect") {
      context.log.warn(
        `The GOOGLE_REFRESH_TOKEN already in the environment is no longer accepted, so this sign-in asks only for this connector's permissions. Every other Google connector needs the new token too: ${everywhere}.`,
      );
      return undefined;
    }
    if (error.kind === "client") throw error;
    throw new Error(
      `could not read the existing grant before adding to it, so it was left alone: ${error.message}. Run setup again`,
      { cause: error },
    );
  }
}

/**
 * A Google connector's `setup`: signs the person in with their own Desktop
 * client and answers the refresh token. Needs `GOOGLE_CLIENT_ID` and
 * `GOOGLE_CLIENT_SECRET` in the environment. Where `GOOGLE_REFRESH_TOKEN`
 * is already set, the new grant holds the scopes that one held and the
 * connector's own, since Google does not add scopes to an installed app's
 * grant by itself.
 */
export async function signIn(
  context: GoogleSetupContext,
  scopes: readonly string[],
  options?: GoogleOptions,
): Promise<{ GOOGLE_REFRESH_TOKEN: string }> {
  const clientId = context.env["GOOGLE_CLIENT_ID"];
  const clientSecret = context.env["GOOGLE_CLIENT_SECRET"];
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      "setup needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment: the Desktop app client of your Google Cloud project",
    );
  }
  const used = settings(options);
  const own = ["openid", ...scopes];
  const existing = context.env["GOOGLE_REFRESH_TOKEN"];
  let before: Tokens | undefined;
  let asked = [...new Set(own)];
  if (existing !== undefined) {
    before = await held(context, used, {
      id: clientId,
      secret: clientSecret,
      token: existing,
    });
    if (before?.scope !== undefined) {
      const added = own.filter((scope) => !before?.scope?.has(scope));
      asked = [...new Set([...before.scope, ...own])];
      context.log.info(
        added.length === 0
          ? "this connector's permissions are already in the grant GOOGLE_REFRESH_TOKEN holds; signing in again to renew it"
          : `signing in again, which adds ${added.join(" ")} to the grant GOOGLE_REFRESH_TOKEN holds`,
      );
    } else if (before !== undefined) {
      context.log.warn(
        "Google did not say which permissions the existing grant holds, so this sign-in asks only for this connector's permissions",
      );
    }
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  context.secret(verifier);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consentFor = (callback: string): string => {
    const address = new URL(used.endpoints.authorization);
    for (const [name, value] of Object.entries({
      client_id: clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: asked.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })) {
      address.searchParams.set(name, value);
    }
    return address.toString();
  };
  const local = await context.listen(
    (callback) =>
      `<!doctype html><title>Sign in to Google</title><p><a href="${escaped(consentFor(callback))}">Continue to Google</a> to sign in.</p>`,
    { paste: consentFor },
  );
  const redirectUri = local.callback;

  const query = await local.redirected;
  if (query.get("state") !== state) {
    throw new Error(
      "the state Google sent back is not the one this setup sent, so the redirect was not for this sign-in: start setup again",
    );
  }
  const problem = query.get("error");
  if (problem !== null) {
    throw redirectProblem(problem, query.get("error_description"));
  }
  const code = query.get("code");
  if (code === null || code.length < 8) {
    throw new Error(
      "Google sent back no authorization code: start setup again",
    );
  }
  context.secret(code);

  let tokens: Tokens;
  try {
    tokens = await requestTokens(used, context.signal, context.secret, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  } catch (error) {
    if (error instanceof GoogleError && error.kind === "reconnect") {
      throw new Error(
        `Google refused the authorization code (${error.message}): it may have been used already or have expired, so start setup again`,
        { cause: error },
      );
    }
    throw error;
  }
  if (tokens.refreshToken === undefined) {
    throw new Error(
      "Google returned no refresh token. Remove this app's access at myaccount.google.com/permissions, then run setup again",
    );
  }
  context.secret(tokens.refreshToken);

  if (tokens.scope === undefined) {
    context.log.warn(
      "Google did not say which permissions it granted, so they are not checked here",
    );
  } else {
    for (const scope of asked.filter((one) => !tokens.scope?.has(one))) {
      context.log.warn(
        `Google did not grant ${scope}. The connector that needs it raises a condition on each run until setup is run again with it ticked`,
      );
    }
  }
  if (tokens.endsAt !== undefined) {
    context.log.warn(
      `Google granted time-based access, which ends on ${when(new Date(tokens.endsAt))}. Run setup again before then and choose ongoing access on the consent screen`,
    );
  }
  if (
    before?.sub !== undefined &&
    tokens.sub !== undefined &&
    before.sub !== tokens.sub
  ) {
    context.log.warn(
      "This is a different Google account than the grant it replaces. Connectors whose rows came from the first account refuse to run against this one",
    );
  }
  context.log.info(`signed in to Google: ${everywhere}`);
  return { GOOGLE_REFRESH_TOKEN: tokens.refreshToken };
}
