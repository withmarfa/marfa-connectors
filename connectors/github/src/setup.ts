import { randomBytes, randomUUID } from "node:crypto";
import type { EnvDeclaration, SetupContext } from "@withmarfa/connector";
import { Octokit } from "@octokit/core";
import { asApp, defaultBase, type App } from "./github.js";

export interface SetupEnv {
  readonly GITHUB_APP_ID?: string | undefined;
  readonly GITHUB_PRIVATE_KEY?: string | undefined;
  readonly GITHUB_API_URL?: string | undefined;
  readonly GITHUB_PUBLIC_URL?: string | undefined;
  readonly GITHUB_ORGANIZATION?: string | undefined;
  readonly GITHUB_READ_ONLY?: string | undefined;
}

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
  callback: string;
  hook: string;
  active: boolean;
  readOnly: boolean;
}): Record<string, unknown> {
  return {
    name: `Marfa sync ${randomBytes(2).toString("hex")}`,
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
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Register the GitHub App</title>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem">
<h1>Register the GitHub App</h1>
<p>GitHub opens with the App filled in. Rename it if you like, create it, then install it on the repositories to sync.</p>
<form method="post" action="${escaped(target)}">
<input type="hidden" name="manifest" value="${escaped(JSON.stringify(body))}">
<button type="submit">Continue to GitHub</button>
</form>
</body>
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
    await new Octokit({ baseUrl: base, request: { signal } }).request(
      "POST /app-manifests/{code}/conversions",
      { code },
    )
  ).data as unknown as Conversion;
  secret(conversion.pem);
  const app: App = {
    appId: String(conversion.id),
    privateKey: conversion.pem,
    base,
  };
  let webhookSecret = conversion.webhook_secret;
  if (webhookSecret === null) {
    webhookSecret = await repoint(app, hook ?? made.url, signal, secret);
  } else {
    secret(webhookSecret);
  }
  log.info(
    `GitHub made the App ${conversion.slug}; install it on the repositories to sync at ${conversion.html_url}/installations/new`,
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
