# @withmarfa/google

The Google sign-in that every Google connector shares. A connector built on it signs in to Google once, with one OAuth client and one refresh token, and the person never signs in again for each connector. This package is private to the workspace and is never published.

This page is reference. It describes what the package does, the conditions a person can meet and what to do about each. The setup steps for a person belong in the Marfa docs.

## The environment

Every Google connector declares the same three variables, exported as `googleEnv`.

| Variable               | Kind     | Holds                                                                      |
| ---------------------- | -------- | -------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | required | The ID of a Desktop app OAuth client in the person's Google Cloud project. |
| `GOOGLE_CLIENT_SECRET` | secret   | That client's secret.                                                      |
| `GOOGLE_REFRESH_TOKEN` | secret   | The one grant that `--setup` writes. Absent until setup has run.           |

The refresh token is the only value setup produces. A Google connector reads all three from its environment and writes none of them.

## Use in a connector

```ts
import { connectGoogle, googleEnv, signIn } from "@withmarfa/google";

const scopes = ["https://www.googleapis.com/auth/calendar.readonly"];
const needs = { scopes, types: ["google.calendar.event"] };

export default defineConnector({
  // ...
  env: googleEnv,
  setup: (context) => signIn(context, scopes),
  async run(context) {
    const google = connectGoogle(context, needs);
    const access = await google.ready();
    const body = await google.json(
      "https://www.googleapis.com/calendar/v3/...",
    );
  },
  async onChange(change, context) {
    const google = connectGoogle(context, needs);
    // google.fetch and google.json check the account before they send.
  },
});
```

- `signIn(context, scopes, options?)` is a connector's `setup`.
- `connectGoogle(context, { scopes, types }, options?)` returns a `Google` for one run, `onChange`, `remake` or `preflight`. It takes the context the kit hands each of them. `scopes` lists every scope the connector needs. `types` lists the connector's own types, whose rows hold the account in their `source_id`; see [One account per instance](#one-account-per-instance).
- `options` can replace the Google endpoints, the clock and the request timeout. Tests use it to point a connector at a local stub.

### `google.ready()`

Call it at the start of a run, before the run writes anything. It:

