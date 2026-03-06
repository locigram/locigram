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

const SYSTEM_PROMPT = `You are evaluating Obsidian notes to decide if they should be indexed in a personal AI memory system (Locigram) for an MSP business owner and developer.

For each note, respond with a JSON array where each item has:
- "path": the note path (return exactly as given)
- "verdict": "index", "skip", or "covered"
- "locus": "notes/decisions", "notes/infrastructure", "notes/observations", "notes/people", or "notes/lessons"
- "reason": one sentence explaining the verdict

ALWAYS INDEX (verdict: "index"):
- Infrastructure/ — server configs, cluster docs, network maps, service registries, API docs
- Brain/ — memory architecture, write policies, ingestion policies, vault structure
- Decisions/ — architecture logs, blueprints, decision records
- Business/Clients/ — individual client profiles (NOT Client-Users/)
- Business/Suru Solutions.md, Business/MSP/, Business/Vendors — business context
- Locigram/ — Locigram system architecture and design docs
- Agents/ — agent README files and configuration docs
- Projects/ — ONLY if: filename is 2-5 clean words (e.g. SuruOS.md, Discarr.md, Project-Brain.md)

ALWAYS SKIP (verdict: "skip"):
- Projects/ with long run-together filenames (sentences, fragments) — these are agent session artifacts
- Research/Soul-Collection/ — internal soul/persona docs
- _PROJECT-TEMPLATE.md, ThinkingProcess.md — templates/meta
- Home.md — vault index page
- Any note under 100 bytes

Be strict. Most Projects/ notes are junk. Infrastructure/, Brain/, Decisions/ are almost always worth indexing.`

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
    console.warn(`[obsidian-audit] LLM batch eval failed: ${err} — preserving existing verdicts`)
    return [] // return empty — caller preserves existing index entries
  }
}
