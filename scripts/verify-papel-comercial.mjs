// Teste da regra de PAPEL das peças de intervalo (apps/stream/src/papel-comercial.ts)
// com ids reais do acervo de 24/09/2026. Node ≥ 22 lê o .ts direto.
//   node --import ./scripts/_ts-registra.mjs scripts/verify-papel-comercial.mjs
import { anunciaDe, papelDe } from '../apps/stream/src/papel-comercial.ts'

let pass = 0
let fail = 0
const check = (nome, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? `  (${extra})` : ''}`) }

const SERIES_CN = ['billy_e_mandy', 'scooby_doo', 'tom_e_jerry', 'looney_tunes', 'looney_tunes_show', 'capitao_lento', 'pokemon', 'jovens_titas']
const casos = [
  // [id, series_id do metadata, promessa, papel esperado, série anunciada esperada]
  ['com_disney_2009_intervalo_1_02_nintendo_dsi', null, null, 'anuncio', null],
  ['com_lote_inicial_10_chamyto', null, null, 'anuncio', null],
  ['com_lote_inicial_06_cartoon_network_celular', null, null, 'casa', null],
  ['com_cn_colecao_externo_danoninho_ice_pokemon', null, null, 'anuncio', 'pokemon'],
  ['com_cn_colecao_licenciado_cn_produtos_meninas_superpoderosas', null, null, 'anuncio', null],
  ['com_cn_colecao_referencia_cn_chamada_billy_e_mandy', null, null, 'casa', 'billy_e_mandy'],
  ['com_cn_invasao_referencia_cn_entrada_intervalo_volta_ja_invasao_01', null, null, 'entrada', null],
  ['com_cn_invasao_referencia_cn_retorno_intervalo_voltou_invasao_03', null, null, 'retorno', null],
  ['com_cartoon_network_o_movimento_jerry', null, null, 'casa', null],
  ['com_jetix_brasil_trailer', null, null, 'casa', null],
  ['com_conheca_o_ranger_azul_16x9', null, null, 'casa', null],
  ['com_comercial_disney_channel_200', null, null, 'casa', null],
  ['com_twix_caramelo_anos_2000_16x9', null, null, 'anuncio', null],
  ['com_ev_billy_e_mandy_10c181a7', null, { tipo: 'evento', series_id: 'billy_e_mandy' }, 'casa', 'billy_e_mandy'],
  ['com_scooby_doo_07h30_af15', 'scooby_doo', { tipo: 'bloco_horario', series_id: 'scooby_doo', hora: '07:30' }, 'casa', 'scooby_doo'],
  ['com_capitao_lento_choradeira_no_2', null, null, 'casa', 'capitao_lento'],
  ['com_looney_tunes_show_06h30_68be', null, null, 'casa', 'looney_tunes_show'],
]
for (const [id, series_id, promessa, papel, anuncia] of casos) {
  const an = anunciaDe({ id, series_id }, promessa, SERIES_CN)
  const pp = papelDe({ id, series_id }, promessa, an)
  check(`${id} → ${papel}${anuncia ? ` (${anuncia})` : ''}`, pp === papel && an === anuncia, `${pp}${an ? ` (${an})` : ''}`)
}
// override do metadata vence a regra
check('metadata.papel sobrescreve a regra', papelDe({ id: 'com_disney_2009_x', papel: 'casa' }) === 'casa')
check('metadata.papel inválido é ignorado', papelDe({ id: 'com_disney_2009_x', papel: 'lixo' }) === 'anuncio')
check('metadata.anuncia sobrescreve o id', anunciaDe({ id: 'com_x_scooby_doo', anuncia: 'tom_e_jerry' }, null, SERIES_CN) === 'tom_e_jerry')

console.log(`\n${fail === 0 ? '🎉' : '⚠️'} ${pass}/${pass + fail} checagens passaram`)
process.exit(fail === 0 ? 0 : 1)
