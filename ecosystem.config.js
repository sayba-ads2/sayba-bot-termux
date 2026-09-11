// ==========================================
// KONFIGURASI PM2 - BOT SAYBA MULTI NOMOR
//
// File ini ikut diunggah ke GitHub (repo PRIVATE).
// Isinya nomor asli — pastikan repo tidak pernah diubah jadi Public.
//
// Urutan argumen: <folderAuth> <nomorOwner> <kodeBot> <namaBot> [nomorBotSendiri]
//
// Argumen ke-5 (nomorBotSendiri) OPSIONAL:
//   - Diisi  -> login pakai KODE PAIRING 8 digit (tidak perlu scan QR)
//   - Kosong -> login pakai QR code
//
// GANTI nomor owner di bawah sesuai nomor Anda (format 62xxx, tanpa + dan spasi).
// Tambah bot ke-3 dst cukup menyalin satu blok dan mengubah name, folder auth,
// dan kode botnya — kode bot TIDAK BOLEH sama.
//
// Jalankan : pm2 start ecosystem.config.js
// Lihat log: pm2 logs bot1        (QR code muncul di sini saat pertama kali)
// ==========================================

module.exports = {
  apps: [
    {
      name: 'bot1',
      script: 'index.js',
      args: 'auth_sayba 268697650352299 1 "Sayba Satu"',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '400M',
      time: true,
      out_file: './logs/bot1-out.log',
      error_file: './logs/bot1-err.log'
    },
    {
      name: 'bot2',
      script: 'index.js',
      args: 'auth_sayba2 628xxxxxxxxxx 2 "Sayba Dua" 6287721916495',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      max_memory_restart: '400M',
      time: true,
      out_file: './logs/bot2-out.log',
      error_file: './logs/bot2-err.log'
    }
  ]
};
