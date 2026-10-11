export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metode tidak diizinkan" });
  }

  const { password } = req.body || {};
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return res.status(500).json({ error: "Password admin belum dikonfigurasi" });
  }

  if (typeof password !== "string" || password !== adminPassword) {
    return res.status(401).json({ error: "Password salah" });
  }

  return res.status(200).json({
    success: true
  });
}
