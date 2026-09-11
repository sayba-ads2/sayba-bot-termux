const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const pureOwner = "268697650352299";

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
            console.log('Koneksi terputus, mencoba reconnect...');
            if(shouldReconnect) startBot();
        } else if(connection === 'open') {
            console.log('✅ Bot Sayba berhasil terhubung ke WhatsApp!');
            console.log('--- MENUNGGU PESAN MASUK ---');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const participant = isGroup ? msg.key.participant : sender;
        const pureParticipant = participant.split(':')[0].split('@')[0];

        // --- CCTV DETEKTOR ---
        console.log(`\n[CCTV] Ada pesan masuk dari nomor: ${pureParticipant}`);
        console.log(`[CCTV] Apakah ini nomor owner? ${pureParticipant === pureOwner ? "YA" : "BUKAN"}`);
        // ----------------------

        if (pureParticipant !== pureOwner) {
            console.log(`[CCTV] Ditolak! Karena nomor tidak cocok dengan owner.`);
            return;
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

        console.log(`[CCTV] Teks yang terbaca oleh sistem: "${text}"`);

        if (!text) return;

        const args = text.trim().split(/ +/);
        const command = args[0].toLowerCase();

        if (['info', 'link', 'sayba'].includes(command)) {
            console.log("[CCTV] Perintah Auto-Respon tereksekusi!");
            await sock.sendMessage(sender, { text: 'Kunjungi website resmi kami di: https://sayba.id' }, { quoted: msg });
        }

        if (command === '.getmembers') {
            const groupName = args.slice(1).join(" ");
            if (!groupName) {
                await sock.sendMessage(sender, { text: '❌ Ketik nama grupnya.' }, { quoted: msg });
                return;
            }

            const groups = await sock.groupFetchAllParticipating();
            let targetGroup = null;

            for (let id in groups) {
                if (groups[id].subject === groupName) {
                    targetGroup = groups[id];
                    break;
                }
            }

            if (!targetGroup) {
                await sock.sendMessage(sender, { text: `❌ Grup "${groupName}" tidak ditemukan.` }, { quoted: msg });
                return;
            }

            const members = targetGroup.participants;
            let memberList = `*Daftar Nomor Anggota Grup: ${groupName}*\nTotal: ${members.length} member\n\n`;
            members.forEach(mem => {
                memberList += `${mem.id.split('@')[0]}\n`;
            });

            await sock.sendMessage(sender, { text: memberList }, { quoted: msg });
        }

        if (command === '.bulk') {
            const broadcastMessage = args.slice(1).join(" ");
            const isReply = extendedMessage && extendedMessage.contextInfo && extendedMessage.contextInfo.quotedMessage;
            
            if (!isReply) {
                await sock.sendMessage(sender, { text: '❌ Anda harus me-reply pesan berisi whitelist.' }, { quoted: msg });
                return;
            }
            if (!broadcastMessage) return;

            const quotedMsg = extendedMessage.contextInfo.quotedMessage;
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || quotedMsg.ephemeralMessage?.message?.conversation || quotedMsg.ephemeralMessage?.message?.extendedTextMessage?.text || "";

            const rawNumbers = quotedText.split(/[\n,]/).map(n => n.trim()).filter(n => n.length > 8);
            if (rawNumbers.length === 0) return;

            await sock.sendMessage(sender, { text: `⏳ Memulai pengiriman massal ke ${rawNumbers.length} nomor...` }, { quoted: msg });

            let successCount = 0;
            for (let num of rawNumbers) {
                let formattedNum = num.replace(/[^0-9]/g, '');
                if (formattedNum.startsWith('0')) formattedNum = '62' + formattedNum.substring(1);
                formattedNum += '@s.whatsapp.net';

                try {
                    await sock.sendMessage(formattedNum, { text: broadcastMessage });
                    successCount++;
                    await new Promise(resolve => setTimeout(resolve, 3000)); 
                } catch (err) {}
            }

            await sock.sendMessage(sender, { text: `✅ Berhasil mengirim pesan promosi ke ${successCount} nomor.` }, { quoted: msg });
        }
    });
}

startBot();
