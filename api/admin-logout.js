import { requireAdminRequest, sessionCookie } from "../lib/admin-session.mjs";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak diizinkan" });
  if (!requireAdminRequest(req, res)) return;
  res.setHeader("Set-Cookie", sessionCookie(true));
  return res.status(200).json({ success: true });
}
