// Texto da locução dos lineups de três janelas, compartilhado pelo lote local
// (scripts/lineup-lote.mjs) e pela fábrica (scripts/factory-local.mjs, jobs
// `lineup_sequencia` do reconciliador). Um lugar só: a mesma sequência precisa
// sair com a MESMA frase nos dois caminhos, porque a locução fica em cache pela
// frase e o media_id é derivado da sequência.
import { createHash } from 'node:crypto'

/** Versão do formato de texto + motor. Entra no media_id: mudar gera peças novas. */
export const VERSAO_LINEUP = 'lote-local-2026-09-23-v1'

/** media_id da peça de uma sequência. O Worker calcula igual (lineup-reconcilia.ts). */
export function idLineup(canal, seq, versao = VERSAO_LINEUP) {
  return `com_lineup_${createHash('sha1').update(`${canal}|${seq.join('>')}|${versao}`).digest('hex').slice(0, 12)}`
}

// Nome como a voz deve DIZER (grafia pensada pro TTS: "Witch", "Kid versus
// Kat", "Senhor"). Veio dos voice_clips 'nome' de cada canal, com ajustes.
export const NOMES = {
  a_vida_e_aventuras_de_juniper_lee: 'Juniper Lee', as_meninas_superpoderosas: 'As Meninas Superpoderosas',
  billy_e_mandy: 'As Terríveis Aventuras de Billy e Mandy', clube_das_winx: 'O Clube das Winx',
  coragem_o_cao_covarde: 'Coragem, o Cão Covarde', corrida_maluca: 'A Corrida Maluca', flintstones: 'Os Flintstones',
  jackie_chan: 'As Aventuras de Jackie Chan', jovens_titas: 'Os Jovens Titãs', knd: 'A Turma do Bairro',
  laboratorio_de_dexter: 'O Laboratório de Dexter', liga_da_justica_sem_limites: 'Liga da Justiça Sem Limites',
  looney_tunes: 'Looney Tunes', looney_tunes_show: 'O Show dos Looney Tunes', manda_chuva: 'Manda-Chuva',
  martin_mystery: 'Martin Mystery', megas_xlr: 'Megas XLR', scooby_doo: 'Scooby-Doo', super_choque: 'Super Choque',
  tom_e_jerry: 'Tom e Jerry', pokemon: 'Pokémon',
  as_visoes_da_raven: 'As Visões da Raven', brandy_e_sr_bigodes: 'Brandy e Senhor Bigodes',
  cory_na_casa_branca: 'Cory na Casa Branca', danny_phantom: 'Danny Phantom', familia_dinossauros: 'Família Dinossauros',
  jacke_long_o_dragao_ocidental: 'Jake Long, o Dragão Ocidental', os_feiticeiros_de_waverly_place: 'Os Feiticeiros de Waverly Place',
  padrinhos_magicos: 'Os Padrinhos Mágicos', phineas_e_ferb: 'Phineas e Ferb', timao_e_pumba: 'Timão e Pumba',
  yin_yang_yo: 'Yin Yang Yo', o_maravilhoso_mundo_de_disney: 'O Maravilhoso Mundo de Disney',
  kid_vs_kat: 'Kid versus Kat', power_rangers_forca_animal: 'Power Rangers Força Animal', power_rangers_rpm: 'Power Rangers RPM',
  power_rangers_furia_da_selva: 'Power Rangers Fúria da Selva', power_rangers_spd: 'Power Rangers S.P.D.',
  power_rangers_ultravelocidade: 'Power Rangers Operação Ultravelocidade', pucca: 'Pucca',
  super_esquadrao_dos_macacos: 'Super Esquadrão dos Macacos', tres_espias_demais: 'Três Espiãs Demais', witch: 'Witch',
  zatch_bell: 'Zatch Bell',
}

