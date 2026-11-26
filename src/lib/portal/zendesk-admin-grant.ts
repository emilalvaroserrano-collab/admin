import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { auth } from "@/lib/auth/server";

const CALLBACK = "/api/zendesk/oauth/callback";
const COOKIE = "mts-zendesk-grant";
const TTL = 600;

function config() {
  const subdomain = process.env.ZENDESK_SUBDOMAIN?.trim() || "";
  const clientId = process.env.ZENDESK_OAUTH_CLIENT_ID?.trim() || "managetech";
  const secret = process.env.ZENDESK_OAUTH_CLIENT_SECRET?.trim() || "";
  const scopes = process.env.ZENDESK_OAUTH_SCOPES?.trim() || "read write";
  const owner = (process.env.BOOTSTRAP_OWNER_EMAIL || process.env.ZENDESK_EMAIL || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain) || !secret || !owner) throw new Error("Zendesk OAuth is not configured.");
  return { host: `https://${subdomain}.zendesk.com`, subdomain, clientId, secret, scopes, owner };
}

export function zendeskRedirectUri(request: Request) {
  const incoming = new URL(request.url);
  const loopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  const base = loopback(incoming) ? incoming : new URL(process.env.BETTER_AUTH_URL || "https://mtsportal.cloudgpu.site");
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback(base))) throw new Error("Invalid OAuth callback origin.");
  return new URL(CALLBACK, base.origin).toString();
}

function page(title: string, message: string, status = 400) {
  return new Response(`${title}\n${message}`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function cookie(value: string, request: Request, maxAge = TTL) {
  const secure = new URL(zendeskRedirectUri(request)).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${value}; Path=${CALLBACK}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function ownerSession(request: Request, owner: string) {
  const session = await auth.api.getSession({ headers: request.headers });
  const user = session?.user;
  return user?.emailVerified && user.email.trim().toLowerCase() === owner ? user.id : null;
}

export async function zendeskAdminStart(request: Request) {
  try {
    const cfg = config();
    const userId = await ownerSession(request, cfg.owner);
    if (!userId) return page("Unauthorized", "Sign in to the portal as its verified owner before connecting Zendesk.", 401);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const redirectUri = zendeskRedirectUri(request);
    const payload = Buffer.from(JSON.stringify({ state, verifier, userId, redirectUri, exp: Date.now() + TTL * 1000 })).toString("base64url");
    const url = new URL(`${cfg.host}/oauth/authorizations/new`);
    url.search = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: redirectUri, scope: cfg.scopes, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state }).toString();
    return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie(`${payload}.${signature(payload, cfg.secret)}`, request), "cache-control": "no-store" } });
  } catch {
    return page("Zendesk configuration error", "Check the server OAuth settings and portal session.", 503);
  }
}

function readState(request: Request, secret: string) {
  try {
    const value = (request.headers.get("cookie") || "").split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
    const [payload, sig] = value.split(".");
    if (!payload || !sig) return null;
    const actual = Buffer.from(sig);
    const expected = Buffer.from(signature(payload, secret));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { state: string; verifier: string; userId: string; redirectUri: string; exp: number };
    if (!data.verifier || !data.state || data.exp <= Date.now()) return null;
    return data;
  } catch { return null; }
}

export async function zendeskAdminCallback(request: Request) {
  try {
    const cfg = config();
    const incoming = new URL(request.url);
    const userId = await ownerSession(request, cfg.owner);
    if (!userId) return page("Unauthorized", "Sign in to the portal as its verified owner.", 401);
    if (incoming.searchParams.has("error")) return page("Zendesk did not grant access", "The authorization was denied. Check the OAuth client and restart the connection.");
    const code = incoming.searchParams.get("code");
    const flow = readState(request, cfg.secret);
    if (!code || !flow || flow.state !== incoming.searchParams.get("state") || flow.userId !== userId || flow.redirectUri !== zendeskRedirectUri(request)) {
      return page("Sign-in expired", "Restart the Zendesk connection from the same browser.");
    }
    const response = await fetch(`${cfg.host}/oauth/tokens`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.secret, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, scope: cfg.scopes }),
    });
    const parsed = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; error?: string };
    if (!response.ok || !parsed.access_token) return page("Zendesk refused the grant", `Token exchange failed (HTTP ${response.status}). Verify client identifier, secret, callback URL and scopes.`, 502);
    const meResponse = await fetch(`${cfg.host}/api/v2/users/me.json`, { headers: { Authorization: `Bearer ${parsed.access_token}`, Accept: "application/json" } });
    const me = await meResponse.json().catch(() => ({})) as { user?: { email?: string; role?: string; suspended?: boolean; active?: boolean } };
    const email = me.user?.email?.trim().toLowerCase() || "";
    const role = me.user?.role || "";
    if (!meResponse.ok || role !== "admin" || email !== cfg.owner || me.user?.suspended || me.user?.active === false) {
      return page("Zendesk account cannot run the desk", "Authorize using the configured active Zendesk admin account.", 403);
    }
    const sql = await getSql();
    await sql`alter table integration_settings add column if not exists oauth_access_token text not null default ''`;
    await sql`
      update integration_settings
      set oauth_access_token = ${parsed.access_token},
          oauth_refresh_token = ${parsed.refresh_token || ""},
          oauth_user_email = ${email}, oauth_user_role = ${role},
          oauth_client_id = ${cfg.clientId}, subdomain = ${cfg.subdomain},
          last_status = 'admin', last_error = ''
      where id = 1
    `;
    return new Response(null, { status: 302, headers: { location: new URL("/production/admin-portal/integrations", flow.redirectUri).toString(), "set-cookie": cookie("", request, 0), "cache-control": "no-store" } });
  } catch {
    return page("Zendesk connection failed", "Check server configuration, network and database logs, then retry.", 502);
  }
}
