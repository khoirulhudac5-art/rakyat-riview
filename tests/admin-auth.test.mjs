import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHmac, createHash } from "node:crypto";
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
      assert.equal(calls.length, 2);
      assert.ok(calls.every(item => item.url.startsWith("https://supabase.invalid/")));
      assert.equal(calls[1].url, "https://supabase.invalid/rest/v1/rpc/create_review_card");
      const stored = JSON.parse(calls[1].options.body);
      assert.equal(stored.p_card_code, "999");
      assert.match(stored.p_activation_code_hash, /^[a-f0-9]{64}$/);
      assert.equal(stored.p_activation_code_hash, createHash("sha256").update(created.body.activation_code).digest("hex"));
      assert.deepEqual(Object.keys(created.body).sort(), ["activation_code", "card_code", "card_url", "success"]);
      assert.equal(created.body.card_url, "https://rakyat-riview.vercel.app/r/999");
      assert.ok(!JSON.stringify(stored).includes(created.body.activation_code));
    });

    await t.test("invalid codes never reach RPC; leading zeroes are preserved", async () => {
      calls = [];
      for (const card_code of ["12", "12345678901", "abc", "123-4", 123, null]) {
        assert.equal((await call(create, { method: "POST", cookie, headers: adminHeaders, body: { card_code } })).statusCode, 400);
      }
      assert.equal(calls.length, 0);
      const result = await call(create, { method: "POST", cookie, headers: adminHeaders, body: { card_code: "001" } });
      assert.equal(result.body.card_code, "001");
      assert.match(result.body.activation_code, /^RR-001-[A-F0-9]{12}$/);
      assert.equal(calls.length, 1);
      assert.equal(JSON.parse(calls[0].options.body).p_card_code, "001");
    });

    await t.test("RPC failure and network failure never fall back to separate writes", async () => {
      const originalFetch = globalThis.fetch;
      const originalLog = console.error;
      console.error = () => {};
      try {
        for (const upstreamStatus of [409, 400, 404, 500]) {
          const requests = [];
          globalThis.fetch = async url => {
            requests.push(url);
            return { ok: false, status: upstreamStatus, text: async () => "mock RPC failure" };
          };
          const result = await call(create, { method: "POST", cookie, headers: adminHeaders, body: { card_code: "001" } });
          assert.equal(result.statusCode, 400);
          assert.deepEqual(Object.keys(result.body), ["error"]);
          assert.deepEqual(requests, ["https://supabase.invalid/rest/v1/rpc/create_review_card"]);
        }
        let attempts = 0;
        globalThis.fetch = async () => { attempts++; throw new Error("mock network failure"); };
        const result = await call(create, { method: "POST", cookie, headers: adminHeaders, body: { card_code: "001" } });
        assert.equal(result.statusCode, 500);
        assert.deepEqual(result.body, { error: "Terjadi gangguan server" });
        assert.equal(attempts, 1);
      } finally {
        globalThis.fetch = originalFetch;
        console.error = originalLog;
      }
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