1. Gets an access token, refreshing it when the process holds none or it is near its end. A grant Google already refused stops the run here.
2. Learns the signed-in account. It reads `sub` from the ID token and asks Google's userinfo endpoint where there is no ID token.
3. Checks the account as [One account per instance](#one-account-per-instance) describes. Where the connector keeps no account yet, it keeps this one, with a checkpoint of the connector's state, before the run writes a row.
4. Raises the notices and conditions below, and returns `Access`.

`Access` holds `account` (the account's `sub`), `granted` (the scopes the grant holds, or `undefined` where Google did not say), `missing` (the connector's scopes the grant lacks) and `has(scope)`.

Put `account` in each `source_id`, as `<account>:<id>`, so that two accounts never share a row.

### `google.fetch` and `google.json`

`fetch` checks the account first, once for each `Google`, as `ready` does, so a call from `onChange`, `remake` or `preflight` is never sent for another account than the one the connector keeps. It then sends the request with a bearer token. It accepts only `https` addresses on `googleapis.com` or a subdomain of it, so a link inside a response cannot send the token elsewhere. It does not follow redirects, and it times out. On a `401` it refreshes the access token once and sends the request once more.

`json` calls `fetch` and returns the parsed body, or `undefined` for an empty one. For an error answer it throws a `GoogleError`.

## What setup does

`--setup <file>` runs `signIn`:

1. It stops if `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is missing.
2. If `GOOGLE_REFRESH_TOKEN` is already set, it asks Google which scopes that grant holds and requests those together with the connector's own. See [How a second connector widens the grant](#how-a-second-connector-widens-the-grant).
3. It serves a page with a link to Google's consent screen, using PKCE with the `S256` method, a random `state`, `access_type=offline`, `prompt=consent` and `include_granted_scopes=true`. It also asks the kit to take the redirect by paste, so the log names the consent address for a browser on another machine.
4. After the redirect it checks `state`, shows Google's own error if there is one, and exchanges the code for tokens.
5. It checks that Google sent a refresh token, and writes the one value, `GOOGLE_REFRESH_TOKEN`, to `<file>`.

The kit writes `<file>` readable by its owner alone, and removes it if setup fails. See the template's README for the rules about where the file may live.

The authorization code, the PKCE verifier, the client secret and every token pass through `secret` before anything is logged, and no message quotes a response body.

### Signing in from a browser on another machine

The log names Google's consent address beside the instruction to paste. Open that address in the browser on the other machine and sign in. Google then redirects the browser to an address on the machine that runs setup, which from the other machine reaches nothing. The page shows an error, but its address bar holds the whole address Google sent. Paste that address into the terminal where setup runs and press Enter. Setup treats it as the redirect.

A pasted line is used only if it is a web address whose path is the callback's. Anything else draws one warning, and setup keeps waiting. The kit reads the terminal only while setup waits.

A terminal may cut a pasted line that is longer than about 1,000 characters. If the address is cut, finish in a browser on the machine that runs setup.

### Warnings setup can give

| Warning                                   | Meaning                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A scope was not granted                   | The person cleared a permission on the consent screen. The connector runs, and raises the scope condition.        |
| Time-based access                         | Google granted access that ends on the date given. See the end condition below.                                   |
| A different account than the one replaced | The new grant belongs to another Google account than the grant in the environment. See the account condition.     |
| `access_denied`                           | The person declined, or an administrator or Advanced Protection blocked the request. The log says which to check. |
| `admin_policy_enforced`                   | A Workspace administrator restricts this client or scope.                                                         |

## How a second connector widens the grant

All Google connectors share one grant, so a second Google connector's setup widens it rather than replacing it.

- Setup reads the scopes of the grant already in `GOOGLE_REFRESH_TOKEN` and requests them again beside its own, so the new grant holds both.
- Setup always writes a new refresh token. The person then puts the new `GOOGLE_REFRESH_TOKEN` in the environment of **every** Google connector.
- Until they do, the other connectors keep running on the old token, which holds only the scopes it held before. Nothing raises a condition for this, since those connectors do not know setup ran.

If the grant in the environment no longer works (`invalid_grant`), setup warns and requests only the connector's own scopes. If the client is wrong (`invalid_client`), setup stops.

## One account per instance

A Marfa instance supports one Google account for its Google connectors. To use another Google account, use another Marfa instance.

Each connector keeps the account's `sub` in its state, under `google_account`, and checks every grant against it before the connector sends Google a request or writes to Marfa:

- **The first run.** Where the connector keeps no account, `ready` reads the rows of the connector's `types`, in every state. If one holds a `source_id` that begins with another account, as `<sub>:`, the run fails with the account condition. Otherwise `ready` keeps the account at once, with a checkpoint of the connector's state, so it holds even if the run fails after writing rows.
- **After the state was cleared.** Clearing a connector's state also clears the kept account, but not its rows. The next run reads the rows as the first run does, so a grant for another account is refused while the first account's rows remain.
- **A later run.** A grant for another account fails the run with the account condition, and nothing is read or written.
- **`onChange`, `remake` and `preflight`.** Each makes its own `Google`, and some run before the run's own `ready`, so `fetch` and `json` check the grant against the kept account first. A grant for another account raises the account condition and throws a `GoogleError` of kind `account`, which fails the run, and nothing is sent. Where the connector keeps no account yet, they throw `Unreachable` with the scope `google:account`, so nothing is sent until a run has kept the account.
- **A run started between scheduled runs.** A run that a delivery or a change waiting in Marfa starts cannot take a checkpoint, so where no account is kept, it fails, and the next scheduled run keeps the account.

## Scopes are matched exactly

A scope counts as granted only when Google lists that exact scope. A broader scope the grant holds, such as `calendar`, is not counted as a narrower one, such as `calendar.readonly`. A connector declares the scopes it needs, and a person widens a grant by running setup, not by Google implying a scope.

If Google's answer has no `scope` field at all, the connector proceeds, `missing` is empty and `granted` is `undefined`. A warning says so. A scope that is really missing then shows as a `403` from the API.

## Conditions

A condition appears on the connector in Marfa until a run no longer raises it. Each has a key, and each message names what to do.

| Key                            | Raised when                                                                                                                | What the person does                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `google:reconnect`             | Google answers `invalid_grant`: access was revoked, went unused for six months, ended, or the project is still in Testing. | Run `--setup <file>`, put the new `GOOGLE_REFRESH_TOKEN` in every Google connector's environment, restart. |
| `google:client`                | Google answers `invalid_client`.                                                                                           | Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are those of the Desktop app client, restart.          |
| `google:scope:<scope>`         | The grant lacks a scope the connector needs. One condition per scope.                                                      | Run `--setup <file>`, leave every permission ticked, put the new token in every Google connector.          |
| `google:account`               | The grant belongs to another account than the one the connector keeps, or than the connector's rows came from.             | Sign in again with the original account, or use another instance.                                          |
| `google:refresh-token-changed` | Google issued a new refresh token during a run. The connector keeps it in memory only.                                     | Run `--setup <file>` before the connector restarts, then update every Google connector.                    |
| `google:refresh-token-expires` | Google granted time-based access, which ends on a stated date.                                                             | Before that date, run `--setup <file>`, choose ongoing access, update every Google connector.              |

After `google:reconnect` or `google:client`, the connector makes no further Google calls in that process. It does not retry a grant Google has already refused.

## How errors are classified

`google.json` and `google.fetch` callers see `GoogleError`, with a `kind`:

| Kind        | Google answered                                                                                                      | Meaning                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `reconnect` | `invalid_grant`                                                                                                      | The grant is over. Raises `google:reconnect`.                  |
| `client`    | `invalid_client`                                                                                                     | The client is wrong. Raises `google:client`.                   |
| `account`   | (not an answer)                                                                                                      | The grant belongs to another account. Raises `google:account`. |
| `passing`   | `429`, any `5xx`, a `403` with `rateLimitExceeded` or `userRateLimitExceeded`, no answer, or a body that is not JSON | It can pass. Try again later.                                  |
| `quota`     | A `403` with `quotaExceeded` or `dailyLimitExceeded`                                                                 | The usage limit holds until Google resets it.                  |
| `refused`   | Anything else                                                                                                        | Google will not take the request as it stands.                 |

A `Retry-After` header, as seconds or an HTTP date, sets `retryAt`. A past or invalid value is ignored, and no wait is believed beyond 24 hours.

`toChangeError(error)` turns a `GoogleError` into the kit's error for an `onChange` that fails: `passing` and `quota` become `Unreachable`, with `retryAt` where Google gave one, and `refused` becomes `Refused`. It returns `undefined` for any other error, which the caller rethrows.

## Sharing within one process

Every run and `onChange` in one process that uses the same client and refresh token shares one access token and one refresh. Once Google ends a grant, each later call in the process fails at once with the same error, and none calls Google again.
