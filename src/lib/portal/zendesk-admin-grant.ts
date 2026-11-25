import { createHash, createHmac, randomBytes } from "node:crypto";
import { getSql } from "@/lib/db";

const SCOPES = "read write";
const HOST = "https://managetechservices-16737.zendesk.com";

function clientId() {
  const id = process.env.ZENDESK_OAUTH_CLIENT_ID?.trim() || "managetech";
  return id === "mts-portal" || id === "mtsportal" || id === "manage_tech_service" ? "managetech" : id;
}

function clientSecret() {
  return process.env.ZENDESK_OAUTH_CLIENT_SECRET?.trim() || "";
}

export function zendeskRedirectUri(request: Request) {
  const origin = new URL(request.url).origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return `${origin}/api/zendesk/oauth/callback`;
  return "https://mtsportal.cloudgpu.site/api/zendesk/oauth/callback";
}

function sign(payload: string) {
  return createHmac("sha256", clientSecret() || "mts-portal").update(payload).digest("base64url");
}

function challenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function page(title: string, message: string, status = 400) {
  const body = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;max-width:36rem"><h1>${title}</h1><p>${message}</p></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function zendeskAdminStart(request: Request) {
  const verifier = randomBytes(32).toString("base64url");
  const payload = `${randomBytes(16).toString("base64url")}.${Date.now() + 10 * 60 * 1000}.${verifier}`;
  const url = new URL(`${HOST}/oauth/authorizations/new`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("redirect_uri", zendeskRedirectUri(request));
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", challenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", `${payload}.${sign(payload)}`);
  return Response.redirect(url.toString(), 302);
}

function validState(state: string) {
  const split = state.lastIndexOf(".");
  if (split < 0) return null;
  const payload = state.slice(0, split);
  const sig = state.slice(split + 1);
  if (sign(payload) !== sig) return null;
  const parts = payload.split(".");
  const exp = Number(parts[1]);
  const verifier = parts[2] || "";
  if (!verifier || !Number.isFinite(exp) || exp <= Date.now()) return null;
  return verifier;
}

async function postToken(body: Record<string, string>) {
  const response = await fetch(`${HOST}/oauth/tokens`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const tokenText = await response.text();
  return { ok: response.ok, tokenText };
}

export async function zendeskAdminCallback(request: Request) {
  const incoming = new URL(request.url);
  if (incoming.searchParams.get("error")) return page("Zendesk did not grant access", incoming.searchParams.get("error_description") || "The grant was cancelled.");
  const code = incoming.searchParams.get("code") || "";
  const verifier = validState(incoming.searchParams.get("state") || "");
  if (!code || !verifier) return page("Sign-in expired", "Open the admin connection again.");
  const redirectUri = zendeskRedirectUri(request);
  const secret = clientSecret();
  const base = {
    grant_type: "authorization_code",
    code,
    client_id: clientId(),
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: SCOPES,
  };
  let result = await postToken(base);
  if (!result.ok && secret && /did not include its credentials/i.test(result.tokenText)) {
    result = await postToken({ ...base, client_secret: secret });
  }
  if (!result.ok) return page("Zendesk refused the grant", result.tokenText.replaceAll(secret, "").slice(0, 280));
  const parsed = JSON.parse(result.tokenText) as { access_token?: string; refresh_token?: string };
  if (!parsed.access_token) return page("Zendesk refused the grant", "No access token was returned.");
  const meResponse = await fetch(`${HOST}/api/v2/users/me.json`, {
    headers: { Authorization: `Bearer ${parsed.access_token}`, Accept: "application/json" },
  });
  const me = (await meResponse.json()) as { user?: { email?: string; role?: string } };
  const email = me.user?.email?.trim().toLowerCase() || "";
  const role = me.user?.role || "";
  if (!meResponse.ok || role === "end-user") {
    return page("This Zendesk login cannot run the desk", `${email || "That account"} is ${role || "not an agent"}. Sign in to Zendesk as admin@abitech.site, then open the connection again.`);
  }
  const sql = await getSql();
  await sql`alter table integration_settings add column if not exists oauth_access_token text not null default ''`;
  await sql`
    update integration_settings
    set oauth_access_token = ${parsed.access_token},
        oauth_refresh_token = ${parsed.refresh_token || ""},
        oauth_user_email = ${email},
        oauth_user_role = ${role},
        subdomain = 'managetechservices-16737',
        last_status = 'admin',
        last_error = ''
    where id = 1
  `;
  return Response.redirect(`${new URL(redirectUri).origin}/production/admin-portal/integrations`, 302);
}
