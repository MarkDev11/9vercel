# Deploy 9vercel ke Vercel + Supabase

> Lokal (Laragon/Windows) tetap jalan pakai SQLite tanpa config apa pun.
> Vercel wajib Supabase — filesystem Vercel ephemeral (data SQLite hilang tiap deploy).

---

## 1) Supabase — sekali setup

### A. Buat / buka project
- Project live: **https://ymafcaqkinafioylcfyt.supabase.co** (`ref` = `ymafcaqkinafioylcfyt`)
- Project lama (referensi docs awal): `gnzojhgjguzimtpolrlq` — sudah tidak dipakai, diganti `ymaf...`.
- Region pooler live: **ap-northeast-1** (ditentukan Supabase saat create project — region lain akan `ENOTFOUND`).

### B. Jalankan schema SQL
1. Buka **Supabase Dashboard → SQL Editor → New query**
2. Copy-paste isi file `supabase/schema.sql` dari repo ini → **Run**
3. Aman di-run ulang (`IF NOT EXISTS`). Harus sukses tanpa error.

File itu membuat 11 tabel: `_meta`, `settings`, `providerConnections`, `providerNodes`, `proxyPools`, `apiKeys`, `combos`, `kv`, `usageHistory`, `usageDaily`, `requestDetails` + seed `settings(id=1)`.

> **Catatan deploy saat ini:** skema juga bisa auto-create saat boot (migrasi `001-initial` dijalankan di Vercel build/runtime walau `supabase/schema.sql` belum di-run manual). Tetap disarankan run manual sekali untuk verifikasi.

### C. Ambil `DATABASE_URL` yang benar
Di **Project Settings → Database → Connection string → URI**:

- **Untuk Vercel / serverless — WAJIB pakai Transaction Pooler (port 6543):**
  ```
  postgresql://postgres.ymafcaqkinafioylcfyt:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true
  ```
  Copy yang labelnya **Transaction pooler** (atau **Session pooler / 6543**). Jangan pakai yang `db.<ref>.supabase.co:5432` untuk Vercel — direct sering `ENETUNREACH` IPv6 di build Vercel dan tanpa pgbouncer cepat `too many clients`.

  > Region `ap-northeast-1` spesifik untuk project `ymaf...`. Jika project kamu di region lain, host pooler ikut region itu (mis. `aws-0-ap-southeast-1`, `aws-0-us-east-1`). Selalu copy dari dashboard, jangan tebak.

- **Untuk lokal/dev** boleh pakai direct `5432` juga jalan, tapi `6543?pgbouncer=true` juga boleh dan sudah diverifikasi.

> Ganti `[YOUR-PASSWORD]` dengan **Database password** yang kamu set saat create project.
> Lupa password? **Project Settings → Database → Reset database password**.

### D. Publishable key — tidak wajib untuk DB
`sb_publishable_e15rFgeaC0oDTEKV4pi--A_1E99dcNy` (live) dan `sb_secret_...` itu untuk Supabase Auth / PostgREST client.
**9vercel tidak memakainya untuk DB** — DB lewat `DATABASE_URL` (driver `postgres` / `postgres.js`), bukan `@supabase/supabase-js`. Jadi kalau cuma deploy DB, cukup `DATABASE_URL` saja.
Jika nanti pakai fitur Supabase Auth client-side, baru set:
```
NEXT_PUBLIC_SUPABASE_URL=https://ymafcaqkinafioylcfyt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_e15rFgeaC0oDTEKV4pi--A_1E99dcNy
```

---

## 2) Env vars

### Lokal (`C:\laragon\www\9vercel\.env` atau `.env.local`)
```env
# Kosongkan DATABASE_URL → otomatis pakai SQLite (file di %APPDATA%/9router)
# Atau isi kalau mau test Supabase dari lokal:
DATABASE_URL=postgresql://postgres.ymafcaqkinafioylcfyt:REALPASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true

JWT_SECRET=ganti-min-32-char-random
INITIAL_PASSWORD=admin123
```
Jika `DATABASE_URL` kosong atau masih `[YOUR-PASSWORD]`, app akan log:
`[DB] DATABASE_URL contains placeholder — skipping Supabase, falling back to SQLite` dan tetap jalan.

### Vercel (Dashboard → Project → Settings → Environment Variables)
Wajib:

| Key | Nilai | Catatan |
|-----|-------|---------|
| `DATABASE_URL` | `postgresql://postgres.ymafcaqkinafioylcfyt:REALPASSWORD@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true` | Pooling 6543 + `?pgbouncer=true`, user `postgres.<ref>`. Alias `POSTGRES_URL` juga didukung. |
| `JWT_SECRET` | random panjang (≥32 char) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `INITIAL_PASSWORD` | password login dashboard | `Admin123!` di deploy live saat ini |

