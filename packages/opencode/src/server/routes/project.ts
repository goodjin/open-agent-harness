import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import z from "zod"
import { ProjectID } from "../../project/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { InstanceBootstrap } from "../../project/bootstrap"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { ForbiddenError, NotFoundError } from "../../storage/db"
import { File } from "../../file"
import { SessionStatus } from "../../session/status"

const Create = z
  .object({
    id: SessionID.zod.optional(),
    parentID: SessionID.zod.optional(),
    title: z.string().optional(),
    permission: Session.Info.shape.permission,
    directory: z.string().optional(),
  })
  .optional()

function scope(id: ProjectID) {
  const project = Project.get(id)
  if (!project) throw new NotFoundError({ message: `Project not found: ${id}` })
  if (project.id !== Instance.project.id) {
    throw new ForbiddenError({ message: `Project ${id} is not the current instance project` })
  }
  return project
}

async function bound(id: SessionID) {
  const session = await Session.get(id)
  if (session.directory !== Instance.directory) {
    throw new ForbiddenError({ message: `Session ${id} does not belong to the current directory` })
  }
  return session
}

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = await Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/init",
      describeRoute({
        summary: "Initialize project",
        description: "Mark the current project as initialized and return the project for this instance.",
        operationId: "project.init",
        responses: {
          200: {
            description: "Initialized project",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        Project.setInitialized(Instance.project.id)
        return c.json(Project.get(Instance.project.id) ?? Instance.project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await Project.initGit({
          directory: dir,
          project: prev,
        })
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await Instance.reload({
          directory: dir,
          worktree: dir,
          project: next,
          init: InstanceBootstrap,
        })
        return c.json(next)
      },
    )
    .get(
      "/:projectID/session",
      describeRoute({
        summary: "List project sessions",
        description: "List sessions that belong to the current project directory.",
        operationId: "project.session.list",
        responses: {
          200: {
            description: "Project sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Deprecated: filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions" }),
          start: z.coerce.number().optional().meta({ description: "Filter sessions updated on or after this time" }),
          search: z.string().optional().meta({ description: "Filter sessions by title" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        scope(c.req.valid("param").projectID)
        const query = c.req.valid("query")
        if (query.directory && query.directory !== Instance.directory) {
          throw new ForbiddenError({ message: `Session directory must match the current instance directory` })
        }
        const sessions = [...Session.list({
          directory: Instance.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })]
        return c.json(sessions)
      },
    )
    .post(
      "/:projectID/session",
      describeRoute({
        summary: "Create project session",
        description: "Create a session in the current project directory.",
        operationId: "project.session.create",
        responses: {
          200: {
            description: "Created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Create),
      async (c) => {
        scope(c.req.valid("param").projectID)
        const body = c.req.valid("json") ?? {}
        if (body.directory && body.directory !== Instance.directory) {
          throw new ForbiddenError({ message: `Session directory must match the current instance directory` })
        }
        const session = await Session.createNext({
          id: body.id,
          parentID: body.parentID,
          title: body.title,
          permission: body.permission,
          directory: Instance.directory,
        })
        return c.json(session)
      },
    )
    .get(
      "/:projectID/session/:sessionID",
      describeRoute({
        summary: "Get project session",
        description: "Retrieve a session that belongs to the current project directory.",
        operationId: "project.session.get",
        responses: {
          200: {
            description: "Project session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod, sessionID: SessionID.zod })),
      async (c) => {
        const params = c.req.valid("param")
        scope(params.projectID)
        return c.json(await bound(params.sessionID))
      },
    )
    .get(
      "/:projectID/session/:sessionID/status",
      describeRoute({
        summary: "Get project session status",
        description: "Retrieve process-local status for a project-scoped session.",
        operationId: "project.session.status",
        responses: {
          200: {
            description: "Project session status",
            content: {
              "application/json": {
                schema: resolver(SessionStatus.Info),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod, sessionID: SessionID.zod })),
      async (c) => {
        const params = c.req.valid("param")
        scope(params.projectID)
        await bound(params.sessionID)
        return c.json(SessionStatus.get(params.sessionID))
      },
    )
    .get(
      "/:projectID/session/:sessionID/find/file",
      describeRoute({
        summary: "Find project session files",
        description: "Search files in the current project directory bound to a project session.",
        operationId: "project.session.findFiles",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod, sessionID: SessionID.zod })),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const query = c.req.valid("query")
        scope(params.projectID)
        await bound(params.sessionID)
        return c.json(
          await File.search({
            query: query.query,
            limit: query.limit ?? 10,
            dirs: query.dirs !== "false",
            type: query.type,
          }),
        )
      },
    )
    .get(
      "/:projectID/session/:sessionID/file",
      describeRoute({
        summary: "Read project session file",
        description: "Read a file from the current project directory bound to a project session.",
        operationId: "project.session.file",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod, sessionID: SessionID.zod })),
      validator("query", z.object({ path: z.string() })),
      async (c) => {
        const params = c.req.valid("param")
        scope(params.projectID)
        await bound(params.sessionID)
        return c.json(await File.read(c.req.valid("query").path))
      },
    )
    .get(
      "/:projectID/session/:sessionID/file/status",
      describeRoute({
        summary: "Get project session file status",
        description: "Get git file status from the current project directory bound to a project session.",
        operationId: "project.session.fileStatus",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod, sessionID: SessionID.zod })),
      async (c) => {
        const params = c.req.valid("param")
        scope(params.projectID)
        await bound(params.sessionID)
        return c.json(await File.status())
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.update.schema.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await Project.update({ ...body, projectID })
        return c.json(project)
      },
    ),
)
