
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metode tidak diizinkan."
    });
  }

  const mapsUrl = req.body?.maps_url;

  if (typeof mapsUrl !== "string" || !mapsUrl.trim() || mapsUrl.length > 8192) {
    return res.status(400).json({
      error: "Masukkan link Google Maps yang valid."
    });
  }

  try {
    const url = new URL(mapsUrl.trim());
    const host = url.hostname.toLowerCase();

    const allowed =
      host === "maps.app.goo.gl" ||
      host === "goo.gl" && url.pathname.startsWith("/maps/") ||
      host === "google.com" ||
      host.endsWith(".google.com") ||
      /^google\.[a-z.]+$/.test(host) ||
      host === "maps.google.com";

    if (url.protocol !== "https:" || !allowed) {
      return res.status(400).json({
        error: "Gunakan link Google Maps."
      });
    }

    const response = await fetch(
      "https://productmate.com/api/v1/google-review-link",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          maps_url: mapsUrl.trim()
        }),
        signal: AbortSignal.timeout(15000)
      }
    );

    if (response.status === 429) {
      return res.status(429).json({
        error: "Batas konversi tercapai. Coba lagi setelah 1 menit."
      });
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.review_url) {
      return res.status(422).json({
        error: "Konversi gagal. Coba link Bagikan Google Maps yang lain."
      });
    }

    const reviewUrl = new URL(data.review_url);
    if (
      reviewUrl.protocol !== "https:" ||
      reviewUrl.hostname !== "search.google.com" ||
      reviewUrl.pathname !== "/local/writereview" ||
      !/^ChI[A-Za-z0-9_-]+$/.test(
        reviewUrl.searchParams.get("placeid") || ""
      )
    ) {
      return res.status(502).json({
        error: "Hasil konversi tidak valid."
      });
    }

    return res.status(200).json({
      place_id: data.place_id,
      review_url: reviewUrl.toString()
    });

  } catch (error) {
    return res.status(502).json({
      error: "Layanan konversi sedang bermasalah. Coba lagi."
    });
  }
}
