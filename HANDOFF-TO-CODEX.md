# HANDOFF DOKUMENTASI — RAKYAT REVIEW V2

Dokumen ini disiapkan untuk melanjutkan pengembangan Rakyat Review V2 menggunakan Codex.

---

## 1. STATUS PRODUCTION & REPOSITORY

- **Repository:** `https://github.com/khoirulhudac5-art/rakyat-riview.git`
- **Branch Handoff:** `v2-handoff-codex`
- **Branch Utama:** `main` (tidak disentuh/ditimpa)
- **Branch Development:** `v2-development` (tidak disentuh/ditimpa)
- **Live Production URL:** `https://rakyat-riview.vercel.app`
- **Active Production Deployment ID:** `dpl_4V8MDojBf1gFG27Zz69wmkgP6cBD`
- **Rollback Target Deployment ID:** `dpl_83V3fRAtHEBSenc7eFBYkTCwXtcF`

---

## 2. ARSITEKTUR & STRUKTUR FILE

```text
rakyat-riview/
├── api/
│   ├── buyer.js               # Handler API dashboard pembeli (klaim, update profile, list kartu)
│   ├── buyer-status.js        # Handler status klaim kartu publik
│   ├── buyer-google.js        # Integrasi Google OAuth & verifikasi
│   ├── card-redirect.js       # Dynamic routing /r/KODE (review vs aktivasi)
│   ├── create-card.js         # Handler admin generate kartu batch
│   └── pilot-redirect.js      # Redirect legacy/pilot
├── assets/
│   ├── admin-v2.css / .js     # UI & Logic Dashboard Admin V2
│   ├── buyer.css / .js        # UI & Logic Portal Pembeli
│   └── rakyat-review-logo.png # Logo resmi aplikasi
├── lib/
│   ├── admin-production.mjs   # Helper admin produksi & Supabase bridge
│   ├── admin-readonly.mjs     # Helper pembacaan inventory kartu
│   ├── buyer-service.mjs      # Core logic backend pembeli (RLS-safe, claim, scan tracking)
│   ├── card-code.mjs          # Generator & validator kode kartu 8-karakter
│   └── public-pilot.mjs       # Helper routing publik
├── pembeli/
│   ├── account.css / .js      # Halaman manajemen akun pembeli
│   ├── auth-callback.html     # Callback receiver untuk email verification link
│   ├── auth-callback.mjs      # Logic penanganan token Supabase & auto-redirect ke klaim
│   ├── drafts.mjs             # State persistence untuk form aktivasi
│   ├── experience.mjs         # Multi-step claim wizard experience
│   ├── index.html             # Dashboard utama pembeli
│   ├── mulai.html             # Halaman aktivasi kartu (V2 claim wizard)
│   └── wizard.mjs             # Wizard flow controller
├── r/
│   └── 001/index.html         # Template redirect fallback
├── supabase/migrations/
│   ├── 20261109000100_v2_card_production_and_activation.sql
│   ├── 20261109000200_v2_public_card_status.sql
│   ├── 20261109000300_v2_short_code_direct_claim.sql
│   ├── 20261110000100_v2_buyer_dashboard.sql
│   ├── 20261110000200_v2_scan_analytics.sql
│   ├── 20261110000300_v2_card_filter_analytics.sql
│   └── 20261111000100_v2_admin_card_archive.sql
├── tests/
│   └── final-pre-production-audit.test.mjs  # 36 skenario audit pre-production
├── index.html                 # Landing page
├── kartu.html                 # Status kartu viewer
├── preview.html               # Preview generator
└── vercel.json                # Routing rewrites & headers Vercel
```

---

## 3. FITUR UTAMA YANG SUDAH LIVE & TERUJI

1. **Routing Kartu Otomatis (`/r/KODE`):**
   - Kartu belum aktif: Otomatis redirect ke `/pembeli/mulai.html?kartu=KODE` (alur aktivasi V2).
   - Kartu aktif: Otomatis redirect langsung ke Google Review URL pembeli + increment scan counter.
2. **Aktivasi Kartu Dua Mode (V2):**
   - **Mode 1 (Pembeli Baru):** Pendaftaran email + password -> verifikasi email -> callback via `/pembeli/auth-callback.html` -> otomatis login & kartu terklaim ke akun pembeli.
   - **Mode 2 (Sudah Punya Akun):** Login langsung -> otomatis klaim kartu ke akun pembeli yang sudah ada.
3. **Admin Dashboard V2:**
   - Nomor urut produksi kartu (001, 002, ...) terurut berdasarkan `created_at ASC`.
   - Warna nomor urut: 3-warna Google (#EA4335, #FBBC04, #34A853) saat kartu aktif; abu-abu (#9CA3AF) saat belum aktif.
   - Fitur Arsip & Pulihkan kartu: Tersimpan permanen di Supabase (`is_archived`), kartu diarsipkan tidak muncul di daftar utama namun QR/NFC tetap aktif normal.
   - Batch generator kartu baru dengan format QR PNG download & export.
4. **Dashboard Pembeli:**
   - Multi-kartu per akun: Pembeli dapat memiliki dan mengelola banyak kartu sekaligus.
   - Statistik scan per kartu dan total scan.
   - Modal edit nama usaha & Google Review link (responsive desktop & mobile).
5. **Keamanan & RLS (Supabase):**
   - Row Level Security (RLS) aktif ketat di Supabase.
   - Service role key tidak pernah terekspos ke frontend.
   - Token callback dibersihkan dari URL setelah verifikasi sesi.

---

## 4. CARA MENJALANKAN AUDIT & TEST SUITE

Untuk memverifikasi seluruh sistem (36 checks):
```bash
node tests/final-pre-production-audit.test.mjs
```

---

## 5. CATATAN PENTING UNTUK CODEX

- **Jangan ubah konfigurasi database yang sudah berjalan** kecuali ada kebutuhan migrasi baru dengan skema bertahap (additive migrations).
- File `.env` dan rahasia produksi tidak disimpan di Git repository demi keamanan.
- Branch utama (`main`) dan branch development (`v2-development`) tetap dipertahankan; seluruh source code versi live Vercel ini disimpan di branch `v2-handoff-codex`.
