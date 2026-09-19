# Feature: Construtor Modular de Lineup em 3 Janelas (20s)

> **Status:** ✅ Implementado e em Produção (2026-09-19)  
> **Arquitetura:** Multi-Canal (Jetix, Disney Channel, Cartoon Network), Modular, Dinâmico com a Grade de Programação (EPG/Diretor), 100% Determinístico em FFmpeg e Serverless (R2 + D1).

---

## 1. Visão Geral

O **Construtor Modular de Lineup** é o motor responsável por gerar vinhetas e chamadas dinâmicas de programação no formato clássico de TV a cabo dos anos 2000:
- **Duração Estrita de 20.0 segundos** (dois blocos de 10s padrão Biel TV, sem preenchimento de tela preta ao final).
- **Três Janelas / Telas Simultâneas**: exibem trechos das próximas atrações da emissora em movimento (*"Você está assistindo {Série 1}, a seguir {Série 2}, e mais tarde {Série 3}"*).
- **Trilha Sonora Oficial da Emissora**: iniciada no segundo 10 e atenuada sob a locução com mixagem sidechain balanceada.
- **Narradores Oficiais por Canal**: timbres selecionados com dicção jovem, alta empolgação e sotaque neutro/paulistano da capital.

---

## 2. Estrutura de Arquivos e Isolamento por Canal

Cada canal possui sua configuração declarativa e identidade visual/sonora isolada em `assets/comerciais/<canal>/`:

```text
assets/comerciais/
├── templates-lineup.json                # Banco de variações de frases por canal e tipo de bloco
├── jetix/
│   ├── lineup.config.json               # Configuração gráfica, fonte branca grossa, voz Will e trilha
│   └── moldes/
│       ├── image-comercial-jtx-2.png    # Molde 3 janelas com ângulo 3D
│       └── trilha_jetix_lineup_3janelas.m4a
├── disney_channel/
│   ├── lineup.config.json               # Badges neon ciano, voz Camilla e trilha Asfalto Quente
│   └── moldes/
│       ├── image-comercial-disney-3janelas.png
│       └── trilha_disney_lineup_3janelas.m4a
└── cartoon_network/
    ├── lineup.config.json               # Badges horizontais, voz Larissa B. e trilha clássica CN
    └── moldes/
        └── image-comercial-cartoon-3telas.png

packages/pipeline/src/
└── construtor-lineup.mjs                # Motor FFmpeg multi-janela e gerador de overlays

scripts/
├── monta-lineup-cli.mjs                 # CLI para renderização rápida sob demanda
└── gera-vozes-catalogo.mjs              # Gerador em lote de nomes/conectivos no ElevenLabs com upload R2/D1
```

---

## 3. Identidade dos Canais e Narradores Oficiais

| Canal | Narrador | Voice ID (ElevenLabs) | Hiperparâmetros | Estilo Visual dos Rótulos |
|---|---|---|---|---|
| **Jetix** | Will | `NNbmtunmMPGBeyrKu6KD` | Multilingual v2 · stab 0.25 · style 0.70 | **Texto branco puro, extra grosso** (`Ubuntu-B` reforçado) com contorno e sombra nítida, sem caixa/badge, alinhado às facetas 3D. |
| **Disney Channel** | Camilla | `YklVF5l1Q8os8glyd5SM` | Multilingual v2 · stab 0.25 · style 0.65 | **Badges luminosos em neon azul/ciano** com cantos arredondados (`roundrectangle`). |
| **Cartoon Network** | Larissa B. | `YfD2qVn2wwK9QFehYxSa` | Multilingual v2 · stab 0.26 · style 0.65 | **Badges horizontais compactos** sobre o topo de cada quadro. |

---

## 4. Integração com a Grade (EPG / Diretor)

Em produção, o comercial de lineup **não é gravado com nomes fixos manuais**. Ele é alimentado diretamente pelos dados do agendador:

$$\text{[Gancho]} \rightarrow \text{[Você tá assistindo \{série\_1\}]} \rightarrow \text{[A seguir \{série\_2\}]} \rightarrow \text{[Mais tarde \{série\_3\}]} \rightarrow \text{[Assinatura]}$$

1. **Amostras de Vídeo**: Puxadas das séries correspondentes cadastradas no catálogo (`comerciais_16x9/` ou amostras de episódios).
2. **Áudios de Voz**:
   - Os nomes de todas as séries do catálogo já estão sintetizados com os narradores oficiais e salvos permanentemente no Cloudflare R2 (`fabrica/tts/<voz_id>/<hash>.mp3`) e indexados no D1 (`voice_clips`).
   - Os conectivos e ganchos modulares permitem variações dinâmicas sem repetição monótona no ar.

---

## 5. Como Sincronizar e Executar em Outro Computador

Para continuar o trabalho ou rodar o gerador a partir de outro computador:

### Passo 1: Atualizar o Repositório
```bash
git pull origin main
pnpm install
```

### Passo 2: Carregar as Credenciais
Certifique-se de que o `.envrc` do projeto está ativo (ou carregue o ambiente local):
```bash
direnv allow
# ou
source .envrc
```

### Passo 3: Testar a Renderização Modular via CLI
Para renderizar um lineup teste de 20s para qualquer canal:
```bash
# Jetix
node scripts/monta-lineup-cli.mjs --canal jetix --out scratch/teste-jetix.mp4

# Disney Channel
node scripts/monta-lineup-cli.mjs --canal disney_channel --out scratch/teste-disney.mp4

# Cartoon Network
node scripts/monta-lineup-cli.mjs --canal cartoon_network --out scratch/teste-cartoon.mp4
```

### Passo 4: Cadastrar ou Gerar Vozes para Novas Séries
Quando uma nova série entrar no catálogo da emissora:
1. Adicione a série em `scripts/gera-vozes-catalogo.mjs`.
2. Execute o gerador:
   ```bash
   node scripts/gera-vozes-catalogo.mjs
   ```
3. O script possui **cache determinístico**: ele verifica o R2 antes de chamar a API, gerando **apenas os arquivos inéditos** e economizando sua cota da ElevenLabs. Em seguida, sincroniza automaticamente com o D1 remoto e local.
