const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const pureOwner = "268697650352299";
let tempWhitelist = [];

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
            let memberList = "";

            // Menyedot Nomor Asli + Kode Rahasia (LID)
            members.forEach(mem => {
                if (mem.id.endsWith('@s.whatsapp.net')) {
                    memberList += `${mem.id.split('@')[0]}\n`;
                    countRealNumber++;
                } else if (mem.id.endsWith('@lid')) {
                    memberList += `${mem.id}\n`; // MEMUNCULKAN LID
                    countLID++;
                }
            });

            let replyText = `*Daftar Nomor Anggota Grup: ${groupName}*\n`;
            replyText += `Berhasil disedot: ${countRealNumber} nomor asli & ${countLID} ID Rahasia (LID)\n\n`;
            replyText += memberList;

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

            await sock.sendMessage(sender, { text: `⏳ Memulai Forward pesan ke ${tempWhitelist.length} target (Nomor + LID)...` }, { quoted: msg });

            let successCount = 0;
            for (let targetJid of tempWhitelist) {
                try {
                    await sock.sendMessage(targetJid, { forward: messageToForward });
                    successCount++;
                    await new Promise(resolve => setTimeout(resolve, 3000)); 
                } catch (err) {
                    console.log(`Gagal kirim ke ${targetJid}`);
                }
            }

            await sock.sendMessage(sender, { text: `✅ Selesai! Pesan berhasil diteruskan ke ${successCount} target.` }, { quoted: msg });
            tempWhitelist = [];
        }
    });
}

startBot();
