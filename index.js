const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// Nomor Anda (Owner) - Pastikan formatnya 628...
const ownerNumber = "6287803445749@s.whatsapp.net";

async function startBot() {
    // Tempat menyimpan sesi login (QR Code) agar tidak scan ulang terus
    const { state, saveCreds } = await useMultiFileAuthState('auth_sayba');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" })
    });

    // Simpan sesi setiap ada pembaruan
    sock.ev.on('creds.update', saveCreds);

    // Deteksi status koneksi
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, mencoba reconnect...', shouldReconnect);
            if(shouldReconnect) startBot();
        } else if(connection === 'open') {
            console.log('✅ Bot Sayba berhasil terhubung ke WhatsApp!');
        }
    });

    // Deteksi pesan masuk
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if(!msg.message || msg.key.fromMe) return;

        // Mendapatkan nomor pengirim
        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');
        const participant = isGroup ? msg.key.participant : sender;
        
        // FITUR KEAMANAN: HANYA merespon nomor Owner (087803445749)
        if (participant !== ownerNumber) return; 

        // Mengambil isi teks dari pesan (baik pesan biasa atau balas/reply)
        const messageType = Object.keys(msg.message)[0];
        const text = messageType === 'conversation' ? msg.message.conversation : 
                     messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';

        // Memecah pesan menjadi per kata
        const args = text.trim().split(/ +/);
        const command = args[0].toLowerCase();

        // ==========================================
        // 1. FITUR AUTO RESPON (Ketik: info, link, atau sayba)
        // ==========================================
        if (['info', 'link', 'sayba'].includes(command)) {
            await sock.sendMessage(sender, { text: 'Kunjungi website resmi kami di: https://sayba.id' }, { quoted: msg });
        }

        // ==========================================
        // 2. FITUR MENGAMBIL NOMOR ANGGOTA GRUP
        // Cara pakai: .getmembers Nama Grup Anda
        // ==========================================
        if (command === '.getmembers') {
            const groupName = args.slice(1).join(" ");
            if (!groupName) {
                await sock.sendMessage(sender, { text: '❌ Ketik nama grupnya. Contoh:\n.getmembers Nama Grup Sayba' }, { quoted: msg });
                return;
            }

            // Minta data seluruh grup yang diikuti oleh bot
            const groups = await sock.groupFetchAllParticipating();
            let targetGroup = null;

            for (let id in groups) {
                if (groups[id].subject === groupName) {
                    targetGroup = groups[id];
                    break;
                }
            }

            // Peringatan: Bot harus dimasukkan ke grup tersebut terlebih dahulu
            if (!targetGroup) {
                await sock.sendMessage(sender, { text: `❌ Grup "${groupName}" tidak ditemukan. Pastikan bot sudah join di grup itu.` }, { quoted: msg });
                return;
            }

            const members = targetGroup.participants;
            let memberList = `*Daftar Nomor Anggota Grup: ${groupName}*\nTotal: ${members.length} member\n\n`;
            members.forEach(mem => {
                memberList += `${mem.id.split('@')[0]}\n`;
            });

            await sock.sendMessage(sender, { text: memberList }, { quoted: msg });
        }

        // ==========================================
        // 3. FITUR BULK MESSAGE WHITELIST 
        // Cara pakai: Reply (balas) chat berisi daftar nomor, lalu ketik pesan: .bulk Isi promosi
        // ==========================================
        if (command === '.bulk') {
            const broadcastMessage = args.slice(1).join(" ");
            const isReply = msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && msg.message.extendedTextMessage.contextInfo.quotedMessage;
            
            if (!isReply) {
                await sock.sendMessage(sender, { text: '❌ Anda harus *me-reply* (membalas) pesan yang berisi daftar nomor whitelist.' }, { quoted: msg });
                return;
            }
            if (!broadcastMessage) {
                await sock.sendMessage(sender, { text: '❌ Masukkan pesan promosi. Contoh:\n.bulk Halo, cek https://sayba.id ya!' }, { quoted: msg });
                return;
            }

            // Mengambil teks daftar nomor dari pesan yang di-reply
            const quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
            const quotedText = quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "";

            // Pisahkan teks berdasarkan baris baru/koma, bersihkan spasi, dan pastikan panjang nomor valid
            const rawNumbers = quotedText.split(/[\n,]/).map(n => n.trim()).filter(n => n.length > 8);
            
            if (rawNumbers.length === 0) {
                await sock.sendMessage(sender, { text: '❌ Tidak ada nomor valid yang ditemukan di teks yang Anda reply.' }, { quoted: msg });
                return;
            }

            await sock.sendMessage(sender, { text: `⏳ Memulai pengiriman massal ke ${rawNumbers.length} nomor...\n*(Diberi jeda 3 detik antar pesan agar nomor Anda aman/anti-banned)*` }, { quoted: msg });

            let successCount = 0;
            for (let num of rawNumbers) {
                // Bersihkan karakter aneh dan format nomor ke internasional (@s.whatsapp.net)
                let formattedNum = num.replace(/[^0-9]/g, '');
                if (formattedNum.startsWith('0')) {
                    formattedNum = '62' + formattedNum.substring(1); // Otomatis ubah awalan 08 jadi 628
                }
                formattedNum += '@s.whatsapp.net';

                try {
                    await sock.sendMessage(formattedNum, { text: broadcastMessage });
                    successCount++;
                    // Jeda aman 3 detik untuk melindungi dari deteksi spam WhatsApp
                    await new Promise(resolve => setTimeout(resolve, 3000)); 
                } catch (err) {
                    console.log(`Gagal kirim ke ${formattedNum}`);
                }
            }

            await sock.sendMessage(sender, { text: `✅ Selesai! Berhasil mengirim pesan promosi ke ${successCount} nomor.` }, { quoted: msg });
        }
    });
}

// Menjalankan fungsi utama
startBot();
