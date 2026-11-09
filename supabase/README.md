# RPC pembuatan kartu atomik

Status: migration disiapkan untuk review, belum diterapkan ke database mana pun.

`create_review_card(text, text)` memasukkan `card` lalu `card_activation` dalam satu pemanggilan PostgreSQL. Exception insert dibiarkan naik ke PostgREST sehingga seluruh transaksi dibatalkan. Tidak ada fallback ke dua REST insert. Kode aktivasi tetap dibuat di server dengan format `RR-{kode}-{12 digit hex uppercase}`; database hanya menerima SHA-256 hex lowercase.

## Prasyarat review schema

Schema produksi belum tersedia di repository. Sebelum menjalankan migration, verifikasi di salinan lokal/staging:

- `public.card.card_code` dan `public.card_activation.card_code` menyimpan teks sehingga nol awal tetap utuh.
- `card.card_code` memiliki constraint UNIQUE/PRIMARY KEY, begitu juga `card_activation.card_code` untuk relasi satu kartu/satu aktivasi; FK mengacu ke kartu yang benar.
- Kolom wajib lain memiliki default yang cocok dengan insert lama. Hash aktivasi menerima teks sepanjang 64 karakter.
- Trigger/constraint yang ada kompatibel dan tidak memiliki efek samping eksternal yang tidak dapat di-rollback.
- Role `service_role` memiliki USAGE schema, hak INSERT/SELECT yang diperlukan, akses sequence/default, serta akses RLS yang sesuai. Fungsi memakai SECURITY INVOKER dan search_path kosong; tidak menaikkan hak akses caller.
- Signature `public.create_review_card(text,text)` belum digunakan. Migration memakai CREATE FUNCTION agar berhenti jika ada fungsi lama, bukan menimpanya.

Migration tidak membuat/mengubah tabel, data kartu, RPC aktivasi/pembaruan lama, atau kebijakan RLS. Hak EXECUTE RPC baru dibatasi ke `service_role`; review juga default grants/custom roles bila project memilikinya.

## Urutan penerapan (manual, setelah persetujuan)

1. Review migration `migrations/20261104000100_create_review_card.sql` dan prasyarat di atas pada database lokal/staging dengan schema yang sama. Ambil backup schema sesuai proses operasional.
2. Terapkan migration ke lokal/staging dengan psql menggunakan koneksi yang sudah dikonfigurasi secara aman: `psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20261104000100_create_review_card.sql`. File sudah memiliki BEGIN/COMMIT; jangan membungkusnya lagi dengan `--single-transaction`.
3. Jalankan pengujian integrasi hanya di lokal/staging: `psql -X -v ON_ERROR_STOP=1 -f supabase/tests/create_review_card.sql`. Tes memaksa kegagalan insert kedua, memeriksa rollback kedua tabel, penolakan duplikat, validasi input, serta grants RPC. Trigger dan data tes dibatalkan dengan ROLLBACK; koneksi harus berhenti/ditutup jika tes gagal.
4. Jalankan `node --test tests/admin-auth.test.mjs`, lalu uji API pada staging dengan sesi admin. Pastikan secret server menggunakan role backend, bukan publishable/anon key.
5. Setelah review dan persetujuan terpisah, terapkan migration yang sama ke produksi melalui proses migration resmi, baru rilis perubahan API. Jangan rilis API lebih dahulu: tanpa RPC, pembuatan kartu akan gagal dengan respons error tanpa menulis sebagian data.

Tidak diperlukan environment baru. Tidak ada proses deployment/migration otomatis pada perubahan ini.

## Batasan dan pemulihan

- Permintaan bersamaan untuk kode yang sama bergantung pada constraint UNIQUE; satu sukses dan lainnya gagal tanpa mengganti kode aktivasi.
- Jika respons jaringan hilang sesudah transaksi commit, kartu bisa sudah dibuat meski admin melihat error. Ini bukan operasi idempotent; jangan mengulang otomatis atau mengeluarkan kode aktivasi baru untuk kartu yang sudah ada.
- Kartu tanpa aktivasi yang sudah telanjur dibuat oleh implementasi lama tidak diperbaiki migration ini.
- Jika perlu membatalkan, hentikan penggunaan API baru terlebih dahulu. Setelah dipastikan tidak ada caller, fungsi baru bisa dihapus melalui migration terpisah: `DROP FUNCTION public.create_review_card(text, text);`. Jangan menghapus data kartu. Mengembalikan API lama juga mengembalikan risiko insert parsial.
