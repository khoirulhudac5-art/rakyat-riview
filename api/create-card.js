import crypto from "crypto";
import { requireAdminRequest, requireAdminSession } from "../lib/admin-session.mjs";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }

  if (!requireAdminRequest(req, res) || !requireAdminSession(req, res)) return;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return res.status(503).json({ error: "Server belum dikonfigurasi" });
  }

  try {
    const { card_code } = req.body || {};

    if (
      typeof card_code !== "string" ||
      !/^[0-9]{3,10}$/.test(card_code)
    ) {
      return res.status(400).json({ error: "Kode kartu tidak valid" });
    }

    // Buat kode aktivasi unik
    const randomCode = crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase();

    const activationCode = `RR-${card_code}-${randomCode}`;

    // Hash SHA-256 seperti sistem kartu 003
    const activationHash = crypto
      .createHash("sha256")
      .update(activationCode)
      .digest("hex");
    // Satu RPC: kedua insert berhasil bersama atau seluruhnya dibatalkan.
    // Kode aktivasi asli tidak dikirim ke database.
    const response = await fetch(
      `${url}/rest/v1/rpc/create_review_card`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          p_card_code: card_code,
          p_activation_code_hash: activationHash
        })
      }
    );

    if (!response.ok) {
      const detail = await response.text();

      console.error("Create card failed:", response.status, detail);

      return res.status(400).json({
        error: "Kartu gagal dibuat. Pastikan kode kartu belum digunakan."
      });
    }

    // Kode asli hanya dikirim ke admin saat kartu dibuat
    return res.status(200).json({
      success: true,
      card_code,
      activation_code: activationCode,
      card_url: `https://rakyat-riview.vercel.app/r/${card_code}`
    });

  } catch (error) {
    console.error("Create card error:", error);

    return res.status(500).json({
      error: "Terjadi gangguan server"
    });
  }
}
