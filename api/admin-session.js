import { requireAdminSession } from "../lib/admin-session.mjs";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Metode tidak diizinkan" });
  if (!requireAdminSession(req, res)) return;
  return res.status(200).json({ success: true });
}
