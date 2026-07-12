// Helper LLM genérico: pede um JSON estruturado ao Gemini e cai pro DeepSeek
// em cota/erro — mesma cadeia do chat do Diretor, mas com schema arbitrário
// (o diretor.ts mantém as próprias funções especializadas; isto aqui serve
// aos usos menores, como a extração de promessas dos comerciais).

type Env = {
  GEMINI_API_KEY?: string
  DEEPSEEK_API_KEY?: string
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
