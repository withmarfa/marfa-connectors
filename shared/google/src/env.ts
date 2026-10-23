/**
 * What every Google connector declares in its `env`, spread beside its own:
 * `env: { ...googleEnv, MY_SETTING: "optional" }`. The client is the person's
 * own Desktop app client, a setting and never code. A Desktop client's secret
 * is not confidential, but Google's token endpoint asks for it, so it stays
 * out of the logs like the refresh token, which the kit's `--setup` relaxes
 * until setup has made it.
 */
export const googleEnv = {
  GOOGLE_CLIENT_ID: "required",
  GOOGLE_CLIENT_SECRET: "secret",
  GOOGLE_REFRESH_TOKEN: "secret",
} as const;
