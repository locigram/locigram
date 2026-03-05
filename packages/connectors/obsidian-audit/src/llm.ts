const LLM_URL = process.env.LLM_URL ?? 'http://10.10.100.80:30891/v1'
const LLM_MODEL = process.env.LLM_MODEL ?? 'qwen3.5-35b-a3b'

const LOCUS_HINTS: Record<string, string> = {
  'Decisions/': 'notes/decisions',
  'Infrastructure/': 'notes/infrastructure',
  'Brain/': 'notes/observations',
  'Business/': 'notes/observations',
  'Projects/': 'notes/observations',
  'Research/': 'notes/observations',
  'People/': 'notes/people',
}

function guessLocus(path: string): string {
  for (const [prefix, locus] of Object.entries(LOCUS_HINTS)) {
    if (path.startsWith(prefix)) return locus
  }
  return 'notes/observations'
}

export interface EvalResult {
  path: string
  verdict: 'index' | 'skip' | 'covered'
  locus: string
  reason: string
}

interface NoteInput {
  path: string
  preview: string
}

const SYSTEM_PROMPT = `You are evaluating Obsidian notes to decide if they should be indexed in a personal AI memory system (Locigram).

For each note, respond with a JSON array where each item has:
- "path": the note path (return exactly as given)
- "verdict": "index" if this note contains durable knowledge worth retrieving in future AI sessions, "skip" if it's an agent build log/one-off artifact/empty stub/junk filename, "covered" if this type of info is clearly already in the memory system
- "locus": the appropriate storage path ("notes/decisions", "notes/infrastructure", "notes/observations", "notes/people", "notes/lessons")
- "reason": one sentence explaining the verdict

Index: architecture decisions, infrastructure docs, business context, project status, research findings, client info, key processes.
Skip: agent session artifacts, build logs, one-off scripts, template pages, notes with run-together filename words, duplicate content.`

export async function evaluateBatch(
  notes: NoteInput[],
  coverageContext: string,
): Promise<EvalResult[]> {
  const userContent = [
    coverageContext ? `Locigram already covers:\n${coverageContext.slice(0, 800)}\n\n` : '',
    'Evaluate these notes:\n',
    notes.map(n => `PATH: ${n.path}\nCONTENT PREVIEW:\n${n.preview}\n---`).join('\n'),
  ].join('')

  try {
    const res = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`)
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    const text = data.choices[0]?.message?.content ?? ''

    // Extract JSON array from response
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array in LLM response')
    const parsed = JSON.parse(match[0]) as EvalResult[]
    return parsed
  } catch (err) {
    console.warn(`[obsidian-audit] LLM batch eval failed: ${err} — defaulting all to skip`)
    return notes.map(n => ({
      path: n.path,
      verdict: 'skip' as const,
      locus: guessLocus(n.path),
      reason: 'LLM unavailable — defaulting to skip',
    }))
  }
}
