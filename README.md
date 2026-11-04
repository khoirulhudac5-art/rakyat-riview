# rakyat-riview

## Admin V2

Environment server yang diperlukan:

- `ADMIN_PASSWORD`: password admin yang sudah digunakan.
- `ADMIN_SESSION_SECRET`: secret acak minimal 32 byte, terpisah dari password admin.
- `SUPABASE_URL` dan `SUPABASE_SECRET_KEY`: konfigurasi server yang sudah digunakan.

Buat secret menggunakan generator kriptografis, misalnya `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`. Simpan hasilnya hanya di environment server; jangan commit secret.

Sesi berupa cookie bertanda tangan HMAC-SHA256 yang diverifikasi server, berlaku absolut 8 jam tanpa perpanjangan otomatis. Cookie memakai `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`, dan `Path=/`, tanpa atribut Domain. Jalankan melalui HTTPS, termasuk untuk pengujian browser lokal.

Login, pembuatan kartu, dan logout memerlukan header `X-Admin-Request: 1` untuk menolak pengiriman form lintas situs. Jangan menambahkan izin CORS lintas origin pada endpoint admin.

Logout menghapus cookie browser. Sesi bersifat stateless: salinan token yang telah dicuri tetap berlaku sampai kedaluwarsa. Rotasi `ADMIN_SESSION_SECRET` membatalkan semua sesi. Pencabutan per sesi dan pembatasan percobaan login memerlukan tahap lanjutan; tidak ada penyimpanan sesi atau perubahan database pada tahap ini.

Pengujian lokal tanpa koneksi Supabase: `node --test tests/admin-auth.test.mjs`.
