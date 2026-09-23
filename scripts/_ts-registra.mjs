// Registra os hooks de ./_ts-hooks.mjs (precisa ser um arquivo à parte: o Node
// carrega o módulo de hooks numa thread própria).
import { register } from 'node:module'
register('./_ts-hooks.mjs', import.meta.url)
