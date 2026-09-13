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

// Simpan fungsi tulis ASLI sebelum disaring. Dipakai untuk pesan penting
// yang TIDAK BOLEH ikut tersaring — misalnya error saat mengirim pesan,
// yang teksnya kebetulan mengandung kata seperti "Session error" dan
// tanpa ini akan hilang tanpa jejak.
const _tulisAsli = process.stdout.write.bind(process.stdout);
const logPenting = (teks) => _tulisAsli(teks + '\n');

process.stdout.write = makeQuietWrite(process.stdout.write, process.stdout);
process.stderr.write = makeQuietWrite(process.stderr.write, process.stderr);

// Jaring pengaman: error yang tidak tertangkap jangan sampai mematikan bot.
// Yang diredam hanya error dekripsi murni — sisanya SELALU ditampilkan lewat
// logPenting(), supaya tidak ada kegagalan yang hilang tanpa jejak.
const errorDekripsiSaja = ['Failed to decrypt', 'Bad MAC', 'MessageCounterError'];

const tanganiError = (label) => (err) => {
    const m = err?.message || String(err);
    if (errorDekripsiSaja.some(p => m.includes(p))) {
        decryptErrorCount++;
        lastDecryptError = new Date().toLocaleString('id-ID');
        return;
    }
    logPenting(`❌ ${label}: ${m}`);
    if (err?.stack) logPenting(`   ${String(err.stack).split('\n')[1] || ''}`);
};

process.on('uncaughtException', tanganiError('Uncaught Exception'));
process.on('unhandledRejection', tanganiError('Unhandled Rejection'));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

// ==========================================================
//  PENGATURAN — SEMUA DIATUR DI SINI
//  Jalankan: node index.js
// ==========================================================

// Identitas owner — hanya nomor/ID ini yang bisa memakai perintah admin.
// Kalau bot tidak merespons perintah Anda, lihat log Termux: bagian
// "Pengirim:" pada pesan yang masuk menunjukkan ID yang terbaca bot.
const pureOwner = "268697650352299";

// === CARA LOGIN ===
// 'tanya'   -> Bot BERTANYA di layar saat dijalankan (tidak perlu edit file).
//              Nomor untuk pairing juga diketik langsung di terminal.
// 'qr'      -> Langsung QR code, tanpa bertanya
// 'pairing' -> Langsung kode pairing, BOT_NUMBER di bawah wajib diisi
const LOGIN_MODE = 'tanya';

// Hanya dipakai kalau LOGIN_MODE = 'pairing'.
// Kalau LOGIN_MODE = 'tanya', biarkan kosong — nanti diketik di terminal.
// Format bebas: '081234567890', '6281234567890', atau '+62 812-3456-7890'
const BOT_NUMBER = '';

// === GRUP YANG BOLEH MEMERINTAH BOT ===
// Bot hanya menanggapi perintah dari grup yang namanya ada di daftar ini.
// Grup lain diabaikan sepenuhnya, walau bot ikut jadi anggotanya.
//
// - Nama harus sama dengan nama grup di WhatsApp. Huruf besar/kecil bebas,
//   spasi di ujung diabaikan, tapi spasi ganda di tengah dianggap berbeda.
// - Kosongkan ([]) kalau bot tidak boleh diperintah dari grup mana pun.
// - Chat pribadi dengan owner tidak terpengaruh daftar ini.
const GRUP_IZIN = ['BOT JAYA'];

// === PENGATURAN BATCH ===
const BATCH_SIZE = 5;             // Jumlah nomor per batch
const MIN_MSG_DELAY_SEC = 5;      // Jeda antar nomor DI DALAM batch (detik)
const MAX_MSG_DELAY_SEC = 20;
const MIN_BATCH_DELAY_MIN = 5;    // Jeda antar batch (menit)
const MAX_BATCH_DELAY_MIN = 6;

// ==========================================================
//  Di bawah ini tidak perlu diubah
// ==========================================================

// Periksa pengaturan sebelum bot jalan, supaya salah isi ketahuan
// langsung — bukan setelah menunggu lama tanpa ada yang terjadi.
// Rapikan nomor bot: buang spasi/strip/tanda +, dan ubah awalan 0 jadi 62
// supaya '0812-3456-7890' pun diterima, bukan cuma format 62xxx.
let NOMOR_BOT = String(BOT_NUMBER || '').replace(/[^0-9]/g, '');
if (NOMOR_BOT.startsWith('0')) NOMOR_BOT = '62' + NOMOR_BOT.substring(1);

if (!['tanya', 'qr', 'pairing'].includes(LOGIN_MODE)) {
    _origLog(`❌ LOGIN_MODE hanya boleh 'tanya', 'qr', atau 'pairing'. Sekarang: '${LOGIN_MODE}'`);
    process.exit(1);
}

if (LOGIN_MODE === 'pairing' && !NOMOR_BOT) {
    _origLog('❌ LOGIN_MODE = pairing, tapi BOT_NUMBER masih kosong.');
    _origLog("   Isi BOT_NUMBER, atau pakai LOGIN_MODE = 'tanya' supaya");
    _origLog('   nomornya bisa diketik langsung di terminal saat bot jalan.');
    process.exit(1);
}

