/**
 * Identity parser for agent identity.md files.
 * Extracts role definition content as markdown string for LLM consumption.
 */

/**
 * Parsed identity content with structured sections for programmatic access.
 */
export interface IdentityContent {
  /** Raw markdown content for LLM consumption */
  markdown: string
  /** Role definition section content */
  role: string
  /** Core responsibilities section content */
  responsibilities: string[]
  /** Communication style section content */
  communication: string[]
  /** Expertise areas section content */
  expertise: string[]
}

/**
 * Parse identity.md content.
 * Extracts sections while preserving markdown for LLM consumption.
 */
export function parseIdentity(content: string): IdentityContent {
  // If content is empty, return empty structure
  if (!content.trim()) {
    return {
      markdown: content,
      role: "",
      responsibilities: [],
      communication: [],
      expertise: [],
    }
  }

  // Extract role definition (from ## Role Definition or first paragraph after # Identity)
  const roleMatch = content.match(/## Role Definition\n+([\s\S]*?)(?=\n## |$)/i)
  const role = roleMatch ? roleMatch[1].trim() : ""

  // Extract core responsibilities (numbered list items under ## Core Responsibilities)
  const respMatch = content.match(/## Core Responsibilities\n+([\s\S]*?)(?=\n## |$)/i)
  const responsibilities: string[] = []
  if (respMatch) {
    const respContent = respMatch[1]
    // Match numbered items like "1. **Code Assistance**: ..."
    const itemMatches = respContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      responsibilities.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  // Extract communication style
  const commMatch = content.match(/## Communication Style\n+([\s\S]*?)(?=\n## |$)/i)
  const communication: string[] = []
  if (commMatch) {
    const commContent = commMatch[1]
    // Match bullet points "- Be clear..."
    const bulletMatches = commContent.matchAll(/-\s+([^\n]+)/g)
    for (const match of bulletMatches) {
      communication.push(match[1].trim())
    }
  }

  // Extract expertise areas
  const expertMatch = content.match(/## Expertise Areas\n+([\s\S]*?)(?=\n## |$)/i)
  const expertise: string[] = []
  if (expertMatch) {
    const expertContent = expertMatch[1]
    // Match bullet points "- Full-stack..."
    const bulletMatches = expertContent.matchAll(/-\s+([^\n]+)/g)
    for (const match of bulletMatches) {
      expertise.push(match[1].trim())
    }
  }

  return {
    markdown: content,
    role,
    responsibilities,
    communication,
    expertise,
  }
}
