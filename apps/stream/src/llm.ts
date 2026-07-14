// Helper LLM genérico: pede um JSON estruturado ao Gemini e cai pro DeepSeek
// em cota/erro — mesma cadeia do chat do Diretor, mas com schema arbitrário
// (o diretor.ts mantém as próprias funções especializadas; isto aqui serve
// aos usos menores, como a extração de promessas dos comerciais).

type Env = {
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
}

/**
 * Igual ao `pedeJson`, mas com IMAGEM junto — e **só Gemini, sem fallback**.
 *
 * Decisão do Gabriel (2026-07-14): o `deepseek-v4-flash` provavelmente não
 * aceita imagem, e de todo jeito o Gemini já é o primário da cadeia. Então o
 * portão visual do cortador (docs/features/cortador-comerciais.md) roda só
 * aqui. Sem Gemini de pé, quem chama **descarta o candidato** em vez de
 * aprovar: sem revisor humano, a única falha aceitável é a que aprova menos.
 *
 * @param imagens JPEGs em base64 (sem o prefixo `data:`).
 */
export async function pedeJsonComImagem(
  env: Env,
  system: string,
  user: string,
  imagens: string[],
  geminiSchema: unknown,
): Promise<{ json: any; provedor: string } | null> {
  if (!env.GEMINI_API_KEY) return null
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{
            role: 'user',
            parts: [
              { text: user },
              ...imagens.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } })),
            ],
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: geminiSchema,
            temperature: 0.1, // veredito, não redação: o mais determinístico possível
          },
        }),
      },
    )
    if (!res.ok) return null
    const data = await res.json<any>()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (text) return { json: JSON.parse(text), provedor: 'gemini-3.5-flash' }
  } catch {
    /* sem provedor visual — quem chama descarta */
  }
  return null
}

export async function pedeJson(
  env: Env,
  system: string,
  user: string,
  geminiSchema: unknown,
): Promise<{ json: any; provedor: string } | null> {
  if (env.GEMINI_API_KEY) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // timeout: um LLM travado NUNCA pode pendurar quem chamou (ex.: a
          // classificação de playlist roda síncrona no request da fábrica)
          signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: geminiSchema,
              temperature: 0.2,
            },
          }),
        },
      )
      if (res.ok) {
        const data = await res.json<any>()
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) return { json: JSON.parse(text), provedor: 'gemini-3.5-flash' }
      }
    } catch {
      /* cai pro DeepSeek */
    }
  }
  if (env.DEEPSEEK_API_KEY) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })
      if (res.ok) {
        const data = await res.json<any>()
        return { json: JSON.parse(data.choices[0].message.content), provedor: 'deepseek-v4-flash' }
      }
    } catch {
      /* sem provedor disponível */
    }
  }
  return null
}
