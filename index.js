// ==========================================
// PEREDAM LOG BAWAAN LIBSIGNAL
// Pesan "Bad MAC" / "Failed to decrypt" itu normal & sembuh sendiri
// (sesi lama ditutup, sesi baru dipakai). Hanya disembunyikan dari layar,
// dihitung, lalu bisa dicek kapan saja dengan perintah .status
// ==========================================
const noisyPatterns = [
    'Failed to decrypt',
    'Bad MAC',
    'Closing session',
    'Closing open session',
    'Session error',
    'SessionEntry',
    'No session record',
    'MessageCounterError',
    'Key used already or never filled'
];

let decryptErrorCount = 0;
let lastDecryptError = null;

const makeQuietLogger = (original) => (...args) => {
    const text = args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        return '';
    }).join(' ');

    if (noisyPatterns.some(p => text.includes(p))) {
        decryptErrorCount++;
        lastDecryptError = new Date().toLocaleString('id-ID');
        return; // Ditelan, tidak ditampilkan
    }
    original(...args);
};

const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
console.log = makeQuietLogger(_origLog);
console.error = makeQuietLogger(_origError);
console.warn = makeQuietLogger(_origWarn);

// --- LAPIS KEDUA: cegat langsung di level stdout/stderr ---
// Sebagian log libsignal tidak lewat console.log, jadi disaring di sini.
// Blok multi-baris (dump SessionEntry) ikut ditelan sampai kurung tutupnya.
let swallowingBlock = false;

const makeQuietWrite = (originalWrite, stream) => function (chunk, encoding, callback) {
    const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');

    if (swallowingBlock) {
        // Masih di tengah dump objek — telan sampai ketemu baris penutup "}"
        if (/^\}\s*$/m.test(text) || text.trim() === '}') swallowingBlock = false;
        if (typeof callback === 'function') callback();
        return true;
    }

    if (text && noisyPatterns.some(p => text.includes(p))) {
        decryptErrorCount++;
        lastDecryptError = new Date().toLocaleString('id-ID');
        // Kalau dump objek terpotong beberapa chunk, telan lanjutannya juga
        const opens = (text.match(/\{/g) || []).length;
        const closes = (text.match(/\}/g) || []).length;
        if (opens > closes) swallowingBlock = true;
        if (typeof callback === 'function') callback();
        return true;
    }

    return originalWrite.call(stream, chunk, encoding, callback);
};

process.stdout.write = makeQuietWrite(process.stdout.write, process.stdout);
process.stderr.write = makeQuietWrite(process.stderr.write, process.stderr);

