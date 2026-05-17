## project

The goal is to let a single instance of OpenCode run sessions for multiple projects and different worktrees per project.

### identity boundaries

- Project identity is `ProjectID`. Git worktrees and separate clones with the same root commit share the same project id.
- Workspace identity is the resolved working directory. `process.cwd()` is the default workspace for local clients, and a request may switch workspace by passing a different `directory`.
- `WorkspaceID` is legacy metadata only. Stored sessions may still carry `workspace_id` for compatibility, but it is not a user-facing runtime selector and is not a permission or session access boundary.
- Worktree identity is its canonical directory. Worktrees are not interchangeable with `ProjectID`; separate worktrees under the same project id remain isolated by directory.

### current implementation gaps

| Area | Current state | Follow-up |
|---|---|---|
| Project routes | `GET /project`, `POST /project/init`, and project-scoped session list/get/create exist for the current instance project. | Extend the same project scope to all remaining session mutation/message routes. |
| Directory scope | Session create/fork/get/list are bound to `Instance.directory`; same-directory access does not require `workspaceID`, and cross-directory access is forbidden. | Keep legacy `workspace_id` fields readable without using them as guards. |
| Directory query compatibility | `?directory=` and `x-opencode-directory` select the active directory for HTTP clients. | Prefer directory selection over any `workspace` query/header. |
| File routes | Project session file find/read/status routes assert the session belongs to the current directory before touching files. | Add project-scoped parity for text search, symbol search, and file listing if clients need them. |

### api

```
GET /project -> Project[]

POST /project/init -> Project


GET /project/:projectID/session -> Session[]

GET /project/:projectID/session/:sessionID -> Session

POST /project/:projectID/session -> Session
{
  id?: string
  parentID?: string
  directory: string
}

DELETE /project/:projectID/session/:sessionID

POST /project/:projectID/session/:sessionID/init

POST /project/:projectID/session/:sessionID/abort

POST /project/:projectID/session/:sessionID/share

DELETE /project/:projectID/session/:sessionID/share

POST /project/:projectID/session/:sessionID/compact

GET /project/:projectID/session/:sessionID/message -> { info: Message, parts: Part[] }[]

GET /project/:projectID/session/:sessionID/message/:messageID -> { info: Message, parts: Part[] }

POST /project/:projectID/session/:sessionID/message -> { info: Message, parts: Part[] }

POST /project/:projectID/session/:sessionID/revert -> Session

POST /project/:projectID/session/:sessionID/unrevert -> Session

POST /project/:projectID/session/:sessionID/permission/:permissionID -> Session

GET /project/:projectID/session/:sessionID/find/file -> string[]

GET /project/:projectID/session/:sessionID/file -> { type: "raw" | "patch", content: string }

GET /project/:projectID/session/:sessionID/file/status -> File[]

POST /log

// These are awkward

GET /provider?directory=<resolve path> -> Provider
GET /config?directory=<resolve path> -> Config // think only tui uses this?

GET /project/:projectID/agent?directory=<resolve path> -> Agent
GET /project/:projectID/find/file?directory=<resolve path> -> File

```
