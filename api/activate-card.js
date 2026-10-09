
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }

  const {
    card_code,
    activation_code,
    business_name,
    review_url,
    pin
  } = req.body || {};

  if (
    typeof card_code !== "string" ||
    !/^[a-zA-Z0-9_-]{1,30}$/.test(card_code) ||
    typeof activation_code !== "string" ||
    activation_code.length < 8 ||
    activation_code.length > 128 ||
    typeof business_name !== "string" ||
    !business_name.trim() ||
    business_name.length > 150 ||
    typeof review_url !== "string" ||
    review_url.length > 2048 ||
    !/^https:\/\/(maps\.app\.goo\.gl|www\.google\.com|google\.com|search\.google\.com)\//i.test(review_url) ||
    typeof pin !== "string" ||
    pin.length < 6 ||
    pin.length > 72
  ) {
    return res.status(400).json({ error: "Data aktivasi tidak valid" });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    return res.status(503).json({ error: "Server belum dikonfigurasi" });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/rpc/activate_review_card`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          p_card_code: card_code,
          p_activation_code: activation_code,
          p_business_name: business_name.trim(),
          p_review_url: review_url,
          p_pin: pin
        })
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Aktivasi belum dapat diproses"
      });
    }

    const activated = await response.json();

    return res.status(activated === true ? 200 : 400).json({
      success: activated === true,
      message: activated === true
        ? "Kartu berhasil diaktifkan"
        : "Kode aktivasi tidak valid atau kartu sudah aktif"
    });
  } catch {
    return res.status(500).json({
      error: "Terjadi gangguan server"
    });
  }
}
