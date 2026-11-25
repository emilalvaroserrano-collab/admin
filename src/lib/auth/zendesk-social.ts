import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { auth, authSigningSecret } from "./server";
import { PUBLIC_APP_ORIGIN } from "./public-origin";

const HOST = "https://managetechservices-16737.zendesk.com";
const SIGN_IN_PATH = "/production/signin";
const PORTAL_PATH = "/production/user-portal";

function clientId() {
  const id = process.env.ZENDESK_OAUTH_CLIENT_ID?.trim() || "managetech";
  return id === "mts-portal" || id === "mtsportal" || id === "manage_tech_service" ? "managetech" : id;
}

function clientSecret() {
  return process.env.ZENDESK_OAUTH_CLIENT_SECRET?.trim() || "";
}

export function zendeskCustomerRedirect() {
  return SIGN_IN_PATH;
}

function sign(payload: string) {
  return createHmac("sha256", clientSecret() || authSigningSecret()).update(payload).digest("base64url");
}

function page(title: string, message: string, status = 400) {
  const body = `<!doctype html><html><body style="font-family:sans-serif;padding:2rem;max-width:40rem"><h1>${title}</h1><p>${message}</p><p><a href="${SIGN_IN_PATH}">Back to sign in</a></p></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function startZendeskSocial(_request?: Request) {
  return Response.redirect(SIGN_IN_PATH, 302);
}

function readState(state: string) {
  const split = state.lastIndexOf(".");
  if (split < 1) return null;
  const payload = state.slice(0, split);
  const sig = state.slice(split + 1);
  const expected = sign(payload);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  const [provider, , exp, verifier] = payload.split(".");
  const expires = Number(exp);
  if (!verifier || !Number.isFinite(expires) || expires <= Date.now()) return null;
  return { provider, verifier };
}

async function exchangeCode(code: string, verifier: string, secret: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId(),
    redirect_uri: `${PUBLIC_APP_ORIGIN}${SIGN_IN_PATH}`,
    code_verifier: verifier,
  });
  if (secret) body.set("client_secret", secret);
  const tokenResponse = await fetch(`${HOST}/oauth/tokens`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenText = await tokenResponse.text();
  return { ok: tokenResponse.ok, tokenText };
}

async function signedSessionCookie(token: string) {
  const signature = createHmac("sha256", authSigningSecret()).update(token).digest("base64");
  const value = encodeURIComponent(`${token}.${signature}`);
  return `__Host-grok-auth.session_token=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`;
}

export async function finishZendeskSocial(request: Request) {
  const incoming = new URL(request.url);
  const error = incoming.searchParams.get("error_description") || incoming.searchParams.get("error");
  if (error) return page("Zendesk did not sign you in", error);
  const code = incoming.searchParams.get("code") || "";
  const parsed = readState(incoming.searchParams.get("state") || "");
  if (!code || !parsed) return page("Sign-in expired", "Choose Google or Microsoft again.");
  const secret = clientSecret();
  let result = await exchangeCode(code, parsed.verifier, secret);
  if (!result.ok && result.tokenText.includes("invalid_client")) result = await exchangeCode(code, parsed.verifier, "");
  let access = "";
  try {
    access = (JSON.parse(result.tokenText) as { access_token?: string }).access_token || "";
  } catch {
    access = "";
  }
  if (!access) {
    const detail = result.tokenText.replaceAll(secret, "").slice(0, 240);
    const hint = detail.includes("invalid_client")
      ? " Zendesk rejected the managetech client secret. On the OAuth client, set the kind to Confidential, keep the identifier managetech, and paste the current secret."
      : "";
    return page("Zendesk refused the sign-in", `${detail}${hint}` || "Zendesk did not return an access token.");
  }
  const meResponse = await fetch(`${HOST}/api/v2/users/me.json`, {
    headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
  });
  const me = (await meResponse.json()) as { user?: { id?: number; name?: string; email?: string; role?: string; suspended?: boolean; active?: boolean } };
  const user = me.user;
  const email = user?.email?.trim().toLowerCase() || "";
  if (!meResponse.ok || !user?.id || !email || user.suspended || user.active === false) {
    return page("This Zendesk account cannot sign in", "Zendesk did not return an active email for that Google or Microsoft login.");
  }
  const { getSql } = await import("@/lib/db");
  const { openCustomerSession } = await import("@/lib/portal/sessions");
  const sql = await getSql();
  const role = (user.role || "end-user").toLowerCase();
  const staff = role === "admin" || role === "agent";
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  const record = found?.user ?? (await ctx.internalAdapter.createUser({ email, name: user.name || email, emailVerified: true }));
  if (!record) return page("Could not open the portal", "The local account was not created.");
  await sql`
    insert into account ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
    values (${`zd-${user.id}`}, ${String(user.id)}, 'zendesk', ${record.id}, now(), now())
    on conflict ("id") do update set "accountId" = excluded."accountId", "userId" = excluded."userId", "updatedAt" = now()
  `.catch(() => undefined);
  if (staff) {
    await sql`
      insert into portal_staff (user_id, name, email, role, active)
      values (${record.id}, ${user.name || email}, ${email}, ${role === "admin" ? "admin" : "agent"}, true)
      on conflict (user_id) do update set email = excluded.email, active = true
    `;
  }
  const existing = await sql<{ id: number }>`select id from shop_customers where lower(email) = ${email} limit 1`;
  let customerId = Number(existing[0]?.id ?? 0);
  if (!customerId) {
    const inserted = await sql<{ id: number }>`
      insert into shop_customers (email, name, password_hash, role_id, email_verified, grant_shop, zendesk_user_id)
      values (${email}, ${user.name || email}, ${randomBytes(16).toString("hex")}, 'buyer', true, true, ${String(user.id)})
      returning id
    `;
    customerId = Number(inserted[0]?.id ?? 0);
  }
  const portalToken = randomBytes(32).toString("hex");
  if (customerId) await openCustomerSession(sql, customerId, portalToken);
  const session = await ctx.internalAdapter.createSession(record.id);
  if (!session) return page("Could not open the portal", "The sign-in session was not created.");
  const destination = PORTAL_PATH;
  const headers = new Headers({ location: destination });
  headers.append("set-cookie", await signedSessionCookie(session.token));
  headers.append("set-cookie", `mts-shop-token=${portalToken}; Path=/; Secure; SameSite=Lax; Max-Age=1209600`);
  return new Response(null, { status: 302, headers });
}
