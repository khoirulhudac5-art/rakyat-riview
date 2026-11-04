import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { Script } from "node:vm";
import { sessionCookie, SESSION_SECONDS } from "../lib/admin-session.mjs";

// Load Vercel ESM handlers without changing the repository's package/module setup.
async function handler(name) {
  const source = (await readFile(new URL(`../api/${name}.js`, import.meta.url), "utf8"))
    .replaceAll('"../lib/admin-session.mjs"', JSON.stringify(new URL("../lib/admin-session.mjs", import.meta.url).href));
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).default;
}

const login = await handler("admin-login");
const logout = await handler("admin-logout");
const session = await handler("admin-session");
const create = await handler("create-card");
const list = await handler("list-cards");

async function call(fn, { method = "GET", cookie, body, headers = {} } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  await fn({ method, body, headers: { ...headers, ...(cookie ? { cookie } : {}) } }, response);
  return response;
}

test("admin authentication and protected handlers (mocked upstream only)", async t => {
  const previousEnv = { ...process.env };
  const previousFetch = globalThis.fetch;
  process.env.ADMIN_SESSION_SECRET = "test-only-secret-".repeat(4);
  process.env.ADMIN_PASSWORD = "test-only-password";
  process.env.SUPABASE_URL = "https://supabase.invalid";
  process.env.SUPABASE_SECRET_KEY = "test-only-key";
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => [], text: async () => "" };
  };
  const adminHeaders = { "x-admin-request": "1", "sec-fetch-site": "same-origin" };
  let cookie;
  try {
    await t.test("login rejects wrong password and cross-site or missing custom header", async () => {
      assert.equal((await call(login, { method: "POST", body: { password: "wrong" }, headers: adminHeaders })).statusCode, 401);
      assert.equal((await call(login, { method: "POST", body: { password: process.env.ADMIN_PASSWORD } })).statusCode, 403);
      assert.equal((await call(login, { method: "POST", headers: { ...adminHeaders, "sec-fetch-site": "cross-site" } })).statusCode, 403);
      assert.equal((await call(login)).statusCode, 405);
    });

    await t.test("login sets hardened expiring cookie without exposing token in JSON", async () => {
      const result = await call(login, { method: "POST", body: { password: process.env.ADMIN_PASSWORD }, headers: adminHeaders });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body, { success: true });
      const value = result.headers["set-cookie"];
      for (const attribute of ["__Host-rr_admin=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_SECONDS}`, "Expires="]) assert.ok(value.includes(attribute));
      assert.ok(!value.includes("Domain="));
      assert.equal(result.headers["cache-control"], "no-store");
      cookie = value.split(";")[0];
      assert.equal((await call(session, { cookie })).statusCode, 200);
      assert.notEqual(sessionCookie().split(";")[0], cookie);
    });

    await t.test("missing, tampered, duplicate, expired and malformed sessions fail before upstream", async () => {
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1, nonce: "test" })).toString("base64url");
      const signed = createHmac("sha256", process.env.ADMIN_SESSION_SECRET).update(payload).digest("base64url");
      for (const invalid of [undefined, `${cookie}x`, `${cookie}; ${cookie}`, "__Host-rr_admin=bad", `__Host-rr_admin=${payload}.${signed}`]) {
        assert.equal((await call(session, { cookie: invalid })).statusCode, 401);
        assert.equal((await call(list, { cookie: invalid })).statusCode, 401);
        assert.equal((await call(create, { method: "POST", cookie: invalid, headers: adminHeaders, body: { card_code: "999" } })).statusCode, 401);
      }
      assert.equal(calls.length, 0);
    });

    await t.test("valid session preserves list/create behavior; cross-site creation fails", async () => {
      assert.equal((await call(create, { method: "POST", cookie, headers: { ...adminHeaders, "sec-fetch-site": "cross-site" } })).statusCode, 403);
      assert.equal(calls.length, 0);
      const result = await call(list, { cookie });
      assert.equal(result.statusCode, 200);
      assert.deepEqual(result.body.cards, []);
      const created = await call(create, { method: "POST", cookie, headers: adminHeaders, body: { card_code: "999" } });
      assert.equal(created.statusCode, 200);
      assert.equal(created.body.card_code, "999");
      assert.match(created.body.activation_code, /^RR-999-[A-F0-9]{12}$/);
      assert.equal(calls.length, 3);
      assert.ok(calls.every(item => item.url.startsWith("https://supabase.invalid/")));
      const stored = JSON.parse(calls[2].options.body);
      assert.match(stored.activation_code_hash, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(stored).includes(created.body.activation_code));
    });

    await t.test("logout clears cookie with identical scope, including expired sessions", async () => {
      assert.equal((await call(logout, { method: "POST" })).statusCode, 403);
      const result = await call(logout, { method: "POST", headers: adminHeaders });
      assert.equal(result.statusCode, 200);
      assert.match(result.headers["set-cookie"], /^__Host-rr_admin=; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=0;/);
      assert.equal((await call(session, { cookie: result.headers["set-cookie"].split(";")[0] })).statusCode, 401);
    });

    await t.test("secret rotation invalidates sessions; missing/short secret fails closed", async () => {
      process.env.ADMIN_SESSION_SECRET = "rotated-test-only-secret-".repeat(3);
      assert.equal((await call(session, { cookie })).statusCode, 401);
      for (const value of ["", "short"]) {
        process.env.ADMIN_SESSION_SECRET = value;
        assert.equal((await call(session, { cookie })).statusCode, 503);
        assert.equal((await call(list, { cookie })).statusCode, 503);
        assert.equal((await call(login, { method: "POST", headers: adminHeaders, body: { password: process.env.ADMIN_PASSWORD } })).statusCode, 503);
      }
    });
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of ["ADMIN_SESSION_SECRET", "ADMIN_PASSWORD", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("admin browser scripts parse and no longer use sessionStorage", async () => {
  for (const file of ["admin.html", "admin-login.html"]) {
    const html = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!html.includes("sessionStorage"));
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1], { filename: file });
  }
});