// Jaring pengaman: error yang tidak tertangkap jangan sampai mematikan bot
process.on('uncaughtException', (err) => {
    const m = err?.message || String(err);
    if (noisyPatterns.some(p => m.includes(p))) { decryptErrorCount++; return; }
    _origError('❌ Uncaught Exception:', m);
});
process.on('unhandledRejection', (err) => {
    const m = err?.message || String(err);
    if (noisyPatterns.some(p => m.includes(p))) { decryptErrorCount++; return; }
    _origError('❌ Unhandled Rejection:', m);
});

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Paket 'qrcode' dipakai untuk membuat QR berupa gambar PNG (agar bisa dikirim
// lewat WhatsApp). Sifatnya opsional — kalau belum diinstal, bot tetap jalan
// dan QR hanya tampil di terminal. Install: npm install qrcode
let qrImage = null;
try { qrImage = require('qrcode'); } catch (e) { /* opsional */ }

// ==========================================================
//  PENGATURAN — SEMUA DIATUR DI SINI
//
//  Jalankan:  node index.js 1     (untuk bot 1)
//             node index.js 2     (untuk bot 2)
// ==========================================================

// Identitas Anda sebagai owner. Boleh lebih dari satu.
// Kalau bot tidak merespons, ketik .ceklid di chat bot tersebut,
// lalu tambahkan angka yang muncul ke daftar ini.
// Tiap owner ditulis berpasangan: LID dan nomor teleponnya.
// Nomor telepon dipakai sebagai alamat balasan, karena alamat @lid
// sering tidak bisa dibuka HP setelah bot login ulang.
// Cek LID/nomor Anda dengan mengetik .ceklid di chat bot.
const DAFTAR_OWNER = [
    { lid: '268697650352299', nomor: '6287803445749' },
    { lid: '20706725200037',  nomor: '6287792634063' }
];

// Semua identitas owner digabung jadi satu daftar untuk pengecekan
const OWNER_IDS = DAFTAR_OWNER
    .flatMap(o => [o.lid, o.nomor])
    .map(x => String(x || '').replace(/[^0-9]/g, ''))
    .filter(Boolean);

// Cari nomor telepon milik owner berdasarkan identitas apa pun miliknya
const nomorOwnerDari = (id) => {
    const bersih = String(id || '').replace(/[^0-9]/g, '');
    const ketemu = DAFTAR_OWNER.find(o => o.lid === bersih || o.nomor === bersih);
    return ketemu ? ketemu.nomor : null;
};

// Daftar bot. Tambah bot baru cukup menyalin satu blok.
const DAFTAR_BOT = {
    '1': {
        nama:   'Sayba Satu',
        auth:   'auth_sayba',
        nomor:  '628979602864',     // nomor WA bot ini (untuk kode pairing)
        grup:   ['BOT JAYA']        // grup tempat perintah boleh dipakai
    },
    '2': {
        nama:   'Sayba Dua',
        auth:   'auth_sayba2',
        nomor:  '6281332611714',    // 081332611714
        grup:   ['BOT JAYA']
    }
};

// Catatan tentang "grup":
//   - Kosongkan ([]) kalau bot itu tidak boleh diperintah dari grup mana pun.
//   - Nama harus PERSIS sama dengan nama grup di WhatsApp (huruf besar/kecil
//     tidak masalah). Nama grup yang terbaca ditampilkan di log Termux.
//   - Kalau kedua bot ada di grup yang sama DAN sama-sama mencantumkan grup
//     itu, keduanya akan menjawab. Hapus dari salah satu kalau tidak mau.
//   - Perintah di grup tetap hanya dilayani untuk owner.

// ==========================================================
//  Di bawah ini tidak perlu diubah
// ==========================================================
// Bot mana yang dijalankan, dicari berurutan dari beberapa sumber supaya
// tidak mudah salah — pm2 kadang menelan argumen setelah nama aplikasi.
//   1. Variabel lingkungan   : BOT=2 node index.js
//   2. Argumen               : node index.js 2
//   3. Nama aplikasi di pm2  : pm2 start index.js --name bot2
const bersihkan = (v) => String(v || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// Ubah apa pun ("2", "bot2", "--name") jadi kode bot yang benar-benar ada
const keDaftar = (v) => {
    const b = bersihkan(v);
    if (!b) return '';
    if (DAFTAR_BOT[b]) return b;                       // sudah pas: "2"
    const angka = bersihkan(b.match(/[0-9]+/)?.[0]);   // "bot2" -> "2"
    return DAFTAR_BOT[angka] ? angka : '';
};

const dariArgumen = process.argv.slice(2).map(keDaftar).find(Boolean) || '';
const dariNamaPm2 = keDaftar(process.env.name);

const BOT_CODE = keDaftar(process.env.BOT) || dariArgumen || dariNamaPm2 || '1';
const KONFIG   = DAFTAR_BOT[BOT_CODE];

if (!KONFIG) {
    _origLog('==========================================');
    _origLog(`❌ Bot "${BOT_CODE}" tidak ada di DAFTAR_BOT.`);
    _origLog(`   Pilihan tersedia : ${Object.keys(DAFTAR_BOT).join(', ')}`);
    _origLog(`   Argumen diterima : ${JSON.stringify(process.argv.slice(2))}`);
    _origLog(`   Nama pm2         : ${process.env.name || '-'}`);
    _origLog('');
    _origLog('   Jalankan salah satu cara ini:');
    _origLog('     node index.js 2');
    _origLog('     BOT=2 node index.js');
    _origLog('     pm2 start index.js --name bot2');
    _origLog('==========================================');

    // Berhenti dengan kode 0 supaya pm2 TIDAK menghidupkan ulang terus-menerus
    process.exit(0);
}

const AUTH_FOLDER = KONFIG.auth;
const BOT_NAME    = KONFIG.nama;
const GRUP_IZIN   = (KONFIG.grup || []).map(g => String(g).trim().toLowerCase());
const grupDiizinkan = (nama) => GRUP_IZIN.includes(String(nama || '').trim().toLowerCase());
const BOT_NUMBER  = (KONFIG.nomor || '').replace(/[^0-9]/g, '');
const BOT_TAG     = `[BOT-${BOT_CODE.toUpperCase()} ${BOT_NAME}]`;

const pureOwner = OWNER_IDS[0] || '';   // Dipakai untuk alamat kirim laporan
const isOwnerId = (id) => OWNER_IDS.includes(id);

// Folder titipan QR antar bot: bot yang sudah online akan mengirim QR
// milik bot lain ke WhatsApp Owner sebagai gambar.
const QR_SHARE_DIR = path.join(__dirname, 'qr_share');
try { fs.mkdirSync(QR_SHARE_DIR, { recursive: true }); } catch (e) {}

if (!pureOwner) {
    _origLog('❌ OWNER_IDS masih kosong! Isi LID/nomor Anda di bagian atas index.js.');
    process.exit(1);
}

// ==========================================================
// KUNCI FOLDER SESI
// Dua proses yang memakai folder auth yang sama akan saling merebut
// koneksi dan gagal terus. Ini mencegahnya sejak awal.
// ==========================================================
const LOCK_FILE = path.join(__dirname, `${AUTH_FOLDER}.lock`);
try {
    if (fs.existsSync(LOCK_FILE)) {
        const pidLama = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
        let masihHidup = false;
        try { process.kill(pidLama, 0); masihHidup = true; } catch (e) { masihHidup = false; }

        if (masihHidup && pidLama !== process.pid) {
            _origLog('==========================================');
            _origLog(`❌ FOLDER "${AUTH_FOLDER}" SEDANG DIPAKAI PROSES LAIN (PID ${pidLama}).`);
            _origLog(`   Bot "${BOT_CODE}" tidak dijalankan agar sesi tidak rusak.`);
            _origLog(`   Kemungkinan dua proses menjalankan bot yang sama.`);
            _origLog(`   Periksa dengan: pm2 list`);
            _origLog('==========================================');
            process.exit(0);   // kode 0 supaya pm2 tidak mengulang terus
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) { /* kunci gagal dibuat, lanjut saja */ }

const lepasKunci = () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} };
process.on('exit', lepasKunci);
process.on('SIGINT', () => { lepasKunci(); process.exit(0); });
process.on('SIGTERM', () => { lepasKunci(); process.exit(0); });

_origLog('==========================================');
_origLog(`🤖 ${BOT_TAG}`);
_origLog(`📁 Folder auth : ${AUTH_FOLDER}`);
_origLog(`📱 Nomor bot   : ${BOT_NUMBER || '(kosong, login pakai QR)'}`);
_origLog(`👤 Owner       : ${OWNER_IDS.join(', ')}`);
_origLog('==========================================');
let tempWhitelist = [];
let isBulkRunning = false;
let sentHistory = new Set(); // Nomor yang sudah pernah dikirimi pada whitelist aktif

// === PENGATURAN BATCH ===
const BATCH_SIZE = 5;             // Jumlah nomor per batch
const MIN_MSG_DELAY_SEC = 5;      // Jeda antar nomor DI DALAM batch (detik)
const MAX_MSG_DELAY_SEC = 20;
const MIN_BATCH_DELAY_MIN = 5;    // Jeda antar batch (menit)
const MAX_BATCH_DELAY_MIN = 6;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomBetweenMs = (minSec, maxSec) => {
    const sec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    return sec * 1000;
};

const randomMsgDelayMs = () => randomBetweenMs(MIN_MSG_DELAY_SEC, MAX_MSG_DELAY_SEC);
const randomBatchDelayMs = () => randomBetweenMs(MIN_BATCH_DELAY_MIN * 60, MAX_BATCH_DELAY_MIN * 60);

const formatDuration = (ms) => {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m} menit ${s} detik`;
};

let qrWatcher = null;     // Pemantau QR bot lain (dibuat sekali saja)

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const usePairingCode = Boolean(BOT_NUMBER) && !state.creds.registered;

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: !usePairingCode
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // PENCATAT HASIL KIRIM
    // Setiap pengiriman dicatat berhasil atau gagal beserta alasannya,
    // supaya ketahuan kalau WhatsApp menolak pesan bot ini.
    // ==========================================
    const _kirimAsli = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, isi, opsi) => {
        const jenis = Object.keys(isi || {})[0] || '?';
        try {
            const hasil = await _kirimAsli(jid, isi, opsi);
            _origLog(`   📤 [${BOT_CODE}] kirim ${jenis} ke ${jid} → OK (id: ${hasil?.key?.id || '-'})`);
            return hasil;
        } catch (err) {
            _origError(`   ❌ [${BOT_CODE}] GAGAL kirim ${jenis} ke ${jid} → ${err?.message || err}`);
            throw err;
        }
    };

    // === LOGIN PAKAI KODE PAIRING (tanpa QR) ===
    if (usePairingCode) {
        const mintaKode = async (sisaPercobaan = 5) => {
            try {
                const code = await sock.requestPairingCode(BOT_NUMBER);
                const rapi = code.match(/.{1,4}/g).join('-');
                _origLog('\n==========================================');
                _origLog(`🔗 KODE PAIRING ${BOT_TAG}`);
                _origLog(`📱 Nomor  : ${BOT_NUMBER}`);
                _origLog(`🔢 KODE   : ${rapi}`);
                _origLog('Buka WA > Perangkat Tertaut > Tautkan dengan nomor telepon');
                _origLog('==========================================\n');
            } catch (err) {
                const pesan = err?.message || String(err);
                if (sisaPercobaan > 0) {
                    _origLog(`⏳ Kode pairing belum bisa diminta (${pesan}). Mencoba lagi 8 detik lagi... [sisa ${sisaPercobaan}]`);
                    setTimeout(() => mintaKode(sisaPercobaan - 1), 8000);
                } else {
                    _origError(`❌ Gagal meminta kode pairing setelah beberapa kali: ${pesan}`);
                    _origError(`   Periksa nomor "${BOT_NUMBER}" dan koneksi internet, lalu restart bot ini.`);
                }
            }
        };
        setTimeout(() => mintaKode(), 5000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
            console.log('\n--- SISTEM MEMINTA LOGIN ---');
            qrcode.generate(qr, { small: true });
            console.log('SILAKAN SCAN QR CODE DI ATAS!\n');

            // Titipkan QR sebagai gambar agar bot lain yang sudah online
            // bisa mengirimkannya ke WhatsApp Owner
            if (qrImage) {
                try {
                    const file = path.join(QR_SHARE_DIR, `qr_${BOT_CODE}.png`);
                    await qrImage.toFile(file, qr, { width: 512, margin: 2 });
                    fs.writeFileSync(file + '.name', `${BOT_NAME}|${BOT_CODE}`);
                } catch (err) {
                    _origError('⚠️ Gagal menyimpan gambar QR:', err?.message || err);
                }
            }
        }

        if(connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) startBot();
        } else if(connection === 'open') {
            console.log(`✅ ${BOT_TAG} berhasil terhubung ke WhatsApp!`);

            // Bukti bot ini tertaut ke akun yang mana
            _origLog(`🪪 IDENTITAS BOT INI:`);
            _origLog(`   Nomor : ${sock.user?.id || '?'}`);
            _origLog(`   LID   : ${sock.user?.lid || '-'}`);
            _origLog(`   Nama  : ${sock.user?.name || '-'}`);
            if (OWNER_IDS.some(o => String(sock.user?.id || '').includes(o))) {
                _origLog(`   ⚠️ PERINGATAN: bot ini tertaut ke AKUN OWNER SENDIRI.`);
                _origLog(`      Pesan Anda akan terbaca "fromMe" dan selalu diabaikan.`);
            }

            // QR sendiri sudah tidak diperlukan
            try {
                const mine = path.join(QR_SHARE_DIR, `qr_${BOT_CODE}.png`);
                fs.unlinkSync(mine);
                fs.unlinkSync(mine + '.name');
            } catch (e) {}

            // Mulai memantau QR milik bot lain (sekali saja)
            if (!qrWatcher) {
                qrWatcher = setInterval(() => { relayQrToOwner(); }, 10000);
                _origLog('👀 Memantau QR bot lain untuk dikirim ke WhatsApp Owner.');
            }

        }
    });

    // Alamat owner: LID dan nomor telepon punya akhiran berbeda.
    // Nomor telepon Indonesia diawali 62 dan panjangnya <= 15 digit;
    // LID jauh lebih panjang dan bukan nomor yang bisa dihubungi biasa.
    const tebakJid = (id) => {
        if (!id) return null;
        const sepertiNomor = /^[1-9][0-9]{7,14}$/.test(id) && id.startsWith('62');
        return sepertiNomor ? `${id}@s.whatsapp.net` : `${id}@lid`;
    };

    // Pakai nomor telepon kalau ada; kalau tidak, pakai LID
    const ownerNomor = OWNER_IDS.find(id => id.startsWith('62'));
    let ownerJid = tebakJid(ownerNomor || pureOwner);

    _origLog(`📮 Alamat laporan owner: ${ownerJid}`);

    // Semua laporan progres bulk dikirim ke chat pribadi Owner
    const reportOwner = async (text) => {
        try {
            await sock.sendMessage(ownerJid, { text: `${BOT_TAG}
${text}` });
        } catch (err) {
            console.log('⚠️ Gagal mengirim laporan ke Owner:', err?.message || err);
        }
    };

    // ==========================================
    // PENGANTAR QR: bot yang sudah online mengirimkan QR milik bot LAIN
    // ke WhatsApp Owner, supaya tidak perlu melihat terminal.
    // QR WhatsApp hanya berlaku ±60 detik, jadi dikirim ulang saat berganti.
    // ==========================================
    const qrSentAt = {};      // kode bot -> waktu kirim terakhir
    const qrSentMtime = {};   // kode bot -> mtime file terakhir dikirim

    const relayQrToOwner = async () => {
        let files;
        try { files = fs.readdirSync(QR_SHARE_DIR); } catch (e) { return; }

        for (const f of files) {
            if (!f.endsWith('.png')) continue;

            const kode = f.replace('qr_', '').replace('.png', '');
            if (kode === BOT_CODE) continue; // QR sendiri, tidak perlu dikirim

            const full = path.join(QR_SHARE_DIR, f);
            let stat;
            try { stat = fs.statSync(full); } catch (e) { continue; }

            // QR basi (lebih dari 2 menit) dibuang saja
            if (Date.now() - stat.mtimeMs > 120000) {
                try { fs.unlinkSync(full); fs.unlinkSync(full + '.name'); } catch (e) {}
                continue;
            }

            if (qrSentMtime[kode] === stat.mtimeMs) continue;            // Sudah dikirim
            if (Date.now() - (qrSentAt[kode] || 0) < 40000) continue;    // Jangan terlalu sering

            let nama = `Bot ${kode}`;
            try { nama = fs.readFileSync(full + '.name', 'utf8').split('|')[0]; } catch (e) {}

            try {
                await sock.sendMessage(ownerJid, {
                    image: fs.readFileSync(full),
                    caption: `📲 *QR LOGIN UNTUK ${nama.toUpperCase()}*\n\n` +
                             `Scan dari HP lain:\nWA > Perangkat Tertaut > Tautkan Perangkat\n\n` +
                             `⏳ Berlaku ±60 detik. Kalau kedaluwarsa, QR baru dikirim otomatis.\n` +
                             `_Dikirim oleh ${BOT_TAG}_`
                });
                qrSentAt[kode] = Date.now();
                qrSentMtime[kode] = stat.mtimeMs;
                _origLog(`📤 QR milik bot ${kode} dikirim ke WhatsApp Owner.`);
            } catch (err) {
                _origError('⚠️ Gagal mengirim QR ke Owner:', err?.message || err);
            }
        }
    };

    // ==========================================
    // PEMANTAU STATUS PENGIRIMAN
    // Menunjukkan pesan yang kita kirim benar-benar SAMPAI atau tidak.
    //   SERVER  = baru diterima server WhatsApp
    //   SAMPAI  = sudah masuk ke HP penerima (centang dua)
    //   DIBACA  = sudah dibuka penerima
    // Kalau berhenti di SERVER terus, berarti WhatsApp menahan pesan
    // nomor ini — bukan masalah kode.
    // ==========================================
    const namaStatus = { 0: 'ERROR', 1: 'MENUNGGU', 2: 'SERVER', 3: 'SAMPAI', 4: 'DIBACA', 5: 'DIPUTAR' };

    sock.ev.on('messages.update', (daftar) => {
        for (const u of daftar) {
            const st = u.update?.status;
            if (st === undefined || st === null) continue;
            if (!u.key?.fromMe) continue;   // hanya pantau pesan kita sendiri
            _origLog(`   📬 [${BOT_CODE}] pesan ${u.key?.id} ke ${u.key?.remoteJid} → ${namaStatus[st] || st}`);
        }
    });

    // Nama grup disimpan sementara supaya tidak menanyakan server tiap pesan
    const cacheNamaGrup = new Map();

    const ambilNamaGrup = async (jidGrup) => {
        const tersimpan = cacheNamaGrup.get(jidGrup);
        if (tersimpan && Date.now() - tersimpan.waktu < 600000) return tersimpan.nama;

        try {
            const meta = await sock.groupMetadata(jidGrup);
            cacheNamaGrup.set(jidGrup, { nama: meta.subject, waktu: Date.now() });
            return meta.subject;
        } catch (err) {
            _origLog(`⚠️ Gagal membaca nama grup ${jidGrup}: ${err?.message || err}`);
            return '';
        }
    };

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];

        // Log diagnosa: bukti bahwa pesan benar-benar sampai ke bot ini
        _origLog(`📩 [${BOT_CODE}] pesan masuk | dari: ${msg?.key?.remoteJid || '?'} | fromMe: ${msg?.key?.fromMe} | jenis: ${msg?.message ? Object.keys(msg.message)[0] : 'kosong'}`);

        // Pesan yang gagal didekripsi datang dalam keadaan kosong.
        // WhatsApp akan mengirim ulang otomatis setelah sesi diperbarui.
        if (!msg.message && !msg.key.fromMe) {
            decryptErrorCount++;
            lastDecryptError = new Date().toLocaleString('id-ID');
            _origLog(`   ⚠️ Pesan tidak bisa dibuka (sesi belum cocok). Tunggu kiriman ulang, atau minta pengirim kirim pesan baru.`);
        }

        if(!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const participant = isGroup ? msg.key.participant : sender;
        const pureParticipant = participant.split(':')[0].split('@')[0];

        // Owner bisa terlihat sebagai nomor biasa ATAU sebagai LID, dan LID-nya
        // berbeda di tiap bot. Semua kemungkinan identitas pengirim dicocokkan.
        const idPengirim = [
            pureParticipant,
            msg.key.participantAlt, msg.key.participantPn,
            msg.key.senderLid, msg.key.senderPn,
            isGroup ? null : msg.key.remoteJid,
            isGroup ? null : msg.key.remoteJidAlt
        ].filter(x => typeof x === 'string' && x)
         .map(x => x.split(':')[0].split('@')[0]);

        const isOwner = idPengirim.some(isOwnerId);

        // Begitu owner benar-benar chat, pakai alamat chat itu untuk laporan.
        // Lebih andal daripada menebak dari LID/nomor di konfigurasi.
        if (isOwner && !isGroup && sender && sender !== ownerJid) {
            ownerJid = sender;
            _origLog(`📮 Alamat laporan owner diperbarui: ${ownerJid}`);
        }

        // Alamat untuk membalas. Chat beralamat @lid sering tidak bisa dibuka
        // HP owner setelah bot login ulang, jadi balasan diarahkan ke nomor
        // telepon owner bila diketahui.
        let alamatBalas = sender;
        let pakaiQuote = msg;

        if (isOwner && sender.endsWith('@lid')) {
            // Cari nomor telepon milik owner INI, bukan owner pertama
            const nomorDia = idPengirim.map(nomorOwnerDari).find(Boolean);
            if (nomorDia) {
                alamatBalas = `${nomorDia}@s.whatsapp.net`;
                pakaiQuote = null;   // pesan aslinya ada di chat lain
            }
        }

        let text = "";
        let extendedMessage = null;

        if (msg.message.conversation) {
            text = msg.message.conversation;
        } else if (msg.message.extendedTextMessage) {
            text = msg.message.extendedTextMessage.text;
            extendedMessage = msg.message.extendedTextMessage;
        } else if (msg.message.ephemeralMessage) {
            const eph = msg.message.ephemeralMessage.message;
            text = eph.conversation || eph.extendedTextMessage?.text || "";
            extendedMessage = eph.extendedTextMessage;
        }

        if (!text) return;

        const args = text.trim().split(/ +/);
        const rawCommand = args[0].toLowerCase();

        // Log diagnosa: teks terbaca & apakah pengirim dikenali sebagai owner
        _origLog(`   ↳ teks: "${text.slice(0, 40)}" | id terbaca: [${idPengirim.join(', ')}] | owner? ${isOwner ? 'YA' : 'TIDAK'}`);

        // ==========================================
        // ATURAN PERINTAH
        // Tiap bot berdiri sendiri: perintah polos (.status, .bulk, dst)
        // dilayani di chat pribadi bot yang bersangkutan.
        // Di grup perintah diabaikan, supaya kalau beberapa bot ada di grup
        // yang sama tidak ada dua bot menjawab pertanyaan yang sama.
        // ==========================================
        // ==========================================
        // KODE BOT DI BELAKANG PERINTAH
        // .status1 -> hanya dikerjakan bot 1
        // .status2 -> hanya dikerjakan bot 2
        // .status  -> dikerjakan bot mana pun yang menerimanya
        // ==========================================
        const cocokKode = rawCommand.match(/^(\.?[a-z]+?)([0-9]+)$/);
        let command = rawCommand;
        let kodeDiminta = null;

        if (cocokKode && DAFTAR_BOT[cocokKode[2]]) {
            command = cocokKode[1];
            kodeDiminta = cocokKode[2];
        }

        const isKnownCommand = command.startsWith('.') || ['info', 'link', 'sayba'].includes(command);

        if (isKnownCommand && kodeDiminta && kodeDiminta !== BOT_CODE) {
            _origLog(`   ⏭️ "${rawCommand}" untuk bot ${kodeDiminta}, bukan bot ${BOT_CODE}. Dilewati.`);
            return;
        }

        // Perintah di grup hanya dilayani kalau nama grupnya terdaftar
        // pada "grup" milik bot ini di DAFTAR_BOT.
        if (isKnownCommand && isGroup) {
            const namaGrupIni = await ambilNamaGrup(sender);
            _origLog(`   👥 Perintah dari grup: "${namaGrupIni}" | diizinkan? ${grupDiizinkan(namaGrupIni) ? 'YA' : 'TIDAK'}`);
            if (!grupDiizinkan(namaGrupIni)) return;
        }

        // ==========================================
        // .ceklid — SATU-SATUNYA PERINTAH YANG BOLEH DIPAKAI SIAPA SAJA
        // Membalas pengirim dengan LID / nomor miliknya sendiri.
        // Diletakkan SEBELUM gerbang owner, jadi orang lain pun dibalas.
        // ==========================================
        if (command === '.ceklid') {
            const k = msg.key;

            // --- MODE CARI: .ceklid <nomor> (khusus owner) ---
            const targetArg = args.slice(1).join(" ").trim();
            if (targetArg) {
                if (!isOwner) return; // Orang lain hanya boleh cek dirinya sendiri

                // Boleh beberapa nomor sekaligus, dipisah enter atau koma.
                // Spasi DI DALAM satu nomor (+62 857 1234 5678) tetap dianggap
                // satu nomor; spasi baru jadi pemisah kalau digitnya kepanjangan.
                const daftar = [];
                for (const potongan of targetArg.split(/[\n,]+/)) {
                    const digit = potongan.replace(/[^0-9]/g, '');
                    if (!digit) continue;

                    if (digit.length <= 15) {
                        if (digit.length >= 8) daftar.push(digit);
                    } else {
                        // Kepanjangan -> berarti beberapa nomor dipisah spasi
                        for (const sub of potongan.split(/ +/)) {
                            const d = sub.replace(/[^0-9]/g, '');
                            if (d.length >= 8 && d.length <= 15) daftar.push(d);
                        }
                    }
                }

                if (daftar.length === 0) {
                    return await sock.sendMessage(alamatBalas, { text: '❌ Format: *.ceklid 628123456789*' }, (pakaiQuote ? { quoted: pakaiQuote } : {}));
                }

                let hasil = `🔍 *HASIL CEK ${daftar.length} NOMOR*\n`;
                for (let n of daftar) {
                    if (n.startsWith('0')) n = '62' + n.substring(1);
                    try {
                        const cek = await sock.onWhatsApp(n + '@s.whatsapp.net');
                        const data = Array.isArray(cek) ? cek[0] : null;

                        if (!data || !data.exists) {
                            hasil += `\n❌ ${n}\n   _tidak terdaftar di WhatsApp_\n`;
                            continue;
                        }

                        const lidKetemu = data.lid || data.jid?.endsWith('@lid') ? (data.lid || data.jid) : null;
                        hasil += `\n✅ ${n}\n`;
                        hasil += `   JID: ${data.jid || '-'}\n`;
                        hasil += `   LID: ${lidKetemu || '_tidak diberikan WhatsApp_'}\n`;
                    } catch (err) {
                        hasil += `\n⚠️ ${n}\n   _gagal dicek: ${err?.message || 'error'}_\n`;
                    }
                    await sleep(800); // Jangan terlalu cepat, hindari limit
                }

                return await sock.sendMessage(sender, { text: hasil }, { quoted: msg });
            }

            // --- MODE DIRI SENDIRI: .ceklid tanpa argumen (siapa saja) ---

            // Baileys menaruh identitas pengirim di beberapa tempat berbeda,
            // tergantung versi & jenis chat. Semua kemungkinan dikumpulkan.
            const kandidat = [
                k.participant,
                k.participantAlt,
                k.participantPn,
                k.senderLid,
                k.senderPn,
                isGroup ? null : k.remoteJid,
                isGroup ? null : k.remoteJidAlt
            ].filter(Boolean);

            let lid = null;
            let nomor = null;

            for (const j of kandidat) {
                if (typeof j !== 'string') continue;
                if (j.endsWith('@lid') && !lid) lid = j;
                if (j.endsWith('@s.whatsapp.net') && !nomor) nomor = j.split('@')[0];
            }

            let ck = `🆔 *CEK LID*\n\n`;
            ck += `👤 Nama: ${msg.pushName || '-'}\n`;
            ck += `📱 Nomor: ${nomor ? nomor : '_tidak terlihat_'}\n`;
            ck += `🔑 LID: ${lid ? lid : '_tidak terlihat_'}\n`;
            ck += `💬 Jenis chat: ${isGroup ? 'Grup' : 'Pribadi'}\n`;

            if (!lid && !nomor) {
                ck += `\n⚠️ Identitas tidak terbaca. Coba kirim ulang dari chat pribadi.`;
            } else if (!lid) {
                ck += `\n_LID tidak muncul karena WhatsApp hanya memberikannya di kondisi tertentu (umumnya di grup)._`;
            }

            await sock.sendMessage(alamatBalas, { text: ck }, (pakaiQuote ? { quoted: pakaiQuote } : {}));

            // Owner tetap diberi tahu siapa yang barusan mengecek
            if (!isOwner) {
                await reportOwner(`🔎 *ADA YANG PAKAI .ceklid*\n👤 ${msg.pushName || '-'}\n📱 ${nomor || '-'}\n🔑 ${lid || '-'}`);
            }
            return;
        }

        // ==========================================
        // GERBANG OWNER — BOT HANYA MEMBALAS NOMOR OWNER
        // Selain owner: pesannya cuma diteruskan diam-diam ke Owner,
        // bot TIDAK mengirim balasan apa pun ke pengirim.
        // ==========================================
        if (!isOwner) {
            if (!isGroup) {
                // Chat pribadi dari customer -> teruskan ke Owner (tanpa balas ke pengirim)
                await sock.sendMessage(ownerJid, { text: `${BOT_TAG}\n🔔 *PESAN DARI CUSTOMER MASUK KE BOT*\nPengirim: https://wa.me/${pureParticipant}` });
                await sock.sendMessage(ownerJid, { forward: msg });
            }
            return; // STOP TOTAL. Orang lain tidak pernah dapat balasan.
        }

        // ==========================================
        // MULAI SINI: HANYA OWNER
        // ==========================================

        // Semua perintah owner dikumpulkan di sini supaya bisa dipanggil
        // dari dua jalur: chat langsung, dan titipan dari bot lain (jembatan).
        await runOwnerCommand({
            command, args,
            sender: alamatBalas,
            msg: pakaiQuote,
            extendedMessage
        });
    });

    const runOwnerCommand = async ({ command, args, sender, msg, extendedMessage }) => {
        _origLog(`   ⚙️ [${BOT_CODE}] menjalankan "${command}" | whitelist: ${tempWhitelist.length} | bulk jalan: ${isBulkRunning ? 'ya' : 'tidak'} | balas ke: ${sender}`);

            // Info website (sekarang hanya dibalas ke owner)
            if (['info', 'link', 'sayba'].includes(command)) {
                await sock.sendMessage(sender, { text: 'Kunjungi website resmi kami di: https://sayba.id' }, (msg ? { quoted: msg } : {}));
                return;
            }

            // ==========================================
            // FITUR ADMIN (HANYA OWNER YANG BISA)
            // ==========================================

            if (command === '.getmembers') {
                const groupName = args.slice(1).join(" ");
                if (!groupName) return await sock.sendMessage(sender, { text: '❌ Ketik nama grupnya.' }, (msg ? { quoted: msg } : {}));

                const groups = await sock.groupFetchAllParticipating();
                let targetGroup = null;

                for (let id in groups) {
                    if (groups[id].subject === groupName) {
                        targetGroup = groups[id];
                        break;
                    }
                }

                if (!targetGroup) return await sock.sendMessage(sender, { text: `❌ Grup tidak ditemukan.` }, (msg ? { quoted: msg } : {}));

                const members = targetGroup.participants;
                let countRealNumber = 0;
                let countLID = 0;
                let countAdminSkipped = 0;
                let countSelfSkipped = 0;
                let memberList = "";

                // Menyedot Nomor Asli + Kode Rahasia (LID), TANPA admin grup & nomor sendiri
                members.forEach(mem => {
                    const isAdmin = (mem.admin === 'admin' || mem.admin === 'superadmin');
                    const pureId = mem.id.split(':')[0].split('@')[0];

                    if (isAdmin) { countAdminSkipped++; return; }              // Kecualikan admin & owner grup
                    if (pureId === pureOwner) { countSelfSkipped++; return; }  // Kecualikan nomor bot sendiri

                    if (mem.id.endsWith('@s.whatsapp.net')) {
                        memberList += `${mem.id.split('@')[0]}\n`;
                        countRealNumber++;
                    } else if (mem.id.endsWith('@lid')) {
                        memberList += `${mem.id}\n`; // MEMUNCULKAN LID
                        countLID++;
                    }
                });

                let replyText = `*Daftar Nomor Anggota Grup: ${groupName}*\n`;
                replyText += `Berhasil disedot: ${countRealNumber} nomor asli & ${countLID} ID Rahasia (LID)\n`;
                replyText += `Dikecualikan: ${countAdminSkipped} admin/owner grup`;
                if (countSelfSkipped > 0) replyText += ` + ${countSelfSkipped} nomor Anda sendiri`;
                replyText += `\n\n${memberList}`;

                await sock.sendMessage(sender, { text: replyText }, (msg ? { quoted: msg } : {}));
            }

            if (command === '.setwhitelist') {
                const numbersText = args.slice(1).join(" ");
                // Memisahkan berdasarkan enter, koma, atau spasi
                const rawNumbers = numbersText.split(/[\n, ]+/).map(n => n.trim()).filter(n => n.length > 5);

                if (rawNumbers.length === 0) return await sock.sendMessage(sender, { text: '❌ Format salah.' }, (msg ? { quoted: msg } : {}));

                // Whitelist baru = sesi kirim baru, riwayat anti-duplikat direset
                sentHistory = new Set();

                const uniqueTargets = new Set();
                let duplicateInput = 0;

                for (let num of rawNumbers) {
                    let jid;
                    if (num.endsWith('@lid')) {
                        jid = num; // Jika LID, langsung simpan
                    } else {
                        let formattedNum = num.replace(/[^0-9]/g, '');
                        if (formattedNum.startsWith('0')) formattedNum = '62' + formattedNum.substring(1);
                        jid = formattedNum + '@s.whatsapp.net';
                    }
                    if (uniqueTargets.has(jid)) { duplicateInput++; continue; } // Buang nomor kembar
                    uniqueTargets.add(jid);
                }

                tempWhitelist = [...uniqueTargets];

                const totalBatch = Math.ceil(tempWhitelist.length / BATCH_SIZE);
                let wlText = `✅ Berhasil menyimpan *${tempWhitelist.length} target* (termasuk nomor & LID) ke memori.\n`;
                if (duplicateInput > 0) wlText += `🧹 ${duplicateInput} nomor kembar dibuang otomatis.\n`;
                wlText += `📦 Akan dikirim dalam *${totalBatch} batch* (@${BATCH_SIZE} nomor).\n`;
                wlText += `🔄 Riwayat anti-duplikat direset untuk sesi ini.\n\n`;
                wlText += `Silakan Reply pesan promosi Anda dengan perintah: *.bulk*`;

                await sock.sendMessage(sender, { text: wlText }, (msg ? { quoted: msg } : {}));
            }

            if (command === '.bulk') {
                if (isBulkRunning) return await sock.sendMessage(sender, { text: '⚠️ Masih ada proses bulk yang berjalan. Tunggu selesai, atau ketik *.stopbulk*.' }, (msg ? { quoted: msg } : {}));
                if (tempWhitelist.length === 0) return await sock.sendMessage(sender, { text: '❌ Memori kosong!' }, (msg ? { quoted: msg } : {}));

                // Isi yang dikirim diambil dari pesan yang Anda reply
                const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.stanzaId;
                if (!isReply) return await sock.sendMessage(sender, { text: '❌ Anda harus me-reply pesan!' }, (msg ? { quoted: msg } : {}));

                const quotedContext = extendedMessage.contextInfo;
                const isiKiriman = {
                    forward: {
                        key: {
                            remoteJid: sender,
                            id: quotedContext.stanzaId,
                            participant: quotedContext.participant
                        },
                        message: quotedContext.quotedMessage
                    }
                };

                // Saring nomor yang SUDAH pernah dikirimi pada whitelist ini (anti duplicate send)
                const targets = [];
                let skippedDuplicate = 0;
                for (let jid of tempWhitelist) {
                    if (sentHistory.has(jid)) { skippedDuplicate++; continue; }
                    targets.push(jid);
                }

                // Whitelist langsung dikosongkan: mau kirim lagi berarti harus .setwhitelist ulang
                tempWhitelist = [];

                if (targets.length === 0) {
                    return await sock.sendMessage(sender, { text: `❌ Semua nomor di memori sudah pernah dikirimi pesan pada sesi ini.\n\nBuat whitelist baru dengan *.setwhitelist* jika ingin mengirim ulang.` }, (msg ? { quoted: msg } : {}));
                }

                isBulkRunning = true;

                const totalBatch = Math.ceil(targets.length / BATCH_SIZE);
                const avgMsgSec = (MIN_MSG_DELAY_SEC + MAX_MSG_DELAY_SEC) / 2;
                const avgBatchMin = (MIN_BATCH_DELAY_MIN + MAX_BATCH_DELAY_MIN) / 2;
                const estimasi = Math.round(
                    ((targets.length - totalBatch) * avgMsgSec) / 60 + (totalBatch - 1) * avgBatchMin
                );

                let startText = `⏳ Memulai Forward pesan ke ${targets.length} target.\n`;
                if (skippedDuplicate > 0) startText += `🚫 ${skippedDuplicate} nomor dilewati (sudah pernah dikirimi).\n`;
                startText += `📦 Dibagi ${totalBatch} batch @${BATCH_SIZE} nomor.\n`;
                startText += `⏱️ Jeda antar nomor: ${MIN_MSG_DELAY_SEC}-${MAX_MSG_DELAY_SEC} detik.\n`;
                startText += `😴 Jeda antar batch: ${MIN_BATCH_DELAY_MIN}-${MAX_BATCH_DELAY_MIN} menit.\n`;
                startText += `Estimasi selesai: ± ${estimasi} menit.\n\nKetik *.stopbulk* untuk menghentikan.`;
                await sock.sendMessage(sender, { text: startText }, (msg ? { quoted: msg } : {}));

                let successCount = 0;
                let failCount = 0;
                let stopped = false;

                for (let b = 0; b < totalBatch; b++) {
                    if (!isBulkRunning) { stopped = true; break; }

                    const batch = targets.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
                    console.log(`\n📦 === BATCH ${b + 1}/${totalBatch} (${batch.length} nomor) ===`);

                    // LAPOR KE OWNER: batch akan dijalankan
                    const batchStart = new Date().toLocaleTimeString('id-ID');
                    let daftarTarget = batch.map((jid, idx) => `${idx + 1}. ${jid.split('@')[0]}`).join('\n');
                    await reportOwner(
                        `▶️ *BATCH ${b + 1}/${totalBatch} AKAN DIJALANKAN*\n` +
                        `🕐 Mulai: ${batchStart}\n` +
                        `👥 Jumlah target: ${batch.length} nomor\n` +
                        `⏱️ Jeda antar nomor: ${MIN_MSG_DELAY_SEC}-${MAX_MSG_DELAY_SEC} detik\n\n` +
                        `*Daftar target:*\n${daftarTarget}`
                    );

                    let batchSuccess = 0;
                    let batchFail = 0;

                    for (let i = 0; i < batch.length; i++) {
                        if (!isBulkRunning) { stopped = true; break; }

                        const targetJid = batch[i];
                        try {
                            await sock.sendMessage(targetJid, isiKiriman);
                            sentHistory.add(targetJid); // Tandai supaya tidak dikirimi lagi
                            successCount++;
                            batchSuccess++;
                            console.log(`   [B${b + 1}] ✅ Terkirim ke ${targetJid}`);
                        } catch (err) {
                            failCount++;
                            batchFail++;
                            console.log(`   [B${b + 1}] ❌ Gagal kirim ke ${targetJid}`);
                        }

                        // Jeda acak antar nomor di dalam batch (nomor terakhir batch tidak perlu)
                        if (i < batch.length - 1 && isBulkRunning) {
                            const delay = randomMsgDelayMs();
                            console.log(`   ⏱️  Jeda ${Math.round(delay / 1000)} detik...`);
                            await sleep(delay);
                        }
                    }

                    const isLastBatch = (b === totalBatch - 1);
                    const willStop = stopped || !isBulkRunning;
                    const batchDelay = (!willStop && !isLastBatch) ? randomBatchDelayMs() : 0;

                    // LAPOR KE OWNER: batch selesai dijalankan
                    let doneText = `${willStop ? '🛑' : '✅'} *BATCH ${b + 1}/${totalBatch} SELESAI*\n`;
                    doneText += `🕐 Selesai: ${new Date().toLocaleTimeString('id-ID')}\n`;
                    doneText += `✅ Berhasil: ${batchSuccess} | ❌ Gagal: ${batchFail}\n`;
                    doneText += `📊 Total keseluruhan: ${successCount}/${targets.length} terkirim\n`;
                    if (willStop) {
                        doneText += `\n🛑 Proses dihentikan oleh perintah *.stopbulk*.`;
                    } else if (isLastBatch) {
                        doneText += `\n🎉 Ini batch terakhir.`;
                    } else {
                        doneText += `\n😴 Istirahat ${formatDuration(batchDelay)} sebelum *Batch ${b + 2}/${totalBatch}*.`;
                    }
                    await reportOwner(doneText);

                    if (willStop) { stopped = true; break; }

                    // Jeda acak antar batch (batch terakhir tidak perlu)
                    if (!isLastBatch) {
                        console.log(`😴 Batch ${b + 1} selesai. Istirahat ${formatDuration(batchDelay)}...`);
                        await sleep(batchDelay);
                    }
                }

                if (stopped) {
                    await reportOwner(`🛑 *BULK DIHENTIKAN*\nBerhasil: ${successCount} | Gagal: ${failCount} | Sisa: ${targets.length - successCount - failCount} target.\n\nBuat whitelist baru (*.setwhitelist*) untuk melanjutkan — nomor yang sudah terkirim otomatis dilewati.`);
                } else {
                    await reportOwner(`🎉 *SEMUA BATCH SELESAI*\n${totalBatch} batch tuntas.\n✅ Berhasil: ${successCount} target\n❌ Gagal: ${failCount} target\n🕐 Selesai: ${new Date().toLocaleTimeString('id-ID')}\n\nMemori sudah dikosongkan. Untuk kirim lagi, buat whitelist baru dengan *.setwhitelist*.`);
                }
                isBulkRunning = false;
            }

            if (command === '.stopbulk') {
                if (!isBulkRunning) return await sock.sendMessage(sender, { text: 'ℹ️ Tidak ada proses bulk yang berjalan.' }, (msg ? { quoted: msg } : {}));
                isBulkRunning = false;
                await sock.sendMessage(sender, { text: '🛑 Perintah berhenti diterima. Bulk akan berhenti setelah jeda yang sedang berjalan selesai.' }, (msg ? { quoted: msg } : {}));
            }

            if (command === '.status') {
                const upSec = Math.floor(process.uptime());
                const jam = Math.floor(upSec / 3600);
                const menit = Math.floor((upSec % 3600) / 60);

                let statusText = `📊 *STATUS ${BOT_NAME.toUpperCase()}*\n`;
                statusText += `🔑 Kode bot: *${BOT_CODE}* | 📁 ${AUTH_FOLDER}\n\n`;
                statusText += `🟢 Aktif: ${jam} jam ${menit} menit\n`;
                statusText += `📋 Whitelist di memori: ${tempWhitelist.length} nomor\n`;
                statusText += `📨 Sudah dikirimi (sesi ini): ${sentHistory.size} nomor\n`;
                statusText += `⚙️ Bulk berjalan: ${isBulkRunning ? 'YA' : 'tidak'}\n`;
                statusText += `🔇 Log enkripsi diredam: ${decryptErrorCount}x`;
                if (lastDecryptError) statusText += `\n🕐 Terakhir: ${lastDecryptError}`;
                statusText += `\n\n_Log enkripsi yang diredam itu normal dan sembuh sendiri._`;

                await sock.sendMessage(sender, { text: statusText }, (msg ? { quoted: msg } : {}));
            }
    };
}

startBot();
