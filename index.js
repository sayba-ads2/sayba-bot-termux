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

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Paket 'qrcode' dipakai untuk membuat QR berupa gambar PNG (agar bisa dikirim
// lewat WhatsApp). Sifatnya opsional — kalau belum diinstal, bot tetap jalan
// dan QR hanya tampil di terminal. Install: npm install qrcode
let qrImage = null;
try { qrImage = require('qrcode'); } catch (e) { /* opsional */ }

// ==========================================
// KONFIGURASI PER-BOT (dibaca dari argumen / pm2)
// Pemakaian: node index.js <folderAuth> <nomorOwner> <kodeBot> <namaBot>
// Contoh   : node index.js auth_sayba2 6281234567890 2 "Sayba Dua"
// ==========================================
const AUTH_FOLDER = process.argv[2] || 'auth_sayba';
// Nomor owner WAJIB diisi lewat argumen / pm2, jangan ditulis di sini
// supaya nomor pribadi tidak ikut terunggah ke GitHub.
//
// BOLEH BEBERAPA, dipisah koma (tanpa spasi):
//   268697650352299,6281234567890
// Ini penting karena tiap bot bisa melihat Anda dengan LID yang BERBEDA.
// Cek dengan mengetik .ceklid di chat bot yang bersangkutan.
const OWNER_IDS = (process.argv[3] || '')
    .split(',')
    .map(x => x.replace(/[^0-9]/g, ''))
    .filter(Boolean);

const pureOwner = OWNER_IDS[0] || '';   // Dipakai untuk alamat kirim laporan
const isOwnerId = (id) => OWNER_IDS.includes(id);
const BOT_CODE    = (process.argv[4] || '1').toLowerCase();
const BOT_NAME    = process.argv[5] || `Sayba ${BOT_CODE}`;
const BOT_TAG     = `[BOT-${BOT_CODE.toUpperCase()} ${BOT_NAME}]`;
// Argumen ke-6 (opsional): nomor WA bot ini sendiri, format 62xxx.
// Kalau diisi, login pakai KODE PAIRING 8 digit — tidak perlu scan QR.
const BOT_NUMBER  = (process.argv[6] || '').replace(/[^0-9]/g, '');

// Folder titipan QR antar bot: bot yang sudah online akan mengirim QR
// milik bot lain ke WhatsApp Owner sebagai gambar.
const QR_SHARE_DIR = path.join(__dirname, 'qr_share');
try { fs.mkdirSync(QR_SHARE_DIR, { recursive: true }); } catch (e) {}

// Folder jembatan antar bot: perintah untuk bot lain dititipkan di sini,
// lalu diambil dan dikerjakan oleh bot yang bersangkutan.
const BRIDGE_DIR = path.join(__dirname, 'bridge');
try { fs.mkdirSync(BRIDGE_DIR, { recursive: true }); } catch (e) {}

// Semua perintah kini bisa lewat jembatan, termasuk .bulk — isi pesan promo
// (teks/gambar/video/dokumen) ikut dititipkan bersama perintahnya.
const BRIDGE_BLOCKED = [];

// Mengubah titipan menjadi objek siap kirim untuk sock.sendMessage
const bangunIsiDariPayload = (p) => {
    if (!p) return null;

    if (p.tipe === 'text') {
        return p.teks ? { text: p.teks } : null;
    }

    // Media: file-nya ada di folder bridge
    let data;
    try { data = fs.readFileSync(p.file); } catch (e) { return null; }

    switch (p.tipe) {
        case 'image':    return { image: data, caption: p.caption || undefined };
        case 'video':    return { video: data, caption: p.caption || undefined };
        case 'audio':    return { audio: data, mimetype: p.mimetype || 'audio/mp4', ptt: Boolean(p.ptt) };
        case 'sticker':  return { sticker: data };
        case 'document': return { document: data, mimetype: p.mimetype || 'application/octet-stream', fileName: p.fileName || 'file' };
        default:         return null;
    }
};

if (!pureOwner) {
    _origLog('❌ NOMOR OWNER BELUM DIISI!');
    _origLog('   Jalankan: node index.js <folderAuth> <nomorOwner> <kodeBot> "<namaBot>"');
    _origLog('   Contoh  : node index.js auth_sayba 628123456789 1 "Sayba Satu"');
    process.exit(1);
}

_origLog('==========================================');
_origLog(`🤖 ${BOT_TAG}`);
_origLog(`📁 Folder auth : ${AUTH_FOLDER}`);
_origLog(`👤 Owner       : ${OWNER_IDS.join(', ')}`);
_origLog(`🔑 Kode bot    : ${BOT_CODE}  (contoh perintah: .bulk${BOT_CODE})`);
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
let bridgeWatcher = null; // Pemantau titipan perintah antar bot

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    const usePairingCode = Boolean(BOT_NUMBER) && !state.creds.registered;

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: !usePairingCode
    });

    sock.ev.on('creds.update', saveCreds);

    // === LOGIN PAKAI KODE PAIRING (tanpa QR) ===
    if (usePairingCode) {
        setTimeout(async () => {
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
                _origError('❌ Gagal meminta kode pairing:', err?.message || err);
            }
        }, 4000);
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

            // Mulai memantau titipan perintah dari bot lain (sekali saja)
            if (!bridgeWatcher) {
                bridgeWatcher = setInterval(() => { ambilTitipan(); }, 3000);
                _origLog('🌉 Jembatan antar bot aktif.');
            }
        }
    });

    const ownerJid = pureOwner + "@s.whatsapp.net";

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

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];

        // Log diagnosa: bukti bahwa pesan benar-benar sampai ke bot ini
        _origLog(`📩 [${BOT_CODE}] pesan masuk | dari: ${msg?.key?.remoteJid || '?'} | fromMe: ${msg?.key?.fromMe} | jenis: ${msg?.message ? Object.keys(msg.message)[0] : 'kosong'}`);

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
        // PEMISAH PERINTAH ANTAR BOT
        // Perintah boleh diberi kode bot di belakang: .bulk2, .status1, info2
        // - Kode cocok  -> dikerjakan bot ini
        // - Kode beda   -> diabaikan (itu perintah untuk bot lain)
        // - Tanpa kode  -> hanya dilayani di chat pribadi, supaya di grup
        //                  tidak ada dua bot menjawab perintah yang sama
        // ==========================================
        const codeMatch = rawCommand.match(/^(\.?[a-z]+?)([0-9]+)$/);
        let command = rawCommand;
        let codeGiven = null;

        if (codeMatch) {
            command = codeMatch[1];
            codeGiven = codeMatch[2];
        }

        // Gerbang kode hanya berlaku untuk perintah, bukan chat biasa dari customer
        const isKnownCommand = command.startsWith('.') || ['info', 'link', 'sayba'].includes(command);

        if (isKnownCommand) {
            // Perintah untuk bot LAIN -> titipkan lewat jembatan (khusus owner)
            if (codeGiven !== null && codeGiven !== BOT_CODE) {
                if (!isOwner) return;

                if (BRIDGE_BLOCKED.includes(command)) {
                    await sock.sendMessage(sender, { text:
                        `⚠️ *${command}* tidak bisa dititipkan ke bot lain.`
                    }, { quoted: msg });
                    return;
                }

                try {
                    // .bulk perlu ikut membawa ISI pesan promo yang Anda reply,
                    // karena bot tujuan tidak punya akses ke chat ini.
                    let payload = null;

                    if (command === '.bulk') {
                        const ctx = extendedMessage && extendedMessage.contextInfo;
                        if (!ctx || !ctx.quotedMessage) {
                            await sock.sendMessage(sender, { text: '❌ Reply dulu pesan promonya, baru ketik *.bulk' + codeGiven + '*' }, { quoted: msg });
                            return;
                        }

                        payload = await siapkanPayload(ctx.quotedMessage, codeGiven);
                        if (!payload) {
                            await sock.sendMessage(sender, { text: '❌ Jenis pesan ini belum didukung untuk dititipkan. Kirim langsung dari chat bot ' + codeGiven + '.' }, { quoted: msg });
                            return;
                        }
                    }

                    const job = {
                        untuk: codeGiven,
                        dari: BOT_CODE,
                        command,
                        args: args.slice(1),
                        payload,
                        waktu: Date.now()
                    };
                    const namaFile = `job_${codeGiven}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
                    fs.writeFileSync(path.join(BRIDGE_DIR, namaFile), JSON.stringify(job));
                    await sock.sendMessage(sender, { text: `📨 Perintah *${command}* dititipkan ke bot ${codeGiven}. Balasannya akan dikirim bot tersebut.` }, { quoted: msg });
                } catch (err) {
                    await sock.sendMessage(sender, { text: `❌ Gagal menitipkan perintah: ${err?.message || err}` }, { quoted: msg });
                }
                return;
            }

            if (codeGiven === null && isGroup) return;                // Di grup wajib pakai kode
        } else {
            command = rawCommand; // Bukan perintah, biarkan apa adanya
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
                    return await sock.sendMessage(sender, { text: '❌ Format: *.ceklid 628123456789*' }, { quoted: msg });
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

            await sock.sendMessage(sender, { text: ck }, { quoted: msg });

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
        await runOwnerCommand({ command, args, sender, msg, extendedMessage, viaBridge: false });
    });

    // ==========================================
    // JEMBATAN ANTAR BOT — bungkus isi pesan promo agar bisa dititipkan
    // Teks dikirim apa adanya; media diunduh dulu jadi file di folder bridge.
    // ==========================================
    const siapkanPayload = async (quotedMessage, untukKode) => {
        const q = quotedMessage;

        // 1. Pesan teks
        const teks = q.conversation || q.extendedTextMessage?.text;
        if (teks) return { tipe: 'text', teks };

        // 2. Pesan media
        const jenis = [
            ['imageMessage', 'image', 'jpg'],
            ['videoMessage', 'video', 'mp4'],
            ['audioMessage', 'audio', 'mp3'],
            ['stickerMessage', 'sticker', 'webp'],
            ['documentMessage', 'document', 'bin']
        ];

        for (const [kunci, tipe, ext] of jenis) {
            const isi = q[kunci];
            if (!isi) continue;

            try {
                const buffer = await downloadMediaMessage(
                    { key: {}, message: { [kunci]: isi } },
                    'buffer',
                    {}
                );

                const namaFile = path.join(BRIDGE_DIR, `media_${untukKode}_${Date.now()}.${ext}`);
                fs.writeFileSync(namaFile, buffer);

                return {
                    tipe,
                    file: namaFile,
                    caption: isi.caption || '',
                    mimetype: isi.mimetype || '',
                    fileName: isi.fileName || `promo.${ext}`,
                    ptt: Boolean(isi.ptt)
                };
            } catch (err) {
                _origError('⚠️ Gagal mengunduh media untuk titipan:', err?.message || err);
                return null;
            }
        }

        return null; // Jenis lain belum didukung
    };

    // ==========================================
    // JEMBATAN ANTAR BOT — ambil perintah yang dititipkan bot lain
    // ==========================================
    const ambilTitipan = async () => {
        let files;
        try { files = fs.readdirSync(BRIDGE_DIR); } catch (e) { return; }

        for (const f of files) {
            // Buang file media nyasar yang sudah lebih dari 30 menit
            if (f.startsWith('media_')) {
                try {
                    const s = fs.statSync(path.join(BRIDGE_DIR, f));
                    if (Date.now() - s.mtimeMs > 1800000) fs.unlinkSync(path.join(BRIDGE_DIR, f));
                } catch (e) {}
                continue;
            }

            if (!f.startsWith(`job_${BOT_CODE}_`) || !f.endsWith('.json')) continue;

            const full = path.join(BRIDGE_DIR, f);
            let job;
            try {
                job = JSON.parse(fs.readFileSync(full, 'utf8'));
                fs.unlinkSync(full); // Hapus dulu supaya tidak dikerjakan dua kali
            } catch (e) { continue; }

            // Titipan basi (lebih dari 5 menit) diabaikan
            if (Date.now() - (job.waktu || 0) > 300000) {
                _origLog(`⏭️ Titipan ${job.command} dilewati (kedaluwarsa).`);
                continue;
            }

            _origLog(`📥 Menerima titipan dari bot ${job.dari}: ${job.command}`);
            await reportOwner(`📥 *TITIPAN DARI BOT ${job.dari}*\nMengerjakan: *${job.command}*`);

            try {
                await runOwnerCommand({
                    command: job.command,
                    args: [job.command, ...(job.args || [])],
                    sender: ownerJid,     // Balasan dikirim ke chat owner di bot ini
                    msg: null,            // Tidak ada pesan asli untuk di-reply
                    extendedMessage: null,
                    viaBridge: true,
                    bridgePayload: job.payload || null
                });
            } catch (err) {
                await reportOwner(`❌ Titipan *${job.command}* gagal: ${err?.message || err}`);
            }

            // File media titipan sudah tidak diperlukan
            if (job.payload && job.payload.file) {
                try { fs.unlinkSync(job.payload.file); } catch (e) {}
            }
        }
    };

    const runOwnerCommand = async ({ command, args, sender, msg, extendedMessage, viaBridge, bridgePayload }) => {
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

                // Isi yang akan dikirim: dari pesan yang di-reply (chat langsung),
                // atau dari titipan bot lain (jembatan).
                let isiKiriman = null;

                if (viaBridge) {
                    if (!bridgePayload) {
                        return await reportOwner('❌ Titipan *.bulk* tidak membawa isi pesan.');
                    }
                    isiKiriman = bangunIsiDariPayload(bridgePayload);
                    if (!isiKiriman) {
                        return await reportOwner(`❌ Jenis pesan *${bridgePayload.tipe}* tidak didukung untuk titipan.`);
                    }
                } else {
                    const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.stanzaId;
                    if (!isReply) return await sock.sendMessage(sender, { text: '❌ Anda harus me-reply pesan!' }, (msg ? { quoted: msg } : {}));

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
