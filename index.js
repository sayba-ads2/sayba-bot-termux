const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const pureOwner = "268697650352299";

// Memori sementara untuk menyimpan Whitelist
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
            console.log('✅ Bot Sayba berhasil terhubung ke WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const participant = sender.endsWith('@g.us') ? msg.key.participant : sender;
        const pureParticipant = participant.split(':')[0].split('@')[0];
        
        // HANYA merespon Owner
        if (pureParticipant !== pureOwner) return; 

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

        // 1. AUTO RESPON
        if (['info', 'link', 'sayba'].includes(command)) {
            await sock.sendMessage(sender, { text: 'Kunjungi website resmi kami di: https://sayba.id' }, { quoted: msg });
        }

        // =====================================
        // 2. MENGAMBIL NOMOR GRUP (ANTI LID)
        // =====================================
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

            // Menyaring nomor asli (whatsapp.net) vs nomor privasi (lid)
            members.forEach(mem => {
                if (mem.id.endsWith('@s.whatsapp.net')) {
                    memberList += `${mem.id.split('@')[0]}\n`;
                    countRealNumber++;
                } else if (mem.id.endsWith('@lid')) {
                    countLID++;
                }
            });

            let replyText = `*Daftar Nomor Anggota Grup: ${groupName}*\n`;
            replyText += `Berhasil disedot: ${countRealNumber} nomor asli\n`;
            if (countLID > 0) {
                replyText += `Gagal disedot: ${countLID} nomor (disembunyikan privasi WA)\n`;
            }
            replyText += `\n${memberList}`;

            await sock.sendMessage(sender, { text: replyText }, { quoted: msg });
        }

        // 3. MEMASUKKAN WHITELIST
        if (command === '.setwhitelist') {
            const numbersText = args.slice(1).join(" ");
            const rawNumbers = numbersText.split(/[\n,]/).map(n => n.trim()).filter(n => n.length > 8);
            
            if (rawNumbers.length === 0) {
                await sock.sendMessage(sender, { text: '❌ Format salah. Contoh:\n.setwhitelist 0812.., 0813..' }, { quoted: msg });
                return;
            }

            tempWhitelist = []; // Reset memori
            for (let num of rawNumbers) {
                let formattedNum = num.replace(/[^0-9]/g, '');
                if (formattedNum.startsWith('0')) formattedNum = '62' + formattedNum.substring(1);
                formattedNum += '@s.whatsapp.net';
                tempWhitelist.push(formattedNum);
            }

            await sock.sendMessage(sender, { text: `✅ Berhasil menyimpan *${tempWhitelist.length} nomor* ke memori Whitelist.\n\nSekarang, silakan cari pesan yang ingin Anda teruskan (teks/gambar/file), lalu Reply pesan tersebut dengan perintah: *.bulk*` }, { quoted: msg });
        }

        // 4. FORWARD KE WHITELIST
        if (command === '.bulk') {
            if (tempWhitelist.length === 0) {
                await sock.sendMessage(sender, { text: '❌ Memori Whitelist kosong! Silakan isi dulu dengan perintah .setwhitelist' }, { quoted: msg });
                return;
            }

            const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.stanzaId;
            if (!isReply) {
                await sock.sendMessage(sender, { text: '❌ Anda harus *me-reply* pesan yang ingin diteruskan.' }, { quoted: msg });
                return;
            }

            const quotedContext = extendedMessage.contextInfo;
            const messageToForward = {
                key: {
                    remoteJid: sender,
                    id: quotedContext.stanzaId,
                    participant: quotedContext.participant
                },
                message: quotedContext.quotedMessage
            };

            await sock.sendMessage(sender, { text: `⏳ Memulai *Forward* pesan ke ${tempWhitelist.length} nomor whitelist... (Jeda 3 detik antar pesan)` }, { quoted: msg });

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

            await sock.sendMessage(sender, { text: `✅ Selesai! Pesan berhasil diteruskan ke ${successCount} nomor.\n\n*(Memori Whitelist sekarang telah dikosongkan kembali untuk sesi berikutnya).*` }, { quoted: msg });
            
            tempWhitelist = [];
        }
    });
}

startBot();
