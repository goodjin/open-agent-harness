import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("app boots project session without vite transform overlay", async ({ page, gotoSession, sdk }) => {
  const errors: string[] = []

  page.on("pageerror", (err) => {
    errors.push(err.message)
  })
  page.on("console", (msg) => {
    if (!/vite:esbuild|Transform failed|Internal server error/i.test(msg.text())) return
    errors.push(msg.text())
  })
  await page.route("**/session/*/task/update/confirm*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ proposal_id: "run_e2e:update_e2e", action: "confirm" }),
    }),
  )

  const sessions = await sdk.session.list()
  const session = sessions.data?.find((item) => item.title === "E2E Session")
  expect(session).toBeDefined()
  await gotoSession(session!.id)

  await expect(page.getByText("[plugin:vite:esbuild]")).toHaveCount(0)
  await expect(page.getByText("Transform failed")).toHaveCount(0)
  await expect(page.locator(promptSelector)).toBeVisible()
  const proposal = page.locator('[data-component="session-task-proposal"]')
  await expect(proposal).toContainText("Task update proposal")
  await proposal.getByRole("button", { name: "Confirm" }).click()
  await expect(proposal).toContainText("Revising")
  expect(errors).toEqual([])
})
