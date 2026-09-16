# CSV Preview

Pratinjau file CSV langsung di browser. Upload (atau jatuhkan) sebuah file `.csv`, dan langsung
muncul tabel interaktif, ringkasan tiap kolom, dan grafik. **Tidak ada data yang dikirim ke server** —
semua parsing terjadi di perangkat pengguna.

🔗 Live: <http://myst-tech.com/csv-preview/>

## Fitur

- **Parser CSV sendiri** (RFC 4180): mendukung tanda kutip, koma di dalam field, dan newline di dalam field.
- **Deteksi pemisah otomatis** — `,` `;` Tab `|`.
- **Deteksi tipe kolom** — angka / tanggal / teks, termasuk angka format Indonesia (`1.234,56`) dan `Rp`/`%`.
- **Kolom teks panjang** (catatan/deskripsi) dideteksi otomatis: dipangkas 2 baris di tabel, dibaca utuh
  lewat panel detail baris (klik baris; navigasi ↑/↓, Esc untuk tutup). Ada juga tombol **Teks penuh**
  untuk memaksa semua sel membungkus.
- **Tabel**: sticky header, urut per kolom, pencarian dengan highlight, sembunyikan kolom, paginasi 50 baris.
- **Tab Kolom**: jumlah terisi/kosong, nilai unik, min/maks/rata-rata/median/total, histogram, dan 5 nilai terpopuler.
- **Tab Grafik**: bar/line chart SVG dengan agregasi jumlah, rata-rata, count, min, maks.
- **Unduh** hasil filter sebagai CSV atau JSON, atau salin ke clipboard.
- **Responsif**: di layar ≤720px tabel otomatis berubah jadi kartu per baris.
- **Tema terang saja**, gaya cetak/ledger tanpa webfont (serif & mono bawaan sistem).

## Menjalankan secara lokal

Tidak ada build step, tidak ada dependency. Cukup buka `index.html`, atau:

```bash
python -m http.server 8000
```

## Deploy ke GitHub Pages

Workflow di `.github/workflows/deploy.yml` sudah menangani ini. Sekali saja di GitHub:
**Settings → Pages → Source: GitHub Actions**. Setiap push ke `main` akan otomatis ter-deploy.

## Struktur

```
index.html          markup + tata letak
assets/style.css    tema, tabel, tampilan kartu untuk HP
assets/app.js       parser CSV, inferensi tipe, render tabel/statistik/grafik
```
