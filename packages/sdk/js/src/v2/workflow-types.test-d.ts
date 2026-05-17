import type { WorkflowAbortData, WorkflowResumeData, WorkflowRunData, WorkflowStatusData } from "./gen/types.gen.js"
import type { OpencodeClient } from "./gen/sdk.gen.js"

declare const client: OpencodeClient

const run: WorkflowRunData = {
  url: "/workflow/run",
  body: {
    sessionID: "ses_test",
    workflowID: "test",
  },
}

const resume: WorkflowResumeData = {
  url: "/workflow/resume",
  body: {
    sessionID: "ses_test",
  },
}

const status: WorkflowStatusData = {
  url: "/workflow/{sessionID}/status",
  path: {
    sessionID: "ses_test",
  },
}

const abort: WorkflowAbortData = {
  url: "/workflow/{sessionID}/abort",
  path: {
    sessionID: "ses_test",
  },
}

void run
void resume
void status
void abort

// @ts-expect-error workflow run requires a JSON body
const badrun: WorkflowRunData = { url: "/workflow/run" }

// @ts-expect-error workflow resume requires a JSON body
const badresume: WorkflowResumeData = { url: "/workflow/resume" }

// @ts-expect-error workflow run requires flat body parameters
client.workflow.run()

// @ts-expect-error workflow run requires sessionID
client.workflow.run({ workflowID: "test" })

// @ts-expect-error workflow resume requires flat body parameters
client.workflow.resume()

// @ts-expect-error workflow resume requires sessionID
client.workflow.resume({})

// @ts-expect-error workflow status requires path parameters
const badstatus: WorkflowStatusData = { url: "/workflow/{sessionID}/status" }

// @ts-expect-error workflow abort requires path parameters
const badabort: WorkflowAbortData = { url: "/workflow/{sessionID}/abort" }

void badrun
void badresume
void badstatus
void badabort
