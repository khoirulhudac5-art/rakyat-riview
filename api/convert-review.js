
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metode tidak diizinkan"
    });
  }

  const { maps_url } = req.body || {};

  if (typeof maps_url !== "string" || maps_url.length > 2048) {
    return res.status(400).json({
      error: "Link Google Maps tidak valid"
    });
  }

  let url;

  try {
    url = new URL(maps_url);
  } catch {
    return res.status(400).json({
      error: "Format link tidak valid"
    });
  }

  const allowedHosts = [
    "google.com",
    "www.google.com",
    "search.google.com",
    "maps.google.com"
  ];

  if (url.protocol !== "https:" ||
      !allowedHosts.includes(url.hostname)) {
    return res.status(400).json({
      error: "Gunakan link Google Maps atau Google Review"
    });
  }

  const placeId = url.searchParams.get("placeid") ||
                  url.searchParams.get("query_place_id");

  if (!placeId || !/^ChI[A-Za-z0-9_-]+$/.test(placeId)) {
    return res.status(422).json({
      error: "Place ID belum ditemukan. Link Maps pendek memerlukan proses konversi tambahan."
    });
  }

  return res.status(200).json({
    success: true,
    review_url:
      "https://search.google.com/local/writereview?placeid=" +
      encodeURIComponent(placeId)
  });
}
