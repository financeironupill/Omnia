from PIL import Image

def remover_fundo_assinatura(caminho_entrada, caminho_saida):
    try:
        # Abre a imagem da assinatura
        img = Image.open(caminho_entrada).convert("RGBA")
        datas = img.getdata()

        nova_data = []
        for item in datas:
            # Se o pixel for muito claro (próximo de branco/cinza do papel), torna-o transparente
            # Ajuste o limiar (ex: 190) se necessário para capturar o fundo claro
            if item[0] > 190 and item[1] > 190 and item[2] > 190:
                nova_data.append((255, 255, 255, 0))  # Totalmente transparente
            else:
                # Mantém o traço escuro da caneta original
                nova_data.append(item)

        img.putdata(nova_data)
        img.save(caminho_saida, "PNG")
        print(f"Sucesso! Assinatura tratada salva em: {caminho_saida}")
    except Exception as e:
        print(f"Erro ao processar a imagem: {e}")

# Nomes exatos baseados nas suas imagens
foto_assinatura = "WhatsApp Image 2026-11-04 at 13.42.13.jpeg"
destino_assinatura = "public/img/assinatura.png"

# Executa a conversão
remover_fundo_assinatura(foto_assinatura, destino_assinatura)