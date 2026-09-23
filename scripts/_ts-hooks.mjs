// Hooks de resolução pros verify-* que importam o código do app direto.
// O Node ≥22 LÊ .ts (type stripping), mas não adivinha a extensão num import
// relativo sem extensão — e é esse o estilo do código-fonte ("./fabrica"),
// porque em produção quem resolve é o esbuild do wrangler. Estes hooks tapam
// exatamente esse buraco: "./x" → "./x.ts" quando o arquivo existe.
// Uso: node --import ./scripts/_ts-registra.mjs scripts/verify-algo.mjs
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(especificador, contexto, proximo) {
  if (especificador.startsWith('.') && !/\.[cm]?[jt]s$/.test(especificador) && contexto.parentURL) {
    const alvo = new URL(especificador + '.ts', contexto.parentURL)
    if (existsSync(fileURLToPath(alvo))) return { url: alvo.href, shortCircuit: true }
  }
  return proximo(especificador, contexto)
}