// Uma frase curta por série (Jetix e Disney; o Cartoon aprovado não tem).
// As marcadas "aprovada" vieram das peças que o Gabriel aprovou em 22–23/09.
export const COMENTARIOS = {
  pucca: 'Determinada e divertida, ela não desiste nunca', // aprovada
  padrinhos_magicos: 'Desejos malucos e muita confusão', // aprovada (exemplo)
  power_rangers_forca_animal: 'Heróis selvagens em ação', // aprovada
  tres_espias_demais: 'Ação e estilo em cada missão',
  witch: 'Cinco guardiãs com o poder dos elementos', // aprovada (exemplo)
  kid_vs_kat: 'Um garoto contra um gato alienígena',
  martin_mystery: 'Mistérios sobrenaturais pra resolver',
  power_rangers_rpm: 'Velocidade máxima contra as máquinas',
  power_rangers_furia_da_selva: 'O poder das feras despertou',
  power_rangers_spd: 'A patrulha do futuro em ação',
  power_rangers_ultravelocidade: 'Uma corrida contra o tempo',
  super_esquadrao_dos_macacos: 'Macacos robôs salvando o universo',
  yin_yang_yo: 'Coelhos ninjas e muito kung fu',
  zatch_bell: 'A batalha dos mamodos começou',
  os_feiticeiros_de_waverly_place: 'Magia, aventura e muita confusão', // aprovada
  as_visoes_da_raven: 'O futuro nunca foi tão divertido', // aprovada
  brandy_e_sr_bigodes: 'Essa dupla vai aprontar de novo', // aprovada
  danny_phantom: 'Meio garoto, meio fantasma, cem por cento herói', // aprovada (exemplo)
  cory_na_casa_branca: 'Confusão no endereço mais famoso do país', // aprovada (exemplo)
  familia_dinossauros: 'A família mais pré-histórica da TV',
  jacke_long_o_dragao_ocidental: 'Um dragão protegendo a cidade',
  phineas_e_ferb: 'Cada dia de férias, uma nova invenção',
  timao_e_pumba: 'Hakuna Matata e muita aventura',
  o_maravilhoso_mundo_de_disney: 'O filme de domingo',
}

export const nomeFalado = (s) => NOMES[s] ?? s.replaceAll('_', ' ')

/**
 * Texto da locução por canal, em níveis: se a voz passa do teto, desce um
 * nível (menos comentário) em vez de deixar o motor cortar a fala. Formatos =
 * os das peças aprovadas (transcritas em 23/09). Nível 0 é o completo.
 */
export function textoLineup(canal, [X, Y, Z], nivel = 0) {
  const n = nomeFalado
  // Z = X (a série volta depois de Y): o comentário dela já foi dito no começo
  const c = (s, pos) => (pos === 'Z' && s === X ? undefined : COMENTARIOS[s])
  if (canal === 'cartoon_network') {
    return `Você está assistindo ${n(X)}. Logo depois vem ${n(Y)}. E fica super ligado que mais tarde tem ${n(Z)}. Tudo isso só no Cartoon Network.`
  }
  if (canal === 'disney_channel') {
    const cx = nivel <= 1 && c(X) ? ` ${c(X)}.` : ''
    const cy = nivel === 0 && c(Y) ? ` ${c(Y)}.` : ''
    const cz = nivel <= 1 && c(Z, 'Z') ? ` ${c(Z, 'Z')}.` : ''
    return `Você está assistindo ${n(X)}.${cx} Depois, ${n(Y)}.${cy} Mais tarde, ${n(Z)}.${cz} Tudo isso no Disney Channel.`
  }
  // Jetix: sem "Jetix" na fala (a assinatura já está no fechamento). Só 3 tags
  // v3: o /voz/preview corta em 300 caracteres e as 12 aprovadas ocupam 190.
  const cx = nivel <= 1 && c(X) ? ` ${c(X)}!` : ''
  const cz = nivel === 0 && c(Z, 'Z') ? ` ${c(Z, 'Z')}!` : ''
  return `[excited] [confident announcer] [fast pace] Você está assistindo ${n(X)}!${cx} A seguir, ${n(Y)}! E depois, ${n(Z)}!${cz}`
}

/** Texto sem as tags de direção do v3 (é o que vai pro transcript da promessa). */
export const semTags = (t) => t.replace(/^(\[[^\]]+\]\s*)+/, '')

/** Janela útil da voz = do delay do canal até antes do fechamento/assinatura. */
export const TETO_VOZ = { jetix: 16.2, disney_channel: 17.6, cartoon_network: 17.5 }
/** Duração do render por canal (o Disney tem 19 s; o master de entrega completa 20). */
export const DUR_ALVO = { jetix: 20, disney_channel: 19, cartoon_network: 20 }

const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/** A palavra mais característica do nome foi OUVIDA? Tolera a grafia do transcritor ("Haven" por "Raven"). */
export function ouviuNome(serie, ouvido) {
  const ws = semAcento(ouvido).split(/[^a-z0-9]+/).filter(Boolean)
  // palavra de ligação não identifica a série (e o transcritor escreve "vs")
  const genericas = new Set(['versus', 'aventuras', 'terriveis'])
  const chave = semAcento(nomeFalado(serie)).split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !genericas.has(w)).sort((a, b) => b.length - a.length)[0]
  if (!chave) return true
  return ws.some((w) => w === chave || lev(w, chave) <= Math.max(1, Math.floor(chave.length / 4)))
}
