
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }

  const { card_code, pin, review_url } = req.body || {};

  if (
    typeof card_code !== "string" ||
    !/^[a-zA-Z0-9_-]{1,30}$/.test(card_code) ||
    typeof pin !== "string" ||
    pin.length < 6 ||
    pin.length > 72 ||
    typeof review_url !== "string" ||
    review_url.length > 2048 ||
    !/^https:\/\/(maps\.app\.goo\.gl|www\.google\.com|google\.com|search\.google\.com)\//i.test(review_url)
  ) {
    return res.status(400).json({ error: "Data tidak valid" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return res.status(503).json({ error: "Server belum dikonfigurasi" });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/rpc/update_card_review_url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          p_card_code: card_code,
          p_pin: pin,
          p_review_url: review_url
        })
      }
    );

    if (!response.ok) {
      return res.status(502).json({ error: "Gagal memproses permintaan" });
    }

    const updated = await response.json();

    return res.status(updated === true ? 200 : 400).json({
      success: updated === true,
      message: updated === true
        ? "Link berhasil diperbarui"
        : "PIN salah, kartu terkunci, atau link tidak valid"
    });
  } catch {
    return res.status(500).json({ error: "Terjadi gangguan server" });
  }
}
