const LLM_URL = process.env.LLM_URL ?? 'http://10.10.100.80:30891/v1'
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3.5-35b-a3b'

const SYSTEM_PROMPT = `Summarize this Obsidian note in 3-5 sentences. Focus on what an AI assistant would need to know to answer questions about this topic. Be specific — include names, URLs, hostnames, and key facts. Do not include formatting, headers, or bullet points. Write as a single paragraph.`

export async function summarizeNote(content: string, path: string): Promise<string> {
  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Note path: ${path}\n\n${content}` },
        ],
        temperature: 0.2,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    const summary = data.choices[0]?.message?.content?.trim()
    if (!summary) throw new Error('Empty LLM response')
    return summary
  } catch (err) {
    console.warn(`[obsidian-sync] LLM summarization failed for ${path}: ${err} — using preview`)
    // Fallback: use first 300 chars, strip markdown
    return content.slice(0, 300).replace(/[#*`\[\]]/g, '').trim()
  }
}
