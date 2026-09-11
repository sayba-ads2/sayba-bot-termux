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

const pureOwner = "268697650352299";
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

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_sayba');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n--- SISTEM MEMINTA LOGIN ---');
            qrcode.generate(qr, { small: true });
            console.log('SILAKAN SCAN QR CODE DI ATAS!\n');
        }

        if(connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if(shouldReconnect) startBot();
        } else if(connection === 'open') {
            console.log('✅ Bot Sayba CANGGIH berhasil terhubung ke WhatsApp!');
        }
    });

    const ownerJid = pureOwner + "@s.whatsapp.net";

    // Semua laporan progres bulk dikirim ke chat pribadi Owner
    const reportOwner = async (text) => {
        try {
            await sock.sendMessage(ownerJid, { text });
        } catch (err) {
            console.log('⚠️ Gagal mengirim laporan ke Owner:', err?.message || err);
        }
    };

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const participant = isGroup ? msg.key.participant : sender;
        const pureParticipant = participant.split(':')[0].split('@')[0];
        const isOwner = (pureParticipant === pureOwner);

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

        // ==========================================
        // FITUR PUBLIK (BISA DIAKSES SEMUA ORANG)
        // ==========================================
        if (['info', 'link', 'sayba'].includes(command)) {
            await sock.sendMessage(sender, { text: 'Kunjungi website resmi kami di: https://sayba.id' }, { quoted: msg });
            return;
        }

        // ==========================================
        // FITUR MATA-MATA (FORWARD KE OWNER)
        // ==========================================
        if (!isOwner) {
            // Jika ada orang chat pribadi ke bot, teruskan ke Owner
            if (!isGroup) {
                await sock.sendMessage(ownerJid, { text: `🔔 *PESAN DARI CUSTOMER MASUK KE BOT*\nPengirim: https://wa.me/${pureParticipant}` });
                await sock.sendMessage(ownerJid, { forward: msg });
            }
            return; // STOP DI SINI! Orang asing tidak bisa akses fitur admin di bawah ini.
        }

        // ==========================================
        // FITUR ADMIN (HANYA OWNER YANG BISA)
        // ==========================================

        if (command === '.getmembers') {
            const groupName = args.slice(1).join(" ");
            if (!groupName) return await sock.sendMessage(sender, { text: '❌ Ketik nama grupnya.' }, { quoted: msg });

            const groups = await sock.groupFetchAllParticipating();
            let targetGroup = null;

            for (let id in groups) {
                if (groups[id].subject === groupName) {
                    targetGroup = groups[id];
                    break;
                }
            }

            if (!targetGroup) return await sock.sendMessage(sender, { text: `❌ Grup tidak ditemukan.` }, { quoted: msg });

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

            await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
        }

        if (command === '.setwhitelist') {
            const numbersText = args.slice(1).join(" ");
            // Memisahkan berdasarkan enter, koma, atau spasi
            const rawNumbers = numbersText.split(/[\n, ]+/).map(n => n.trim()).filter(n => n.length > 5);

            if (rawNumbers.length === 0) return await sock.sendMessage(sender, { text: '❌ Format salah.' }, { quoted: msg });

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

            await sock.sendMessage(sender, { text: wlText }, { quoted: msg });
        }

        if (command === '.bulk') {
            if (isBulkRunning) return await sock.sendMessage(sender, { text: '⚠️ Masih ada proses bulk yang berjalan. Tunggu selesai, atau ketik *.stopbulk*.' }, { quoted: msg });
            if (tempWhitelist.length === 0) return await sock.sendMessage(sender, { text: '❌ Memori kosong!' }, { quoted: msg });

            const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.stanzaId;
            if (!isReply) return await sock.sendMessage(sender, { text: '❌ Anda harus me-reply pesan!' }, { quoted: msg });

            const quotedContext = extendedMessage.contextInfo;
            const messageToForward = {
                key: {
                    remoteJid: sender,
                    id: quotedContext.stanzaId,
                    participant: quotedContext.participant
                },
                message: quotedContext.quotedMessage
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
                return await sock.sendMessage(sender, { text: `❌ Semua nomor di memori sudah pernah dikirimi pesan pada sesi ini.\n\nBuat whitelist baru dengan *.setwhitelist* jika ingin mengirim ulang.` }, { quoted: msg });
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
            await sock.sendMessage(sender, { text: startText }, { quoted: msg });

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
                        await sock.sendMessage(targetJid, { forward: messageToForward });
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
            if (!isBulkRunning) return await sock.sendMessage(sender, { text: 'ℹ️ Tidak ada proses bulk yang berjalan.' }, { quoted: msg });
            isBulkRunning = false;
            await sock.sendMessage(sender, { text: '🛑 Perintah berhenti diterima. Bulk akan berhenti setelah jeda yang sedang berjalan selesai.' }, { quoted: msg });
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

            await sock.sendMessage(sender, { text: statusText }, { quoted: msg });
        }
    });
}

startBot();
