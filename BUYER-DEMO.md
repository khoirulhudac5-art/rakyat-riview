# Dashboard Pembeli V2 — demo frontend

Jalankan dari root proyek dengan Node.js (tanpa instalasi dependency):

```powershell
node scripts/preview-buyer.mjs
```

Buka http://127.0.0.1:4173/dashboard.html atau
http://127.0.0.1:4173/kartu.html?id=demo-101. Hentikan server dengan Ctrl+C.
Halaman aktivasi tersedia di http://127.0.0.1:4173/aktivasi.html beserta CSS-nya.
JavaScript aktivasi sudah tertanam di HTML. Server hanya melayani daftar file
frontend yang diizinkan, terikat ke localhost, dan tidak menjalankan atau
meneruskan endpoint API. Konversi link dan pengiriman aktivasi tidak dapat
diselesaikan pada preview statis ini; database tidak dihubungi.
Jika server lama masih berjalan, hentikan dengan Ctrl+C lalu jalankan ulang
perintah di atas agar daftar file baru dimuat.

Demo berisi tiga kartu sintetis, dua aktif dan satu belum aktif, 550 kunjungan
dan 509 redirect dalam periode tujuh hari contoh. Grafik tidak mewakili data
pelanggan atau ulasan Google yang dikirim.

- Cari nama/kode kartu atau filter berdasarkan status.
- Buka detail/kelola, edit nama dan URL Google Review, lalu simpan.
- Perubahan disimpan hanya pada sessionStorage tab browser yang sama. Tidak
  ada autentikasi, fetch API, database, atau pembaruan kartu asli.
- Gunakan pilihan "Pratinjau kondisi" untuk loading, kosong, dan gagal memuat.
- Centang "Simulasikan gagal menyimpan" pada detail untuk mencoba kegagalan.
- "Reset data demo" mengembalikan semua fixture awal.
- Parameter `?state=loading`, `?state=empty`, dan `?state=error` juga didukung.
- Untuk detail, gunakan `?id=demo-101&state=error`. ID yang tidak dikenal
  menampilkan kartu tidak ditemukan. Kartu belum aktif tetap belum aktif
  setelah edit; pengeditan hanya merupakan draft demo.

Tampilan memakai tema light, navy dan aksen biru, ikon SVG, serta font stack
Inter/Geist dengan fallback Segoe UI/Arial. Tidak ada font eksternal yang
diunduh. Pada kartu belum aktif, tombol Aktivasi membuka pratinjau detail;
fitur aktivasi produksi tidak dipanggil. Statistik tetap berasal dari fixture
yang sama, tanpa angka pertumbuhan atau klaim performa tambahan.

Pengujian logika interaksi:

```powershell
node --test tests/buyer-dashboard.test.mjs
node --check assets/buyer.js
```

Tes menggunakan adapter DOM ringan dan tidak membuktikan layout browser,
validasi HTML native, atau tampilan responsif. Periksa secara manual pada
lebar 360px, 720px, dan desktop: menu, fokus keyboard, grafik, form,
serta pesan loading/sukses/gagal. CSS tidak memakai font atau aset eksternal.

Halaman aktivasi/admin, endpoint API, route `/r/:code`, dan file migration
tidak diubah oleh demo ini. Login dan database akan diintegrasikan kemudian.

## Preview produk terpadu V2 (lanjutan terbaru)

Demo statis di atas tetap tersedia. Untuk mencoba alur lengkap pembeli dan
Admin dengan akun/kartu sintetis yang disimpan di server lokal, gunakan
`node scripts/preview-product.mjs`, lalu buka
http://127.0.0.1:4186/preview-new-card atau
http://127.0.0.1:4186/admin-v2.html (sandi simulasi `demo-admin`).
Panduan dan batas integrasi nyata: [PRODUCT-PREVIEW.md](PRODUCT-PREVIEW.md).
Preview ini tidak memakai Supabase dan tidak membuka akses production.