if (!pureOwner) {
    _origLog('❌ pureOwner masih kosong. Isi ID owner di bagian atas file.');
    process.exit(1);
}

// ==========================================================
// BUKU CATATAN LID ↔ NOMOR HP
//
// LID sengaja dirancang WhatsApp supaya TIDAK bisa dihitung balik
// menjadi nomor HP — itu fitur privasi, bukan keterbatasan kode.
// Satu-satunya cara mengetahui pasangannya adalah menunggu WhatsApp
// sendiri menyebutkan keduanya sekaligus, yaitu saat:
//   - orangnya mengirim pesan (kolom senderPn + senderLid)
//   - data grup menyertakan keduanya
//   - kita mencari lewat onWhatsApp(nomor) -> mengembalikan LID-nya
//
// Setiap kali itu terjadi, pasangannya dicatat di sini dan disimpan
// ke file, supaya tidak hilang saat bot dijalankan ulang.
// ==========================================================
const fsCatatan = require('fs');
const FILE_PETA = require('path').join(__dirname, 'peta_lid.json');
const petaLid = new Map();   // LID (angka saja) -> nomor HP

const muatPeta = () => {
    try {
        const isi = JSON.parse(fsCatatan.readFileSync(FILE_PETA, 'utf8'));
        for (const [lid, nomor] of Object.entries(isi)) petaLid.set(lid, nomor);
    } catch (e) { /* belum ada file, wajar */ }
};

const simpanPeta = () => {
    try {
        fsCatatan.writeFileSync(FILE_PETA, JSON.stringify(Object.fromEntries(petaLid), null, 2));
    } catch (e) { /* gagal simpan, tidak fatal */ }
};

const bersihkanId = (v) => String(v || '').split(':')[0].split('@')[0].replace(/[^0-9]/g, '');

// Cocokkan nama grup dengan daftar GRUP_IZIN — huruf besar/kecil diabaikan
const GRUP_IZIN_RAPI = GRUP_IZIN.map(g => String(g).trim().toLowerCase());
const grupDiizinkan = (nama) => GRUP_IZIN_RAPI.includes(String(nama || '').trim().toLowerCase());

// Catat pasangan kalau keduanya diketahui. Mengembalikan true kalau baru.
const catatPasangan = (lid, nomor) => {
    const l = bersihkanId(lid);
    const n = bersihkanId(nomor);
    if (!l || !n || l === n) return false;
    if (petaLid.get(l) === n) return false;
    petaLid.set(l, n);
    simpanPeta();
    return true;
};

const nomorDariLid = (lid) => petaLid.get(bersihkanId(lid)) || null;

muatPeta();

// ==========================================================
// KUNCI SESI — CEGAH DUA PROSES BERJALAN BERSAMAAN
// Kalau bot dijalankan dua kali (misalnya lewat pm2 DAN lewat
// "node index.js" manual), keduanya memakai sesi WhatsApp yang sama
// dan saling menendang tanpa henti — koneksi putus-sambung terus
// dengan kode 440 (connectionReplaced), dan pesan tidak pernah
// sempat terkirim. Penguncian ini menghentikannya sejak awal.
// ==========================================================
const fs = require('fs');
const path = require('path');
const LOCK_FILE = path.join(__dirname, 'bot.lock');

try {
    if (fs.existsSync(LOCK_FILE)) {
        const pidLama = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10);
        let masihHidup = false;
        try { process.kill(pidLama, 0); masihHidup = true; } catch (e) { masihHidup = false; }

        if (masihHidup && pidLama !== process.pid) {
            _origLog('==========================================');
            _origLog(`❌ BOT SUDAH BERJALAN (PID ${pidLama}).`);
            _origLog('   Bot kedua tidak dijalankan, supaya sesi WhatsApp tidak');
            _origLog('   saling ditendang (error 440 connectionReplaced).');
            _origLog('');
            _origLog('   Hentikan yang lama dulu:');
            _origLog('     pm2 delete all');
            _origLog('     pkill -f "node index.js"');
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

// Jangan minta kode pairing baru berkali-kali dalam hitungan detik.
// Kalau koneksi putus-sambung sebelum kode sempat dipakai, permintaan
// yang bertubi-tubi bisa membuat WhatsApp menolak semua kodenya.
let waktuKodeTerakhir = 0;
const JEDA_KODE_MS = 45000;

// ==========================================================
// TANYA JAWAB DI TERMINAL
// Dipakai saat LOGIN_MODE = 'tanya', supaya cara login dan nomor
// bisa diketik langsung tanpa perlu mengedit file ini.
// Jawabannya diingat selama proses hidup — jadi kalau koneksi
// sempat putus-sambung, Anda tidak ditanyai berulang kali.
// ==========================================================
const readline = require('readline');

let modeDipilih = null;
let nomorDipilih = null;

const tanya = (pertanyaan) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(pertanyaan, (jawab) => {
        rl.close();
        resolve(String(jawab || '').trim());
    });
});

const rapikanNomor = (n) => {
    let x = String(n || '').replace(/[^0-9]/g, '');
    if (x.startsWith('0')) x = '62' + x.substring(1);
    return x;
};

