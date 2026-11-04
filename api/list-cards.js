import { requireAdminSession } from "../lib/admin-session.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!requireAdminSession(req, res)) return;

  try {
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/card?select=id,created_at,card_code,business_name,review_url&order=created_at.desc`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Gagal mengambil daftar kartu",
        detail: data,
      });
    }

    return res.status(200).json({
      success: true,
      cards: data,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Terjadi kesalahan server",
    });
  }
}
