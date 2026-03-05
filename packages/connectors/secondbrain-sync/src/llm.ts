const LLM_URL = process.env.LLM_URL ?? 'http://10.10.100.80:30891/v1'
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3.5-35b-a3b'

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export async function synthesizeWithLLM(
  systemPrompt: string,
  userPrompt: string,
  fallback: string,
): Promise<string> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]

    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages,
        max_tokens: 512,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      console.warn(`[secondbrain-sync] LLM returned ${res.status}, using fallback`)
      return fallback
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>
    }

    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) {
      console.warn('[secondbrain-sync] LLM returned empty content, using fallback')
      return fallback
    }

    // Strip thinking blocks if present
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || fallback
  } catch (err) {
    console.warn(`[secondbrain-sync] LLM unreachable: ${err}, using fallback`)
    return fallback
  }
}