const tentukanCaraLogin = async () => {
    // Sudah pernah ditanya di proses ini — pakai jawaban yang sama
    if (modeDipilih) return { mode: modeDipilih, nomor: nomorDipilih };

    // Mode sudah dipastikan di pengaturan, tidak perlu bertanya
    if (LOGIN_MODE !== 'tanya') {
        modeDipilih = LOGIN_MODE;
        nomorDipilih = NOMOR_BOT;
        return { mode: modeDipilih, nomor: nomorDipilih };
    }

    // Dijalankan lewat pm2 / latar belakang: tidak ada tempat mengetik,
    // jadi jatuh ke QR supaya bot tidak menggantung menunggu jawaban.
    if (!process.stdin.isTTY) {
        _origLog('ℹ️ Dijalankan tanpa terminal interaktif (pm2), otomatis pakai QR.');
        _origLog('   Untuk memilih kode pairing, jalankan langsung: node index.js');
        modeDipilih = 'qr';
        nomorDipilih = '';
        return { mode: modeDipilih, nomor: nomorDipilih };
    }

    _origLog('\n==========================================');
    _origLog('  PILIH CARA LOGIN');
    _origLog('==========================================');
    _origLog('  1. QR code      — scan pakai kamera HP');
    _origLog('  2. Kode pairing — ketik kode 8 digit di HP');
    _origLog('');

    let pilihan = '';
    while (!['1', '2'].includes(pilihan)) {
        pilihan = await tanya('Pilihan Anda (1 atau 2): ');
        if (!['1', '2'].includes(pilihan)) _origLog('   Ketik 1 atau 2 saja.');
    }

    if (pilihan === '1') {
        modeDipilih = 'qr';
        nomorDipilih = '';
        _origLog('✅ Mode: QR CODE\n');
        return { mode: modeDipilih, nomor: nomorDipilih };
    }

    let nomor = '';
    while (nomor.length < 8) {
        const isian = await tanya('Nomor WA bot (contoh 081234567890): ');
        nomor = rapikanNomor(isian);
        if (nomor.length < 8) _origLog('   Nomor tidak valid. Coba lagi.');
    }

    modeDipilih = 'pairing';
    nomorDipilih = nomor;
    _origLog(`✅ Mode: KODE PAIRING untuk ${nomor}\n`);
    return { mode: modeDipilih, nomor: nomorDipilih };
};

let tempWhitelist = [];
let isBulkRunning = false;
let sentHistory = new Set(); // Nomor yang sudah pernah dikirimi pada whitelist aktif

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

