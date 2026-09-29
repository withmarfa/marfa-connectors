import { randomBytes, randomUUID } from "node:crypto";
import type { EnvDeclaration, SetupContext } from "@withmarfa/connector";
import { anonymous, asApp, defaultBase, type App } from "./github.js";

export interface SetupEnv {
  readonly GITHUB_APP_ID?: string | undefined;
  readonly GITHUB_PRIVATE_KEY?: string | undefined;
  readonly GITHUB_API_URL?: string | undefined;
  readonly GITHUB_PUBLIC_URL?: string | undefined;
  readonly GITHUB_ORGANIZATION?: string | undefined;
  readonly GITHUB_READ_ONLY?: string | undefined;
  readonly GITHUB_APP_NAME?: string | undefined;
}

/** The App's name unless the setup names another; GitHub holds each
 *  name once, so a second person's setup names its own. */
export const defaultName = "Marfa Connectors";

/** What GitHub hands back for a manifest's code, once. */
interface Conversion {
  id: number;
  slug: string;
  html_url: string;
  pem: string;
  webhook_secret: string | null;
}

/** The webhook events the connector reads; installations come unasked. */
export const events = [
  "issues",
  "issue_comment",
  "sub_issues",
  "issue_dependencies",
  "repository",
];

export function readOnly(value: string | undefined): boolean {
  return value === "true";
}

export function manifest(options: {
  name: string;
  callback: string;
  hook: string;
  active: boolean;
  readOnly: boolean;
}): Record<string, unknown> {
  return {
    name: options.name,
    url: "https://github.com/withmarfa/marfa-connectors",
    description:
      "Keeps issues, their comments and their relations in step with a Marfa instance.",
    hook_attributes: { url: options.hook, active: options.active },
    redirect_url: options.callback,
    public: false,
    default_permissions: {
      issues: options.readOnly ? "read" : "write",
      metadata: "read",
    },
    default_events: events,
  };
}

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A page that posts the manifest to GitHub, as its manifest flow asks. */
export function page(target: string, body: Record<string, unknown>): string {
  const name = typeof body["name"] === "string" ? body["name"] : "the App";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect GitHub to Marfa</title>
<style>
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #f6f8fa; --card: #fff; --line: #d1d9e0; --accent: #1f883d; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f0f6fc; --muted: #9198a1; --bg: #0d1117; --card: #151b23; --line: #3d444d; --accent: #238636; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 30rem; margin: 1rem; padding: 2rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  ol { padding-left: 1.25rem; color: var(--muted); }
  li { margin: 0.35rem 0; }
  strong { color: var(--fg); }
  button { margin-top: 1rem; width: 100%; padding: 0.75rem; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
</style>
<main>
<h1>Connect GitHub to Marfa</h1>
<ol>
  <li>GitHub opens with <strong>${escaped(name)}</strong> filled in. Create it.</li>
  <li>GitHub sends you on to install it: choose the repositories to sync.</li>
  <li>Come back to the terminal, which has the App's secrets.</li>
</ol>
<form method="post" action="${escaped(target)}">
<input type="hidden" name="manifest" value="${escaped(JSON.stringify(body))}">
<button type="submit">Continue to GitHub</button>
</form>
</main>
</html>
`;
}

/**
 * Registers a GitHub App from a manifest and answers its secrets; or, for
 * an App already in the environment, points its webhook at this instance
 * with a new secret.
 */
export async function setUp<E extends EnvDeclaration>(
  context: SetupContext<E>,
  env: SetupEnv,
): Promise<Record<string, string>> {
  const { listen, endpoint, secret, log, signal } = context;
  const base = env.GITHUB_API_URL ?? defaultBase;
  const made = await endpoint({
    label: "github",
    duplicateHeader: "X-GitHub-Delivery",
  });
  const hook =
    env.GITHUB_PUBLIC_URL === undefined
      ? undefined
      : new URL(made.path, env.GITHUB_PUBLIC_URL).toString();

  if (env.GITHUB_APP_ID !== undefined && env.GITHUB_PRIVATE_KEY !== undefined) {
    if (hook === undefined) {
      throw new Error(
        "GITHUB_PUBLIC_URL names no address, so the App's webhook has nowhere to point",
      );
    }
    const app: App = {
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_PRIVATE_KEY,
      base,
    };
    const webhookSecret = await repoint(app, hook, signal, secret);
    log.info(
      "the App's webhook now points at this instance, with a new secret; turn it on under the App's settings if it is off",
    );
    return { GITHUB_WEBHOOK_SECRET: webhookSecret };
  }

  const state = randomUUID();
  const web = base === defaultBase ? "https://github.com" : base;
  const owner = env.GITHUB_ORGANIZATION;
  const target = `${web}${owner === undefined ? "" : `/organizations/${encodeURIComponent(owner)}`}/settings/apps/new?state=${state}`;
  const local = await listen((callback) =>
    page(
      target,
      manifest({
        name: env.GITHUB_APP_NAME ?? defaultName,
        callback,
        hook: hook ?? made.url,
        active: hook !== undefined,
        readOnly: readOnly(env.GITHUB_READ_ONLY),
      }),
    ),
  );
  const query = await local.redirected;
  if (query.get("state") !== state) {
    throw new Error(
      "GitHub's redirect carried another state, so its code is not used",
    );
  }
  const code = query.get("code");
  if (code === null || code === "") {
    throw new Error("GitHub's redirect carried no code");
  }
  // Needs no authentication: the code, good for an hour, is the proof.
  const conversion = (
    await anonymous(base, signal).request(
      "POST /app-manifests/{code}/conversions",
      // Good once: a retry after GitHub made the App would lose its key.
      { code, request: { retries: 0 } },
    )
  ).data as unknown as Conversion;
  secret(conversion.pem);
  const app: App = {
    appId: String(conversion.id),
    privateKey: conversion.pem,
    base,
  };
  // From here the App exists on GitHub and its key is had only once: a step
  // that fails is a warning, never the setup's failure, which loses the key.
  let webhookSecret = conversion.webhook_secret ?? "";
  if (webhookSecret === "") {
    try {
      webhookSecret = await repoint(app, hook ?? made.url, signal, secret);
    } catch (error) {
      webhookSecret = randomBytes(32).toString("hex");
      secret(webhookSecret);
      log.warn(
        `GitHub gave the App no webhook secret and would not take one (${error instanceof Error ? error.message : String(error)}); set GITHUB_WEBHOOK_SECRET as the App's webhook secret in its settings`,
      );
    }
  } else {
    secret(webhookSecret);
  }
  const install = `${conversion.html_url}/installations/new`;
  try {
    local.onward(install);
  } catch {
    // The browser is told setup is done; the address is logged below.
  }
  log.info(
    `GitHub made the App ${conversion.slug}; install it on the repositories to sync at ${install}`,
  );
  if (hook === undefined) {
    log.info(
      "its webhook is off until this instance has a public address: run the setup again with GITHUB_PUBLIC_URL, and the App in the environment, to point it here",
    );
  }
  return {
    GITHUB_APP_ID: String(conversion.id),
    GITHUB_PRIVATE_KEY: conversion.pem,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
  };
}

async function repoint(
  app: App,
  url: string,
  signal: AbortSignal,
  secret: (value: string) => void,
): Promise<string> {
  const webhookSecret = randomBytes(32).toString("hex");
  secret(webhookSecret);
  // As `data`: the body's `url` would otherwise be taken as the request's.
  await asApp(app, signal).request("PATCH /app/hook/config", {
    data: { url, content_type: "json", secret: webhookSecret },
  });
  return webhookSecret;
}
