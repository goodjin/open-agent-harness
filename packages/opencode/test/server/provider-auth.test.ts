import { describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"

describe("provider auth routes", () => {
  test("unsupported oauth authorize fails clearly", async () => {
    const res = await Server.Default().request("/provider/test/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": process.cwd(),
      },
      body: JSON.stringify({ method: 0 }),
    })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.name).toBe("ProviderAuthOauthMissing")
    expect(body.data.providerID).toBe("test")
  })
})