Opsional tapi disarankan:

| Key | Nilai | Catatan |
|-----|-------|---------|
| `CRON_SECRET` | random hex 32 | Amankan `/api/cron/refresh-tokens`. Generate: `openssl rand -hex 32` |
| `NINEROUTER_PEER_TOKEN` | random hex 24+ | Bukti `x-9r-real-ip` valid untuk rate-limit login. Jika kosong, fallback `vercel-middleware` dipakai. |

Lainnya: `DATA_DIR` **jangan** di-set di Vercel (hanya self-host).

> Lihat `.env.example` di repo untuk referensi lengkap + komentar per-var.

---

## 3) Deploy ke Vercel

### Opsi A — via GitHub (disarankan)
1. Push repo `9vercel` ke GitHub (private boleh).
2. Vercel Dashboard → **Add New Project → Import** repo tersebut.
3. Framework preset: **Next.js** (auto-detect).
4. Set **Environment Variables** seperti tabel di atas (Production + Preview).
5. Deploy.

### Opsi B — via CLI
```bash
npm i -g vercel
cd C:/laragon/www/9vercel
vercel          # linking pertama kali
vercel --prod   # deploy production
vercel env add DATABASE_URL   # lalu paste value pooling 6543 ap-northeast-1
vercel env add JWT_SECRET
vercel env add INITIAL_PASSWORD
vercel --prod   # redeploy agar env kepakai
```

### Build
- Lokal test: `npm run build` (sudah verified — compiled successfully, 137 pages, postbuild copy standalone).
- Vercel build juga `npm run build`; `next.config.mjs` otomatis non-aktifkan `output: standalone` saat `VERCEL=1` supaya tidak bentrok dengan Vercel tracing. Verified: `VERCEL=1 npm run build` sukses, `No standalone build found` (expected).
- **Pooler di build:** log `[DB] Driver: supabase-postgres | host: aws-0-ap-northeast-1.pooler.supabase.com` menandakan env kepakai. Jika masih `better-sqlite3` atau `ENETUNREACH db.<ref>.supabase.co:5432`, cek `DATABASE_URL` masih direct — ganti ke pooler 6543.

---

## 4) Cron — refresh token OAuth

- File: `src/app/api/cron/refresh-tokens/route.js` (`GET`/`POST`, `maxDuration: 60`, fail-open).
- Jadwal: `vercel.json` → `crons: [{ path: "/api/cron/refresh-tokens", schedule: "0 0 * * *" }]` (daily — Hobby hanya boleh daily, `*/15` butuh Pro).
- Fungsi: memanggil `runBackgroundTokenRefreshTick()` — refresh OAuth yang akan expired dalam 30 menit.
- Auth: `CRON_SECRET` wajib — handler cek `Authorization: Bearer <CRON_SECRET>` atau `x-cron-secret`. Vercel Cron akan kirim Bearer otomatis jika secret di-set.
- **Fix penting:** `src/dashboardGuard.js` sudah menambahkan `/api/cron/refresh-tokens` ke `PUBLIC_API_PATHS`. Tanpa ini, `dashboardGuard` mengembalikan 401 duluan sebelum handler sempat cek `CRON_SECRET` — cron tidak akan pernah 200 walau secret benar (bug yang sudah diperbaiki di `7fecc90`).
- Verifikasi:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron/refresh-tokens
  # expect: {"ok":true,"elapsedMs":...}
  curl https://<project>.vercel.app/api/cron/refresh-tokens
  # expect: 401 Unauthorized
  ```

Di lokal/self-host, scheduler tetap jalan via `custom-server.js` + `initializeApp` (`setInterval` 5 menit) — tidak butuh cron.

---

## 5) Real IP & rate-limit di Vercel

- Self-host: `custom-server.js` stempel `x-9r-real-ip` dari TCP socket + `x-9r-peer-token` (per-process secret).
- Vercel: `src/proxy.js` (Next `proxy` / dulu `middleware`) stempel `x-9r-real-ip` dari `x-forwarded-for` (Vercel Edge) + `request.ip` fallback, lalu forward ke `dashboardGuard`.
- `src/lib/auth/trustedPeer.js` percaya header jika `x-9r-peer-token === NINEROUTER_PEER_TOKEN` atau (`VERCEL=1` dan token `vercel-middleware`). Ini mencegah spoof `x-9r-real-ip` untuk bypass `loginLimiter`.

Tidak perlu set `TRUST_PROXY`.

---

## 6) Verifikasi setelah deploy

1. Buka `https://<project>.vercel.app/login` → login pakai `INITIAL_PASSWORD` (`Admin123!`) → harus masuk dashboard.
2. Cek log Vercel (Deployments → Logs): harus ada `[DB] Driver: supabase-postgres | host: aws-0-ap-northeast-1.pooler.supabase.com` (bukan `better-sqlite3`). Jika masih `better-sqlite3`, berarti `DATABASE_URL` belum kepakai / masih placeholder.
3. Test API: `curl https://<project>.vercel.app/api/health` dan `POST /api/auth/login`.
4. Manual trigger cron (wajib pakai secret setelah fix dashboardGuard): `curl -H "Authorization: Bearer $CRON_SECRET" https://<project>.vercel.app/api/cron/refresh-tokens` → `{"ok":true,...}`
5. Di Supabase Dashboard → Table Editor → cek `providerConnections`, `settings`, dll terisi setelah kamu tambah provider. Test write: `POST /api/combos` lalu `GET /api/combos` harus persist (pooler Supabase, bukan SQLite ephemeral).

