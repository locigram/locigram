export { createDb } from './client'
export * from './schema'
export { getCursor, setCursor } from './cursors'
export type { DB } from './client'

export const LOCIGRAM_CATEGORIES = [
  'decision',     // "we decided to use X", "approved Y"
  'preference',   // "I prefer X", "always do Y", "from now on"
  'fact',         // "X costs $Y", "their IP is Z", factual statements
  'lesson',       // "we learned that", "next time we should", "mistake was"
  'entity',       // "X is a person/org/product" — pure entity knowledge
  'observation',  // default — general notes, events, conversations
] as const
export type LocigramCategory = typeof LOCIGRAM_CATEGORIES[number]
