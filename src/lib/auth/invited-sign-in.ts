import { createServerFn } from "@tanstack/react-start";
import { hashPassword } from "better-auth/crypto";

function emailOf(input: unknown) {
  const raw = input && typeof input === "object" ? (input as { email?: unknown }) : {};
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!email.includes("@")) throw new Error("Enter the email from your invitation.");
  return email;
}

export const customerSocialAuth = createServerFn({ method: "GET" }).handler(async () => ({
  google: "zendesk",
  microsoft: "zendesk",
}));

export const signInWithInvitation = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input && typeof input === "object" ? (input as { email?: unknown; password?: unknown }) : {};
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    if (!email.includes("@") || password.length < 8) throw new Error("Enter your email and a password of at least 8 characters.");
    return { email, password };
  })
  .handler(async ({ data }) => {
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    const { auth } = await import("./server");
    const headers = getRequestHeaders();
    try {
      await auth.api.signInEmail({
        body: { email: data.email, password: data.password, rememberMe: true },
        headers,
      });
      return { ok: true as const };
    } catch {
      const sql = await mailer();
      const existing = await sql<{ id: string }>`select id from "user" where lower(email) = ${data.email} limit 1`;
      if (existing[0]) throw new Error("Email or password is incorrect.");
      const { findZendeskInvite } = await import("./zendesk-invite");
      const invited = await findZendeskInvite(data.email).catch(() => null);
      if (!invited) throw new Error("No account yet. Create one first.");
      try {
        await auth.api.signUpEmail({
          body: { email: invited.email, password: data.password, name: invited.name },
          headers,
        });
        return { ok: true as const };
      } catch {
        throw new Error("Email or password is incorrect.");
      }
    }
  });

export const signUpPortal = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input && typeof input === "object" ? (input as { name?: unknown; email?: unknown; password?: unknown }) : {};
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    if (name.length < 2) throw new Error("Enter your name.");
    if (!email.includes("@")) throw new Error("Enter a valid email.");
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    return { name, email, password };
  })
  .handler(async ({ data }) => {
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    const { auth } = await import("./server");
    const headers = getRequestHeaders();
    const sql = await mailer();
    const { randomUUID } = await import("node:crypto");
    const existing = await sql<{ id: string }>`select id from "user" where lower(email) = ${data.email} limit 1`;
    if (existing[0]) throw new Error("That email already has an account. Sign in instead.");
    try {
      await auth.api.signUpEmail({
        body: { email: data.email, password: data.password, name: data.name },
        headers,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (/already|exist/i.test(message)) throw new Error("That email already has an account. Sign in instead.");
      throw new Error("The account could not be created.");
    }
    await sql`
      insert into shop_customers (email, name, password_hash, role_id, email_verified, grant_shop)
      values (${data.email}, ${data.name}, ${randomUUID()}, 'buyer', true, true)
      on conflict (email) do update set name = excluded.name
    `.catch(() => undefined);
    await ensureZendeskEndUser(data.name, data.email);
    return { ok: true as const };
  });

async function ensureZendeskEndUser(name: string, email: string) {
  try {
    const { zendeskSupportToken } = await import("./zendesk-invite");
    const token = await zendeskSupportToken();
    await fetch("https://managetechservices-16737.zendesk.com/api/v2/users.json", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user: { name, email, role: "end-user", verified: true } }),
    });
  } catch {
    /* the portal account is already created */
  }
}

async function mailer() {
  const { getSql } = await import("@/lib/db");
  return getSql();
}

export const requestPortalPassword = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ email: emailOf(input) }))
  .handler(async ({ data }) => {
    const { findZendeskInvite, sendZendeskPasswordCode, zendeskSupportToken } = await import("./zendesk-invite");
    await zendeskSupportToken();
    const { randomInt, randomUUID, createHash } = await import("node:crypto");
    const invited = await findZendeskInvite(data.email);
    if (!invited?.id) throw new Error("This email is not registered.");
    const sql = await mailer();
    const code = String(randomInt(100000, 1000000));
    await sendZendeskPasswordCode(invited, code);
    const identifier = `reset:${invited.email}`;
    await sql`delete from verification where identifier = ${identifier}`;
    await sql`
      insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
      values (${randomUUID()}, ${identifier}, ${JSON.stringify({ hash: createHash("sha256").update(code).digest("hex"), attempts: 0 })}, now() + interval '15 minutes', now(), now())
    `;
    return { ok: true as const };
  });

export const confirmPortalPassword = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const raw = input && typeof input === "object" ? (input as { email?: unknown; code?: unknown; password?: unknown }) : {};
    const email = emailOf(raw);
    const code = typeof raw.code === "string" ? raw.code.replace(/\s/g, "") : "";
    const password = typeof raw.password === "string" ? raw.password : "";
    if (!/^\d{6}$/.test(code)) throw new Error("Enter the 6-digit code from the email.");
    if (password.length < 8) throw new Error("Use at least 8 characters.");
    return { email, code, password };
  })
  .handler(async ({ data }) => {
    const { findZendeskInvite } = await import("./zendesk-invite");
    const { createHash, randomUUID } = await import("node:crypto");
    const invited = await findZendeskInvite(data.email);
    if (!invited) throw new Error("This email is not registered.");
    const sql = await mailer();
    const identifier = `reset:${invited.email}`;
    const rows = await sql<{ id: string; value: string; expiresAt: string | Date }>`
      select id, value, "expiresAt" from verification where identifier = ${identifier} order by "createdAt" desc limit 1
    `;
    const row = rows[0];
    if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
      throw new Error("That code has expired. Request a new one.");
    }
    const stored = JSON.parse(row.value) as { hash?: string; attempts?: number };
    const attempts = Number(stored.attempts) || 0;
    if (attempts >= 5) {
      await sql`delete from verification where identifier = ${identifier}`;
      throw new Error("Too many attempts. Request a new code.");
    }
    const hash = createHash("sha256").update(data.code).digest("hex");
    if (hash !== stored.hash) {
      await sql`update verification set value = ${JSON.stringify({ hash: stored.hash, attempts: attempts + 1 })}, "updatedAt" = now() where id = ${row.id}`;
      throw new Error("That code is not correct.");
    }
    await sql`delete from verification where identifier = ${identifier}`;
    const passwordHash = await hashPassword(data.password);
    const users = await sql<{ id: string }>`select id from "user" where lower(email) = ${invited.email} limit 1`;
    const user = users[0];
    if (user) {
      const accounts = await sql<{ id: string }>`
        select id from account where "userId" = ${user.id} and "providerId" = 'credential' limit 1
      `;
      if (accounts[0]) {
        await sql`update account set password = ${passwordHash}, "updatedAt" = now() where id = ${accounts[0].id}`;
      } else {
        await sql`
          insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
          values (${randomUUID()}, ${user.id}, 'credential', ${user.id}, ${passwordHash}, now(), now())
        `;
      }
      return { ok: true as const };
    }
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    const { auth } = await import("./server");
    await auth.api.signUpEmail({
      body: { email: invited.email, password: data.password, name: invited.name },
      headers: getRequestHeaders(),
    });
    return { ok: true as const };
  });