Live saat ini:
- Vercel: `https://9vercel-five.vercel.app` (alias) — `dpl_9F68ZRXK2tKPrkXcVZ6BQQkLdhcp` READY, pooler `ap-northeast-1:6543?pgbouncer=true`
- Supabase: `https://ymafcaqkinafioylcfyt.supabase.co`
- Vercel project: `prj_FceJ7eeNQ0VsVrXfhXODeWopioR6` / team `team_Q8bAw2rf7vFe7a4TJHMQtzPz`

---

## 7) Troubleshooting

| Gejala | Penyebab | Fix |
|--------|----------|-----|
| Build sukses tapi log `[DB] DATABASE_URL contains placeholder` | Env masih `[YOUR-PASSWORD]` | Ganti dengan password real, redeploy |
| `password authentication failed` | Password salah / user salah (`postgres` bukan `postgres.<ref>` untuk pooler) | Untuk pooler pakai `postgres.<ref>`; reset password di Supabase |
| `ENOTFOUND aws-0-...pooler.supabase.com` | Region pooler salah | Cek region project di dashboard; untuk `ymaf...` harus `ap-northeast-1` |
| `ENETUNREACH db.<ref>.supabase.co:5432` di build Vercel | Pakai direct 5432 di serverless (IPv6) | Ganti ke `6543?pgbouncer=true` pooler |
| `too many clients` / `max_connections` | Pakai port 5432 tanpa pgbouncer di serverless | Ganti ke `6543?pgbouncer=true` (Transaction pooler) |
| Cron selalu 401 walau `CRON_SECRET` benar | `dashboardGuard` block sebelum handler (bug lama) | Sudah fix di `7fecc90` — pastikan deploy terbaru; lalu test `curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/refresh-tokens` |
| Cron tidak jalan sama sekali | Hobby plan + schedule `*/15` | Repo sudah `0 0 * * *` (daily). `*/15` butuh Pro. |
| Login rate-limit bypass warning | `NINEROUTER_PEER_TOKEN` tidak set | Set di Vercel env (opsional, fallback ada tapi less strict) |
| Lokal Windows warning `DATA_DIR '/var/lib/9router' is a Unix path` | `.env` dari Linux | Kosongkan `DATA_DIR` di lokal atau set ke path Windows valid; sudah auto-fallback ke `%APPDATA%/9router` |

---

## 8) File yang diubah untuk Vercel

- `src/lib/db/adapters/supabaseAdapter.js` — baru, translate `?→$n`, `INSERT OR REPLACE→ON CONFLICT`, normalize camelCase
- `src/lib/db/driver.js` — auto-switch Supabase-first, `wrapAsync` always-async, placeholder guard, `global._supabaseSql` reuse
- `supabase/schema.sql` — DDL Postgres (IF NOT EXISTS, unquoted identifiers + normalize)
- `src/proxy.js` — stempel `x-9r-real-ip` untuk Vercel (gabung dengan dashboardGuard)
- `src/dashboardGuard.js` — tambah `/api/cron/refresh-tokens` ke `PUBLIC_API_PATHS` agar `CRON_SECRET` bisa lewat
- `src/lib/auth/trustedPeer.js` — trust Vercel middleware fallback
- `src/shared/services/initializeApp.js` — skip cloudflared/MITM di `VERCEL=1`, cron gantikan interval
- `src/app/api/cron/refresh-tokens/route.js` — baru (`GET`/`POST`, cek `Bearer`/`x-cron-secret`, fail-open)
- `vercel.json` — crons `0 0 * * *` (daily Hobby) + `maxDuration: 60`
- `next.config.mjs` — `output: standalone` dimatikan saat `VERCEL=1`
- `package.json` — tambah `postgres@^3.4.9`
- `.env.example` — dokumentasi env Supabase/Vercel
- `src/lib/db/**` — semua repos/helpers/migrate/index di-async-kan untuk Postgres