_origLog('==========================================');
_origLog('🤖 BOT SAYBA');
_origLog(`👤 Owner : ${pureOwner}`);
_origLog(`🔗 Login : ${LOGIN_MODE === 'tanya' ? 'akan ditanyakan di layar' : (LOGIN_MODE === 'pairing' ? `KODE PAIRING (${NOMOR_BOT})` : 'QR CODE')}`);
_origLog('==========================================');

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_sayba');

    // Kalau sesi sudah ada, tidak perlu login ulang — tidak usah bertanya.
    let pakaiPairing = false;
    let nomorPairing = '';

    if (!state.creds.registered) {
        const pilihan = await tentukanCaraLogin();
        pakaiPairing = (pilihan.mode === 'pairing') && Boolean(pilihan.nomor);
        nomorPairing = pilihan.nomor;
    }

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: !pakaiPairing
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================================
    // PENCATAT HASIL KIRIM
    // Memakai logPenting() supaya error pengiriman tidak ikut tersaring
    // oleh peredam log — dulu error seperti "Session error" hilang tanpa
    // jejak, sehingga bot terlihat "diam saja" tanpa penjelasan.
    // ==========================================================
    const _kirimAsli = sock.sendMessage.bind(sock);
    sock.sendMessage = async (jid, isi, opsi) => {
        const jenis = Object.keys(isi || {})[0] || '?';
        try {
            const hasil = await _kirimAsli(jid, isi, opsi);
            logPenting(`   📤 kirim ${jenis} ke ${jid} → OK (id: ${hasil?.key?.id || '-'})`);
            return hasil;
        } catch (err) {
            logPenting(`   ❌ GAGAL kirim ${jenis} ke ${jid}`);
            logPenting(`      Alasan: ${err?.message || err}`);
            if (err?.stack) logPenting(`      ${String(err.stack).split('\n')[1] || ''}`);
            throw err;
        }
    };

    // ==========================================================
    // STATUS PENGIRIMAN + CADANGAN OTOMATIS
    //
    // Alamat @lid kadang DITOLAK WhatsApp: pengiriman dapat ID, lalu
    // statusnya kembali sebagai ERROR dan pesan tidak pernah sampai.
    // Kalau itu terjadi, bot mencoba sekali lagi lewat nomor telepon
    // yang WhatsApp sendiri sebutkan sebagai pemilik LID tersebut.
    //
    // Nomor cadangan ini TIDAK dipakai kecuali WhatsApp benar-benar
    // menolak kiriman pertama — jadi tidak ada pesan nyasar.
    // ==========================================================
    const namaStatus = { 0: 'ERROR', 1: 'MENUNGGU', 2: 'SERVER', 3: 'SAMPAI', 4: 'DIBACA', 5: 'DIPUTAR' };
    const cadanganKirim = new Map(); // id pesan -> { isi, nomorJid, sudahDicoba }

    sock.ev.on('messages.update', async (daftar) => {
        for (const u of daftar) {
            const st = u.update?.status;
            if (st === undefined || st === null) continue;
            if (!u.key?.fromMe) continue;

            const id = u.key?.id;
            logPenting(`   📬 pesan ${id} → ${namaStatus[st] || st}`);

            if (st !== 0) continue; // hanya tangani yang ERROR

            const cadangan = cadanganKirim.get(id);
            if (!cadangan) {
                logPenting('      ⚠️ Ditolak WhatsApp, dan tidak ada nomor cadangan untuk dicoba.');
                continue;
            }
            if (cadangan.sudahDicoba) continue;
            cadangan.sudahDicoba = true;

            logPenting(`      ↪️ Ditolak. Mencoba lewat nomor: ${cadangan.nomorJid}`);
            try {
                const ulang = await sock.sendMessage(cadangan.nomorJid, cadangan.isi);
                logPenting(`      ✅ Terkirim ulang (id: ${ulang?.key?.id || '-'})`);
            } catch (err) {
                logPenting(`      ❌ Gagal juga lewat nomor: ${err?.message || err}`);
            }
        }
    });

    // === LOGIN PAKAI KODE PAIRING ===
    if (pakaiPairing) {
        const mintaKode = async (sisaPercobaan = 3) => {
            try {
                const kode = await sock.requestPairingCode(nomorPairing);
                const rapi = kode.match(/.{1,4}/g).join('-');
                waktuKodeTerakhir = Date.now();

                _origLog('\n==========================================');
                _origLog('🔗 KODE PAIRING');
                _origLog(`📱 Nomor : ${nomorPairing}`);
                _origLog(`🔢 KODE  : ${rapi}`);
                _origLog('');
                _origLog('Buka WhatsApp di HP nomor itu:');
                _origLog('  Titik tiga > Perangkat Tertaut');
                _origLog('  > Tautkan perangkat');
                _origLog('  > Tautkan dengan nomor telepon');
                _origLog('  > ketik kodenya TANPA tanda strip');
                _origLog('==========================================\n');
            } catch (err) {
                const pesan = err?.message || String(err);
                if (sisaPercobaan > 0) {
                    _origLog(`⏳ Kode belum bisa diminta (${pesan}). Coba lagi 8 detik lagi... [sisa ${sisaPercobaan}]`);
                    setTimeout(() => mintaKode(sisaPercobaan - 1), 8000);
                } else {
                    _origError(`❌ Gagal meminta kode pairing: ${pesan}`);
                    _origError(`   Periksa nomor "${nomorPairing}" dan koneksi internet, lalu jalankan ulang bot.`);
                }
            }
        };

        const sisaJeda = JEDA_KODE_MS - (Date.now() - waktuKodeTerakhir);
        if (sisaJeda > 0) {
            _origLog(`⏳ Kode sebelumnya masih berlaku (~${Math.ceil(sisaJeda / 1000)} detik lagi). Tidak minta kode baru dulu.`);
        } else {
            setTimeout(() => mintaKode(), 5000);
        }
    }

    // Alamat chat owner untuk laporan bulk. Nilai awal ditebak dari pureOwner,
    // lalu diperbarui otomatis begitu owner benar-benar mengirim chat ke bot —
    // supaya laporan tidak nyasar kalau tebakannya salah.
    let ownerJid = /^[1-9][0-9]{7,14}$/.test(pureOwner) && pureOwner.startsWith('62')
        ? `${pureOwner}@s.whatsapp.net`
        : `${pureOwner}@lid`;

    const reportOwner = async (text) => {
        try {
            await sock.sendMessage(ownerJid, { text });
        } catch (err) {
            _origError('⚠️ Gagal mengirim laporan ke Owner:', err?.message || err);
        }
    };

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !pakaiPairing) {
            console.log('\n--- SISTEM MEMINTA LOGIN ---');
            qrcode.generate(qr, { small: true });
            console.log('SILAKAN SCAN QR CODE DI ATAS!');
            console.log('(Kalau QR terpotong: putar HP ke landscape atau perkecil font Termux)\n');
        }

        if (connection === 'close') {
            const kode = lastDisconnect?.error?.output?.statusCode;
            const namaAlasan = {
                401: 'loggedOut — perangkat dikeluarkan dari Perangkat Tertaut',
                403: 'forbidden — nomor kemungkinan dibatasi WhatsApp',
                408: 'timedOut — koneksi internet terputus/lambat',
                428: 'connectionClosed — koneksi ditutup, biasanya jaringan',
                440: 'connectionReplaced — sesi diambil alih perangkat lain',
                500: 'badSession — file sesi rusak',
                515: 'restartRequired — normal setelah scan QR'
            };
            _origLog(`🔌 Koneksi terputus | kode: ${kode || '-'} | ${namaAlasan[kode] || lastDisconnect?.error?.message || 'tidak diketahui'}`);

            if (kode === DisconnectReason.loggedOut) {
                _origLog('❌ Bot ter-logout. Hapus folder auth_sayba lalu jalankan ulang untuk scan QR baru.');
                return;
            }

            // 440 = sesi diambil alih proses/perangkat lain. Menyambung ulang
            // hanya melanjutkan saling-tendang tanpa henti, jadi bot berhenti.
            if (kode === 440) {
                _origLog('==========================================');
                _origLog('❌ SESI DIPAKAI PROSES LAIN (kode 440).');
                _origLog('   Bot berhenti supaya tidak saling menendang tanpa henti.');
                _origLog('');
                _origLog('   Biasanya karena bot jalan dua kali sekaligus.');
                _origLog('   Hentikan semuanya dulu, lalu jalankan SATU saja:');
                _origLog('     pm2 delete all');
                _origLog('     pkill -f "node index.js"');
                _origLog('     pm2 start index.js --name bot');
                _origLog('');
                _origLog('   Kalau tetap terjadi, cek juga WhatsApp > Perangkat');
                _origLog('   Tertaut — mungkin ada sesi lama yang masih aktif.');
                _origLog('==========================================');
                return;
            }

            setTimeout(() => startBot(), 3000);
        } else if (connection === 'open') {
            console.log('✅ Bot Sayba berhasil terhubung ke WhatsApp!');
            mulaiKonsol();   // buka prompt perintah di terminal

            // Bot ini tertaut ke akun yang mana — penting untuk memastikan
            // Anda tidak sedang chat dari akun yang sama dengan botnya.
            const idBot = sock.user?.id || '?';
            _origLog('🪪 IDENTITAS BOT:');
            _origLog(`   Nomor : ${idBot}`);
            _origLog(`   LID   : ${sock.user?.lid || '-'}`);
            _origLog(`   Nama  : ${sock.user?.name || '-'}`);
            _origLog(`   Owner : ${pureOwner}`);

            if (String(idBot).includes(pureOwner)) {
                _origLog('   ⚠️ BOT TERTAUT KE AKUN OWNER SENDIRI!');
                _origLog('      Pesan Anda akan terbaca "fromMe" dan SELALU diabaikan.');
                _origLog('      Bot harus ditautkan ke nomor WA yang BERBEDA dari nomor Anda.');
            }
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
            _origLog(`   ⚠️ Gagal membaca nama grup: ${err?.message || err}`);
            return '';
        }
    };

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];

        // Bukti bahwa pesan benar-benar sampai ke bot. Kalau baris ini tidak
        // pernah muncul saat Anda chat, berarti pesannya memang tidak sampai —
        // bukan soal perintah yang salah.
        _origLog(`📩 masuk | dari: ${msg?.key?.remoteJid || '?'} | fromMe: ${msg?.key?.fromMe} | jenis: ${msg?.message ? Object.keys(msg.message)[0] : 'kosong'}`);

        if (!msg.message) {
            _origLog('   ⚠️ Isi pesan tidak bisa dibuka (sesi belum cocok). Biasanya sembuh sendiri.');
            return;
        }
        if (msg.key.fromMe) {
            _origLog('   ⏭️ Pesan dari akun bot sendiri, diabaikan.');
            return;
        }

        const sender = msg.key.remoteJid;
        if (!sender) return; // Pesan tanpa alamat pengirim, abaikan

        const isGroup = sender.endsWith('@g.us');

        // Pesan sistem di grup (notifikasi kunci enkripsi, anggota masuk/keluar)
        // kadang tidak membawa "participant" sama sekali — nilainya null.
        // Tanpa penjagaan ini, .split() akan error dan pesan itu tidak terproses.
        const participant = (isGroup ? msg.key.participant : sender) || '';
        const pureParticipant = participant.split(':')[0].split('@')[0];
        if (!pureParticipant) return; // Tidak jelas siapa pengirimnya, abaikan

        const isOwner = (pureParticipant === pureOwner);

        // Begitu owner benar-benar chat, pakai alamat chat itu untuk laporan
        if (isOwner && !isGroup && sender !== ownerJid) {
            ownerJid = sender;
            _origLog(`📮 Alamat laporan owner: ${ownerJid}`);
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
        const command = args[0].toLowerCase();

        _origLog(`   ↳ teks: "${text.slice(0, 40)}" | pengirim: ${pureParticipant} | owner? ${isOwner ? 'YA' : 'TIDAK'}`);

        // ==========================================================
        // GERBANG GRUP
        // Di grup, bot hanya menanggapi kalau nama grupnya terdaftar di
        // GRUP_IZIN. Grup lain diabaikan sepenuhnya — bot tidak membalas
        // apa pun di sana, walau ikut jadi anggota.
        // ==========================================================
        if (isGroup) {
            const namaGrupIni = await ambilNamaGrup(sender);
            const boleh = grupDiizinkan(namaGrupIni);
            _origLog(`   👥 Grup: "${namaGrupIni}" | diizinkan? ${boleh ? 'YA' : 'TIDAK'}`);
            if (!boleh) return;
        }

        // ==========================================================
        // ALAMAT BALASAN
        // Bot HANYA membalas ke chat asal pesan. Tidak pernah mengirim ke
        // alamat lain, supaya balasan tidak nyasar ke nomor orang lain.
        //
        // WhatsApp kadang menyebut identitas alternatif pengirim (senderPn,
        // remoteJidAlt, dll). Itu hanya DICATAT di log sebagai informasi,
        // TIDAK dipakai sebagai tujuan kirim.
        // ==========================================================
        // Pelajari pasangan LID <-> nomor dari pesan ini, kalau WhatsApp
        // menyebutkan keduanya. Inilah satu-satunya cara mengumpulkannya.
        const lidTerlihat = msg.key.senderLid || (String(sender).endsWith('@lid') ? sender : null);
        const nomorTerlihat = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJidAlt;
        if (lidTerlihat && nomorTerlihat && catatPasangan(lidTerlihat, nomorTerlihat)) {
            _origLog(`   🔗 Pasangan baru dicatat: ${bersihkanId(lidTerlihat)} = ${bersihkanId(nomorTerlihat)} (total ${petaLid.size})`);
        }

        // Nomor telepon yang WhatsApp sebutkan sebagai pemilik chat ini.
        // Hanya dipakai sebagai CADANGAN, kalau kiriman ke alamat chat
        // ditolak WhatsApp (status ERROR). Tidak dipakai kalau berhasil.
        let nomorCadangan = null;
        for (const alt of [msg.key.senderPn, msg.key.participantPn, msg.key.remoteJidAlt]) {
            if (typeof alt !== 'string' || !alt) continue;
            const bersih = alt.split(':')[0].split('@')[0];
            if (!bersih) continue;
            nomorCadangan = `${bersih}@s.whatsapp.net`;
            break;
        }
        if (nomorCadangan && nomorCadangan !== sender) {
            _origLog(`   ℹ️ Nomor cadangan bila ditolak: ${nomorCadangan}`);
        } else {
            nomorCadangan = null;
        }

        const balas = async (isi) => {
            try {
                const hasil = await sock.sendMessage(sender, isi, { quoted: msg });
                // Catat, supaya bisa dikirim ulang lewat nomor kalau ditolak
                if (hasil?.key?.id && nomorCadangan) {
                    cadanganKirim.set(hasil.key.id, { isi, nomorJid: nomorCadangan, sudahDicoba: false });
                }
            } catch (err) {
                logPenting(`   ❌ Balasan ke ${sender} gagal: ${err?.message || err}`);
            }
        };

        // ==========================================================
        // FITUR PUBLIK (BISA DIAKSES SEMUA ORANG)
        // ==========================================================
        if (['info', 'link', 'sayba'].includes(command)) {
            await balas({ text: 'Kunjungi website resmi kami di: https://sayba.id' });
            return;
        }

        // ==========================================================
        // FITUR MATA-MATA (FORWARD KE OWNER)
        // ==========================================================
        if (!isOwner) {
            // Jika ada orang chat pribadi ke bot, teruskan ke Owner
            if (!isGroup) {
                await sock.sendMessage(ownerJid, { text: `🔔 *PESAN DARI CUSTOMER MASUK KE BOT*\nPengirim: https://wa.me/${pureParticipant}` });
                await sock.sendMessage(ownerJid, { forward: msg });
            }
            return; // STOP DI SINI! Orang asing tidak bisa akses fitur admin di bawah ini.
        }

        // ==========================================================
        // FITUR ADMIN (HANYA OWNER YANG BISA)
        // ==========================================================

        // Perintah admin dikerjakan di satu tempat, supaya bisa dipanggil
        // dari WhatsApp MAUPUN dari konsol terminal.
        await jalankanPerintah({ command, args, balas, extendedMessage, sender });
    });


    // ==========================================================
    // KONSOL TERMINAL
    // Ketik perintah langsung di Termux, tanpa lewat WhatsApp.
    // Berguna kalau balasan WhatsApp tidak sampai — semua hasil
    // dicetak di layar, bukan dikirim sebagai chat.
    //
    // Hanya aktif kalau dijalankan interaktif (node index.js).
    // Lewat pm2 tidak ada tempat mengetik, jadi dilewati.
    // ==========================================================
    let konsolAktif = false;

    const mulaiKonsol = () => {
        if (konsolAktif) return;
        if (!process.stdin.isTTY) {
            _origLog('ℹ️ Konsol terminal tidak aktif (dijalankan lewat pm2).');
            _origLog('   Untuk memakainya, jalankan langsung: node index.js');
            return;
        }
        konsolAktif = true;

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: '\nbot> '
        });

        logPenting('\n==========================================');
        logPenting('  KONSOL TERMINAL AKTIF');
        logPenting('  Ketik perintah di sini, hasilnya tampil di layar.');
        logPenting('  Ketik "bantuan" untuk daftar perintah, "keluar" untuk berhenti.');
        logPenting('==========================================');
        rl.prompt();

        rl.on('line', async (baris) => {
            const teks = String(baris || '').trim();
            if (!teks) return rl.prompt();

            if (['keluar', 'exit', 'quit'].includes(teks.toLowerCase())) {
                logPenting('👋 Konsol ditutup. Bot tetap berjalan.');
                rl.close();
                konsolAktif = false;
                return;
            }

            if (['bantuan', 'help', '?'].includes(teks.toLowerCase())) {
                logPenting('');
                logPenting('  .status                      Lihat kondisi bot');
                logPenting('  .getmembers <nama grup>      Sedot nomor anggota grup');
                logPenting('  .setwhitelist <nomor>        Simpan daftar target');
                logPenting('  .bulk <pesan>                Kirim pesan ke seluruh whitelist');
                logPenting('  .stopbulk                    Hentikan pengiriman');
                logPenting('  .kirim <nomor> <pesan>       Kirim pesan ke satu nomor');
                logPenting('  .peta                        Lihat catatan LID → nomor');
                logPenting('  .peta <lid/nomor>            Cari pasangan satu identitas');
                logPenting('  keluar                       Tutup konsol (bot tetap jalan)');
                logPenting('');
                return rl.prompt();
            }

            const args = teks.split(/ +/);
            const command = args[0].toLowerCase();

            // Di konsol, hasil dicetak ke layar — bukan dikirim ke WhatsApp
            const cetak = async (isi) => {
                if (isi?.text) {
                    logPenting('');
                    logPenting(String(isi.text).replace(/\*/g, ''));
                } else {
                    logPenting(`   [${Object.keys(isi || {})[0] || 'pesan'}]`);
                }
            };

            try {
                // .kirim hanya ada di konsol: kirim pesan ke satu nomor
                if (command === '.kirim') {
                    const tujuan = (args[1] || '').replace(/[^0-9]/g, '');
                    const isiPesan = args.slice(2).join(' ');
                    if (tujuan.length < 8 || !isiPesan) {
                        logPenting('❌ Format: .kirim 081234567890 halo apa kabar');
                        return rl.prompt();
                    }
                    const nomor = tujuan.startsWith('0') ? '62' + tujuan.slice(1) : tujuan;
                    const jid = `${nomor}@s.whatsapp.net`;
                    const cek = await sock.onWhatsApp(jid);
                    const ada = Array.isArray(cek) ? cek[0] : null;
                    logPenting(`🔎 ${nomor} terdaftar? ${ada?.exists ? 'YA' : 'TIDAK'}`);
                    if (!ada?.exists) return rl.prompt();
                    await sock.sendMessage(ada.jid || jid, { text: isiPesan });
                    return rl.prompt();
                }

                await jalankanPerintah({
                    command,
                    args,
                    balas: cetak,
                    extendedMessage: null,
                    sender: ownerJid
                });
            } catch (err) {
                logPenting(`❌ Error: ${err?.message || err}`);
            }
            rl.prompt();
        });

        rl.on('close', () => { konsolAktif = false; });
    };

    // ==========================================================
    // PERINTAH ADMIN
    // Dipanggil dari dua jalur:
    //   1. Chat WhatsApp  -> balas() mengirim balasan ke chat
    //   2. Konsol terminal -> balas() mencetak ke layar Termux
    // ==========================================================
    const jalankanPerintah = async ({ command, args, balas, extendedMessage, sender }) => {
        // Lihat / cari isi catatan pasangan LID <-> nomor
        if (command === '.peta') {
            const cari = (args[1] || '').replace(/[^0-9]/g, '');

            if (cari) {
                const nomor = nomorDariLid(cari);
                if (nomor) return await balas({ text: `🔗 LID ${cari}\n📱 Nomor: ${nomor}` });

                // Coba juga arah sebaliknya: nomor -> LID
                const lidKetemu = [...petaLid.entries()].find(([, n]) => n === cari);
                if (lidKetemu) return await balas({ text: `📱 Nomor ${cari}\n🔗 LID: ${lidKetemu[0]}` });

                return await balas({ text: `❌ ${cari} belum ada di catatan.\n\nPasangan hanya tercatat kalau orangnya pernah mengirim pesan ke bot, atau WhatsApp menyebutkannya di data grup.` });
            }

            if (petaLid.size === 0) {
                return await balas({ text: '📒 Catatan LID masih kosong.\n\nAkan terisi sendiri setiap ada orang mengirim pesan ke bot.' });
            }

            let daftar = `📒 *CATATAN LID → NOMOR* (${petaLid.size})\n\n`;
            let n = 0;
            for (const [lid, nomor] of petaLid) {
                if (++n > 50) { daftar += `\n_...dan ${petaLid.size - 50} lainnya (lihat file peta_lid.json)_`; break; }
                daftar += `${lid} → ${nomor}\n`;
            }
            return await balas({ text: daftar });
        }

        if (command === '.getmembers') {
            const groupName = args.slice(1).join(" ");
            if (!groupName) return await balas({ text: '❌ Ketik nama grupnya.' });

            const groups = await sock.groupFetchAllParticipating();
            let targetGroup = null;

            for (let id in groups) {
                if (groups[id].subject === groupName) {
                    targetGroup = groups[id];
                    break;
                }
            }

            if (!targetGroup) return await balas({ text: `❌ Grup tidak ditemukan.` });

            const members = targetGroup.participants;
            let countRealNumber = 0;
            let countLID = 0;
            let countAdminSkipped = 0;
            let countSelfSkipped = 0;
            let countTerjemah = 0;
            let memberList = "";

            // Sebagian data grup menyertakan LID dan nomor sekaligus.
            // Kalau ada, catat dulu sebagai bekal menerjemahkan.
            members.forEach(mem => {
                const nomorAlt = mem.jid || mem.phoneNumber || mem.pn;
                if (mem.id && nomorAlt) catatPasangan(mem.id, nomorAlt);
            });

            // Menyedot Nomor Asli + Kode Rahasia (LID), TANPA admin grup & nomor sendiri
            members.forEach(mem => {
                const isAdmin = (mem.admin === 'admin' || mem.admin === 'superadmin');
                const pureId = mem.id.split(':')[0].split('@')[0];

                if (isAdmin) { countAdminSkipped++; return; }              // Kecualikan admin & owner grup
                if (pureId === pureOwner) { countSelfSkipped++; return; }  // Kecualikan nomor sendiri

                if (mem.id.endsWith('@s.whatsapp.net')) {
                    memberList += `${mem.id.split('@')[0]}\n`;
                    countRealNumber++;
                } else if (mem.id.endsWith('@lid')) {
                    // Kalau pasangannya sudah pernah dicatat, tampilkan nomornya
                    const nomorKetemu = nomorDariLid(mem.id);
                    if (nomorKetemu) {
                        memberList += `${nomorKetemu}\n`;
                        countRealNumber++;
                        countTerjemah++;
                    } else {
                        memberList += `${mem.id}\n`; // Belum diketahui, tampilkan LID apa adanya
                        countLID++;
                    }
                }
            });

            let replyText = `*Daftar Nomor Anggota Grup: ${groupName}*\n`;
            if (countTerjemah > 0) replyText += `🔗 ${countTerjemah} LID berhasil diterjemahkan jadi nomor (dari catatan).\n`;
            replyText += `Berhasil disedot: ${countRealNumber} nomor asli & ${countLID} ID Rahasia (LID)\n`;
            replyText += `Dikecualikan: ${countAdminSkipped} admin/owner grup`;
            if (countSelfSkipped > 0) replyText += ` + ${countSelfSkipped} nomor Anda sendiri`;
            replyText += `\n\n${memberList}`;

            await balas({ text: replyText });
        }

        if (command === '.setwhitelist') {
            const numbersText = args.slice(1).join(" ");
            // Memisahkan berdasarkan enter, koma, atau spasi
            const rawNumbers = numbersText.split(/[\n, ]+/).map(n => n.trim()).filter(n => n.length > 5);

            if (rawNumbers.length === 0) return await balas({ text: '❌ Format salah.' });

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

            await balas({ text: wlText });
        }

        if (command === '.bulk') {
            if (isBulkRunning) return await balas({ text: '⚠️ Masih ada proses bulk yang berjalan. Tunggu selesai, atau ketik *.stopbulk*.' });
            if (tempWhitelist.length === 0) return await balas({ text: '❌ Memori kosong!' });

            // Isi yang akan dikirim bisa datang dari dua cara:
            //   1. Dari WhatsApp  -> reply pesan promo, lalu ketik .bulk
            //   2. Dari terminal   -> .bulk <teks promonya langsung>
            const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.stanzaId;
            const teksLangsung = args.slice(1).join(' ').trim();

            let isiKiriman;

            if (isReply) {
                const quotedContext = extendedMessage.contextInfo;
                isiKiriman = {
                    forward: {
                        key: {
                            remoteJid: sender,
                            id: quotedContext.stanzaId,
                            participant: quotedContext.participant
                        },
                        message: quotedContext.quotedMessage
                    }
                };
            } else if (teksLangsung) {
                isiKiriman = { text: teksLangsung };
            } else {
                return await balas({ text: '❌ Reply pesan promo lalu ketik *.bulk*,\natau ketik langsung: *.bulk isi pesannya di sini*' });
            }

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
                return await balas({ text: `❌ Semua nomor di memori sudah pernah dikirimi pesan pada sesi ini.\n\nBuat whitelist baru dengan *.setwhitelist* jika ingin mengirim ulang.` });
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
            await balas({ text: startText });

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
            if (!isBulkRunning) return await balas({ text: 'ℹ️ Tidak ada proses bulk yang berjalan.' });
            isBulkRunning = false;
            await balas({ text: '🛑 Perintah berhenti diterima. Bulk akan berhenti setelah jeda yang sedang berjalan selesai.' });
        }

        if (command === '.status') {
            const upSec = Math.floor(process.uptime());
            const jam = Math.floor(upSec / 3600);
            const menit = Math.floor((upSec % 3600) / 60);

            let statusText = `📊 *STATUS BOT SAYBA*\n\n`;
            statusText += `🟢 Aktif: ${jam} jam ${menit} menit\n`;
            statusText += `📋 Whitelist di memori: ${tempWhitelist.length} nomor\n`;
            statusText += `📨 Sudah dikirimi (sesi ini): ${sentHistory.size} nomor\n`;
            statusText += `⚙️ Bulk berjalan: ${isBulkRunning ? 'YA' : 'tidak'}\n`;
            statusText += `🔇 Log enkripsi diredam: ${decryptErrorCount}x`;
            if (lastDecryptError) statusText += `\n🕐 Terakhir: ${lastDecryptError}`;
            statusText += `\n\n_Log enkripsi yang diredam itu normal dan sembuh sendiri._`;

            await balas({ text: statusText });
        }
    };
}

startBot();
