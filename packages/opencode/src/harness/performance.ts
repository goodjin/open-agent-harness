import { Harness } from "./schema"
import { HarnessStore } from "./store"

type Counts = {
  events: number
  tasks: number
  artifacts: number
  assignments: number
  acceptance: number
}

export const PerformancePolicy = {
  events: 500,
  tasks: 100,
  artifacts: 50,
  assignments: 10,
  acceptance: 20,
} as const

export type PerformanceStatus = "healthy" | "degraded" | "blocked"

export type PerformanceReport = {
  run_id: string
  status: PerformanceStatus
  counts: Counts
  pressure: string[]
  recommendations: string[]
}

export async function report(runID: string): Promise<PerformanceReport> {
  const sum = await HarnessStore.summary(runID)
  if (!sum) {
    throw new Error(`Run not found: ${runID}`)
  }

  const counts: Counts = {
    events: sum.events.length,
    tasks: sum.tasks.length,
    artifacts: sum.artifacts.length,
    assignments: sum.assignments.length,
    acceptance: sum.tasks.flatMap((task) => task.gates).length,
  }
  const pressure = [] as string[]
  const recommendations = [] as string[]
  if (counts.events > PerformancePolicy.events) {
    pressure.push("events")
    recommendations.push("Use event pagination and summary projection reads")
  }
  if (counts.tasks > PerformancePolicy.tasks) {
    pressure.push("tasks")
    recommendations.push("Render task list with virtualized UI path")
  }
  if (counts.artifacts > PerformancePolicy.artifacts) {
    pressure.push("artifacts")
    recommendations.push("Collapse artifact list by summary and load details on demand")
  }
  if (counts.assignments > PerformancePolicy.assignments) {
    pressure.push("assignments")
    recommendations.push("Use light assignment snapshot query")
  }
  if (counts.acceptance > PerformancePolicy.acceptance) {
    pressure.push("acceptance")
    recommendations.push("Summarize historical acceptance outcomes")
  }

  let status: PerformanceStatus = "healthy"
  if (pressure.length > 0) {
    status = pressure.length > 3 ? "blocked" : "degraded"
  }

  return {
    run_id: Harness.Run.parse(sum.run).id,
    status,
    counts,
    pressure,
    recommendations,
  }
}
