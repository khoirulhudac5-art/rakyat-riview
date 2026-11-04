import { passwordsMatch, requireAdminRequest, sessionCookie } from "../lib/admin-session.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }
  if (!requireAdminRequest(req, res)) return;

  const { password } = req.body || {};
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({ error: "Password admin belum dikonfigurasi" });
  }

  if (!passwordsMatch(password, adminPassword)) {
    return res.status(401).json({ error: "Password salah" });
  }

  try {
    res.setHeader("Set-Cookie", sessionCookie());
  } catch {
    return res.status(503).json({ error: "Sesi admin belum dikonfigurasi" });
  }
  return res.status(200).json({
    success: true
  });
}
