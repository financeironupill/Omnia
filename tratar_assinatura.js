const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');

async function processarAssinatura() {
    try {
        const arquivoEntrada = 'WhatsApp Image 2026-11-04 at 13.42.13.jpeg';
        const pastaDestino = path.join(__dirname, 'public', 'img');
        const arquivoSaida = path.join(pastaDestino, 'assinatura.png');

        if (!fs.existsSync(pastaDestino)) {
            fs.mkdirSync(pastaDestino, { recursive: true });
        }

        const imagem = await Jimp.read(arquivoEntrada);
        
        imagem.scan(0, 0, imagem.bitmap.width, imagem.bitmap.height, function (x, y, idx) {
            const red = this.bitmap.data[idx + 0];
            const green = this.bitmap.data[idx + 1];
            const blue = this.bitmap.data[idx + 2];

            // Tolerância maior (140): se o tom for claro ou acinzentado, torna transparente
            if (red > 140 && green > 140 && blue > 140) {
                this.bitmap.data[idx + 3] = 0; // Transparente
            }
        });

        await imagem.write(arquivoSaida);
        console.log('Sucesso! Assinatura limpa e transparente salva em:', arquivoSaida);
    } catch (erro) {
        console.error('Erro ao processar assinatura:', erro);
    }
}

processarAssinatura();