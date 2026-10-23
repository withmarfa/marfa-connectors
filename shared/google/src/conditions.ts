import type { Condition } from "./errors.js";

/** The command that signs the person in again, as every message names it. */
const setup = "run this connector with --setup <file>";

const everywhere =
  "put the new GOOGLE_REFRESH_TOKEN in the environment of every Google connector, since they share one grant";

/** At most 500 characters each, the longest the kit keeps. */

export function reconnectCondition(): Condition {
  return {
    key: "google:reconnect",
    message: `Google no longer accepts this connector's sign-in (invalid_grant): access was revoked, went unused for six months, was granted for a limited time that ended, the project is still in Testing, or an administrator blocked it. Reconnect the Google account: ${setup}, ${everywhere}, then restart. Until it restarts with a new token, this connector makes no Google calls.`,
  };
}

export function clientCondition(): Condition {
  return {
    key: "google:client",
    message:
      "Google does not recognize this connector's OAuth client (invalid_client). Check that GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are those of the Desktop app client in your Google Cloud project, then restart. Until it restarts, this connector makes no Google calls.",
  };
}

export function scopeCondition(scope: string): Condition {
  return {
    key: `google:scope:${scope}`,
    message: `Google did not grant ${scope}, which this connector needs, so nothing that needs it runs. ${capital(setup)} and leave every permission ticked on Google's consent screen, then ${everywhere}.`,
  };
}

export function accountCondition(): Condition {
  return {
    key: "google:account",
    message: `The rows of this connector came from a different Google account than the one GOOGLE_REFRESH_TOKEN now signs in to, so nothing was read or written. ${capital(setup)} and sign in with the original account, or give the other account its own Marfa instance.`,
  };
}

export function newTokenCondition(): Condition {
  return {
    key: "google:refresh-token-changed",
    message: `Google issued this connector a new refresh token, which it keeps in memory only. Before it restarts, ${setup}, then ${everywhere}; the token it started with may stop working.`,
  };
}

/** A time as the person reads it in a message: `2026-10-30 at 09:00 UTC`. */
export function when(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

export function endsCondition(endsAt: Date): Condition {
  return {
    key: "google:refresh-token-expires",
    message: `The Google account granted time-based access, which ends on ${when(endsAt)}, after which this connector can no longer read Google. Before then, ${setup}, choose ongoing access on Google's consent screen, and ${everywhere}.`,
  };
}

function capital(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
