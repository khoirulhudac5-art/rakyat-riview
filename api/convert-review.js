
const allowedHosts = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "search.google.com"
]);

function validGoogleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      allowedHosts.has(url.hostname);
  } catch {
    return false;
  }
}

function extractPlaceId(value) {
  try {
    const url = new URL(value);

    const id =
      url.searchParams.get("placeid") ||
      url.searchParams.get("query_place_id");

    if (id && /^ChI[A-Za-z0-9_-]+$/.test(id)) {
      return id;
    }

    const match = decodeURIComponent(value).match(
      /(?:placeid=|query_place_id=|!1s)(ChI[A-Za-z0-9_-]+)/i
    );

    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metode tidak diizinkan"
    });
  }

  const { maps_url } = req.body || {};

  if (
    typeof maps_url !== "string" ||
    maps_url.length > 2048 ||
    !validGoogleUrl(maps_url)
  ) {
    return res.status(400).json({
      error: "Masukkan link Google Maps yang valid"
    });
  }

  try {
    let placeId = extractPlaceId(maps_url);

    if (!placeId) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(), 5000
      );

      try {
        const response = await fetch(maps_url, {
          method: "GET",
          redirect: "follow",
          signal: controller.signal
        });

        if (!validGoogleUrl(response.url)) {
          return res.status(422).json({
            error: "Tujuan link bukan Google Maps"
          });
        }

        placeId = extractPlaceId(response.url);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!placeId) {
      return res.status(422).json({
        error: "Place ID tidak ditemukan. Gunakan link ulasan langsung."
      });
    }

    return res.status(200).json({
      success: true,
      review_url:
        "https://search.google.com/local/writereview?placeid=" +
        encodeURIComponent(placeId)
    });
  } catch {
    return res.status(422).json({
      error: "Link belum bisa dikonversi otomatis"
    });
  }
}
