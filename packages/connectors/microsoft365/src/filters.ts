/**
 * Shared noise filters for M365 connectors.
 * Applied before content hits the LLM — keeps garbage out of the pipeline.
 */

// ── Email filters ─────────────────────────────────────────────────────────────

// Folders to skip entirely — don't even look at messages here
export const SKIP_EMAIL_FOLDERS = new Set([
  'junkemail',
  'deleteditems',
  'recoverableitemsdeletions',
  'recoverableitemsroot',
  'recoverableitemspurges',
  'spam',
  'trash',
  'drafts',
  'outbox',
  'sentitems',   // sent items = outbound mail; handled separately if needed
])

// Sender address patterns that are never real human communication
const SPAM_SENDER_PATTERNS = [
  /^no.?reply@/i,
  /^do.?not.?reply@/i,
  /^noreply@/i,
  /^mailer.?daemon@/i,
  /^postmaster@/i,
  /^bounce[+-]/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^newsletter@/i,
  /^marketing@/i,
  /^info@.*\.(mailchimp|sendgrid|constantcontact|klaviyo|hubspot)\.com$/i,
  /^.*@.*\.(mailchimp|sendgrid|constantcontact|klaviyo|hubspot)\.com$/i,
  /^unsubscribe@/i,
  /^support@.*ticket\./i,
]

// Subject line patterns that are spam/automated
const SPAM_SUBJECT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bweekly digest\b/i,
  /\bdaily digest\b/i,
  /\bmonthly report\b/i,
  /\byou have a new (message|notification)\b/i,
  /\b(promotional|marketing) (email|message)\b/i,
  /\[?automated\]?/i,
  /\b(sale|% off|discount|coupon|promo code)\b/i,
  /\bconfirm your (email|subscription|account)\b/i,
  /\bverification code\b/i,
  /\bone-time (passcode|code|password|pin)\b/i,
  /\byour (receipt|invoice|order) from\b/i,  // transactional receipts (not client invoices)
  /\bpackage (shipped|delivered|tracking)\b/i,
  // Calendar noise
  /\b(accepted|declined|tentative):\s/i,
  /\bcanceled:\s/i,
]

// Body content patterns — if entire body matches, it's noise
const SPAM_BODY_PATTERNS = [
  /to unsubscribe.{0,100}click here/i,
  /you (are receiving|received) this (email|message) because you (subscribed|signed up)/i,
  /this is an? (automated|automatic) (message|email|notification)/i,
  /please do not (reply to|respond to) this (email|message)/i,
]

export interface EmailFilterResult {
  skip:   boolean
  reason: string
}

export function shouldSkipEmail(opts: {
  folder?:      string
  sender?:      string
  subject?:     string
  bodyText?:    string
  isDraft?:     boolean
  categories?:  string[]
}): EmailFilterResult {
  const { folder, sender, subject, bodyText, isDraft, categories } = opts

  // Skip drafts
  if (isDraft) return { skip: true, reason: 'draft' }

  // Skip certain folders
  if (folder && SKIP_EMAIL_FOLDERS.has(folder.toLowerCase().replace(/\s/g, ''))) {
    return { skip: true, reason: `folder:${folder}` }
  }

  // Skip spam sender patterns
  if (sender) {
    for (const pattern of SPAM_SENDER_PATTERNS) {
      if (pattern.test(sender)) return { skip: true, reason: `spam_sender:${pattern.source}` }
    }
  }

  // Skip spam subject patterns
  if (subject) {
    for (const pattern of SPAM_SUBJECT_PATTERNS) {
      if (pattern.test(subject)) return { skip: true, reason: `spam_subject:${pattern.source}` }
    }
  }

  // Skip spam body patterns
  if (bodyText) {
    for (const pattern of SPAM_BODY_PATTERNS) {
      if (pattern.test(bodyText)) return { skip: true, reason: `spam_body:${pattern.source}` }
    }

    // Skip if body is too short to be meaningful
    const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length
    if (wordCount < 5) return { skip: true, reason: 'too_short' }
  }

  // Skip if user-categorized as junk/spam
  if (categories?.some(c => /junk|spam|trash|marketing|newsletter|promotional/i.test(c))) {
    return { skip: true, reason: 'user_category' }
  }

  return { skip: false, reason: '' }
}

// ── Teams / Chat filters ──────────────────────────────────────────────────────

const BOT_SENDER_PATTERNS = [
  /bot$/i,
  /\[bot\]/i,
  /webhook/i,
  /^jira$/i,
  /^github$/i,
  /^azure devops$/i,
  /^teams app$/i,
]

// Message content patterns that are pure noise in chat
const CHAT_NOISE_PATTERNS = [
  /^(ok|okay|thanks|thank you|thx|ty|👍|✅|🙏|sure|got it|sounds good|will do|lgtm|noted)\.?$/i,
  /^(yes|no|yep|nope|yup|nah)\.?$/i,
  /^\+1$/,
  /^ack\.?$/i,
]

export function shouldSkipChatMessage(opts: {
  sender?:      string
  content?:     string
  messageType?: string
  isBot?:       boolean
}): boolean {
  const { sender, content, messageType, isBot } = opts

  // Skip non-message types (system events, card updates, etc.)
  if (messageType && messageType !== 'message') return true

  // Skip bot messages
  if (isBot) return true
  if (sender && BOT_SENDER_PATTERNS.some(p => p.test(sender))) return true

  // Skip pure reaction / acknowledgement messages
  if (content && CHAT_NOISE_PATTERNS.some(p => p.test(content.trim()))) return true

  // Skip empty content
  if (!content?.trim()) return true

  return false
}

// ── Thread-level filter ───────────────────────────────────────────────────────

// Skip threads where ALL messages are bots or noise
export function shouldSkipThread(opts: {
  messages:  Array<{ sender?: string; content?: string; isBot?: boolean }>
  minWords?: number
}): boolean {
  const { messages, minWords = 20 } = opts

  // All messages filtered out
  const meaningful = messages.filter(m => !shouldSkipChatMessage({
    sender:  m.sender,
    content: m.content,
    isBot:   m.isBot,
  }))
  if (meaningful.length === 0) return true

  // Not enough content
  const totalWords = meaningful.reduce((sum, m) =>
    sum + (m.content?.trim().split(/\s+/).filter(Boolean).length ?? 0), 0)
  if (totalWords < minWords) return true

  return false
}
