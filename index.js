const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const pureOwner = "268697650352299";
let tempWhitelist = [];
let isBulkRunning = false;

// Jeda acak antar pengiriman (dalam menit)
const MIN_DELAY_MINUTE = 1;
const MAX_DELAY_MINUTE = 15;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelayMs = () => {
    const minSec = MIN_DELAY_MINUTE * 60;
    const maxSec = MAX_DELAY_MINUTE * 60;
    const sec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    return sec * 1000;
};

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
                const ownerJid = pureOwner + "@s.whatsapp.net";
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

            tempWhitelist = [];
            for (let num of rawNumbers) {
                if (num.endsWith('@lid')) {
                    tempWhitelist.push(num); // Jika LID, langsung simpan
                } else {
                    let formattedNum = num.replace(/[^0-9]/g, '');
                    if (formattedNum.startsWith('0')) formattedNum = '62' + formattedNum.substring(1);
                    formattedNum += '@s.whatsapp.net';
                    tempWhitelist.push(formattedNum);
                }
            }

            await sock.sendMessage(sender, { text: `✅ Berhasil menyimpan *${tempWhitelist.length} target* (termasuk nomor & LID) ke memori.\n\nSilakan Reply pesan promosi Anda dengan perintah: *.bulk*` }, { quoted: msg });
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

            const targets = [...tempWhitelist];
            tempWhitelist = [];
            isBulkRunning = true;

            const avgMinute = (MIN_DELAY_MINUTE + MAX_DELAY_MINUTE) / 2;
            const estimasi = Math.round((targets.length - 1) * avgMinute);
            await sock.sendMessage(sender, { text: `⏳ Memulai Forward pesan ke ${targets.length} target (Nomor + LID).\nJeda acak *${MIN_DELAY_MINUTE}-${MAX_DELAY_MINUTE} menit* per nomor.\nEstimasi selesai: ± ${estimasi} menit.\n\nKetik *.stopbulk* untuk menghentikan.` }, { quoted: msg });

            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < targets.length; i++) {
                if (!isBulkRunning) {
                    await sock.sendMessage(sender, { text: `🛑 Bulk dihentikan. Terkirim ${successCount} dari ${targets.length} target.` });
                    break;
                }

                const targetJid = targets[i];
                try {
                    await sock.sendMessage(targetJid, { forward: messageToForward });
                    successCount++;
                    console.log(`[${i + 1}/${targets.length}] ✅ Terkirim ke ${targetJid}`);
                } catch (err) {
                    failCount++;
                    console.log(`[${i + 1}/${targets.length}] ❌ Gagal kirim ke ${targetJid}`);
                }

                // Jeda acak sebelum target berikutnya (target terakhir tidak perlu jeda)
                if (i < targets.length - 1 && isBulkRunning) {
                    const delay = randomDelayMs();
                    console.log(`⏱️  Menunggu ${formatDuration(delay)} sebelum target berikutnya...`);
                    await sleep(delay);
                }
            }

            if (isBulkRunning) {
                await sock.sendMessage(sender, { text: `✅ Selesai! Berhasil: ${successCount} target. Gagal: ${failCount} target.` }, { quoted: msg });
            }
            isBulkRunning = false;
        }

        if (command === '.stopbulk') {
            if (!isBulkRunning) return await sock.sendMessage(sender, { text: 'ℹ️ Tidak ada proses bulk yang berjalan.' }, { quoted: msg });
            isBulkRunning = false;
            await sock.sendMessage(sender, { text: '🛑 Perintah berhenti diterima. Bulk akan berhenti setelah jeda yang sedang berjalan selesai.' }, { quoted: msg });
        }
    });
}

startBot();
