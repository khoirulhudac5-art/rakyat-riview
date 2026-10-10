import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }

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

    // Simpan hanya HASH ke Supabase
    const response = await fetch(
      `${url}/rest/v1/card_activation`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          card_code,
          activation_code_hash: activationHash
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
