/**
 * Rules parser for agent rules.md files.
 * Extracts behavioral constraints as markdown string for LLM consumption.
 */

/**
 * Parsed rules content with structured sections for programmatic access.
 */
export interface RulesContent {
  /** Raw markdown content for LLM consumption */
  markdown: string
  /** General behavior rules */
  general: string[]
  /** Code modification rules */
  codeModification: string[]
  /** Permission handling rules */
  permission: string[]
  /** Error handling rules */
  errorHandling: string[]
  /** Session management rules */
  sessionManagement: string[]
}

/**
 * Parse rules.md content.
 * Extracts constraint sections while preserving markdown for LLM consumption.
 */
export function parseRules(content: string): RulesContent {
  // If content is empty, return empty structure
  if (!content.trim()) {
    return {
      markdown: content,
      general: [],
      codeModification: [],
      permission: [],
      errorHandling: [],
      sessionManagement: [],
    }
  }

  // Extract general behavior rules
  const generalMatch = content.match(/## General Behavior\n+([\s\S]*?)(?=\n## |$)/i)
  const general: string[] = []
  if (generalMatch) {
    const generalContent = generalMatch[1]
    const itemMatches = generalContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      general.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  // Extract code modification rules
  const codeMatch = content.match(/## Code Modification Rules\n+([\s\S]*?)(?=\n## |$)/i)
  const codeModification: string[] = []
  if (codeMatch) {
    const codeContent = codeMatch[1]
    const itemMatches = codeContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      codeModification.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  // Extract permission handling rules
  const permMatch = content.match(/## Permission Handling\n+([\s\S]*?)(?=\n## |$)/i)
  const permission: string[] = []
  if (permMatch) {
    const permContent = permMatch[1]
    const itemMatches = permContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      permission.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  // Extract error handling rules
  const errorMatch = content.match(/## Error Handling\n+([\s\S]*?)(?=\n## |$)/i)
  const errorHandling: string[] = []
  if (errorMatch) {
    const errorContent = errorMatch[1]
    const itemMatches = errorContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      errorHandling.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  // Extract session management rules
  const sessionMatch = content.match(/## Session Management\n+([\s\S]*?)(?=\n## |$)/i)
  const sessionManagement: string[] = []
  if (sessionMatch) {
    const sessionContent = sessionMatch[1]
    const itemMatches = sessionContent.matchAll(/\d+\.\s+\*\*([^*]+)\*\*:\s*([^\n]+)/g)
    for (const match of itemMatches) {
      sessionManagement.push(`${match[1].trim()}: ${match[2].trim()}`)
    }
  }

  return {
    markdown: content,
    general,
    codeModification,
    permission,
    errorHandling,
    sessionManagement,
  }
}
