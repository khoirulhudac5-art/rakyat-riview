import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";

const COOKIE = "__Host-rr_admin";
export const SESSION_SECONDS = 60 * 60 * 8;

function secret() {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new Error("Session secret missing");
  return value;
}

function signature(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function passwordsMatch(input, expected) {
  return typeof input === "string" && timingSafeEqual(
    createHash("sha256").update(input).digest(),
    createHash("sha256").update(expected).digest()
  );
}

export function sessionCookie(clear = false) {
  let value = "";
  if (!clear) {
    const payload = Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      nonce: randomBytes(24).toString("base64url")
    })).toString("base64url");
    value = `${payload}.${signature(payload)}`;
  }
  const expires = new Date(clear ? 0 : Date.now() + SESSION_SECONDS * 1000);
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_SECONDS}; Expires=${expires.toUTCString()}`;
}

// A custom header blocks cross-origin form submissions; no CORS access is granted.
export function requireAdminRequest(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.headers["x-admin-request"] !== "1" ||
      (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
    res.status(403).json({ error: "Permintaan tidak diizinkan" });
    return false;
  }
  return true;
}

export function requireAdminSession(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    secret();
  } catch {
    res.status(503).json({ error: "Sesi admin belum dikonfigurasi" });
    return false;
  }
  try {
    const cookies = (req.headers.cookie || "").split(";").map(part => part.trim());
    const matches = cookies.filter(part => part.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) throw new Error("Missing cookie");
    const token = matches[0].slice(COOKIE.length + 1);
    if (token.length > 1024) throw new Error("Invalid cookie");
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error("Invalid token");
    const [payload, supplied] = parts;
    const expected = signature(payload);
    if (supplied.length !== expected.length ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new Error("Invalid signature");
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(data.exp) || data.exp <= now || data.exp > now + SESSION_SECONDS ||
        typeof data.nonce !== "string") throw new Error("Expired session");
    return true;
  } catch {
    res.setHeader("Set-Cookie", sessionCookie(true));
    res.status(401).json({ error: "Sesi admin berakhir. Silakan login kembali." });
    return false;
  }
}
