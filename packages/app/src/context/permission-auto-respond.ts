import { base64Encode } from "@open-agent-harness/util/encode"
import { createEffect, type Accessor } from "solid-js"
import type { PermissionRequest, Session } from "@open-agent-harness/sdk/v2/client"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  const directoryKey = directory ? directoryAcceptKey(directory) : undefined
  return autoAccept[key] ?? autoAccept[sessionID] ?? (directoryKey ? autoAccept[directoryKey] : undefined)
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string, fallback = false) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? fallback
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
  fallback = false,
) {
  const value = sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
  return value ?? fallback
}

export function drainAutoRespond(input: {
  autoAccept: Record<string, boolean>
  directory: string | undefined
  fallback: boolean
  permissions: Record<string, readonly PermissionRequest[] | undefined>
  respond: (permission: PermissionRequest, directory: string) => void
  sessions: Session[]
}) {
  if (!input.directory) return
  const list = input.sessions.flatMap((item) => input.permissions[item.id] ?? [])
  for (const item of list) {
    if (!autoRespondsPermission(input.autoAccept, input.sessions, item, input.directory, input.fallback)) continue
    input.respond(item, input.directory)
  }
}

export function createAutoRespondDrain(input: {
  autoAccept: Accessor<Record<string, boolean>>
  directory: Accessor<string | undefined>
  fallback: Accessor<boolean>
  permissions: Accessor<Record<string, readonly PermissionRequest[] | undefined>>
  respond: (permission: PermissionRequest, directory: string) => void
  sessions: Accessor<Session[]>
}) {
  createEffect(() => {
    drainAutoRespond({
      autoAccept: input.autoAccept(),
      directory: input.directory(),
      fallback: input.fallback(),
      permissions: input.permissions(),
      respond: input.respond,
      sessions: input.sessions(),
    })
  })
}
