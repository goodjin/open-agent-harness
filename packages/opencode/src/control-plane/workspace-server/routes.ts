import { GlobalBus } from "../../bus/global"
import { Event, EventGateway } from "../../server/event"
import { WorkspaceContext } from "../workspace-context"
import { Instance } from "../../project/instance"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

export function WorkspaceServerRoutes() {
  return new Hono().get("/event", async (c) => {
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")
    return streamSSE(c, async (stream) => {
      const send = async (event: EventGateway.Envelope) => {
        await stream.writeSSE({
          id: event.sequence.toString(),
          data: JSON.stringify(event),
        })
      }
      const handler = async (event: EventGateway.Envelope) => {
        await send(event)
      }
      GlobalBus.on("event", handler)
      await send(
        EventGateway.record(
          {
            directory: Instance.directory,
            workspaceID: WorkspaceContext.workspaceID,
            payload: {
              type: Event.Connected.type,
              properties: {},
            },
          },
          { store: false },
        ),
      )
      const heartbeat = setInterval(() => {
        void send(
          EventGateway.record(
            {
              directory: Instance.directory,
              workspaceID: WorkspaceContext.workspaceID,
              payload: {
                type: Event.Heartbeat.type,
                properties: {},
              },
            },
            { store: false },
          ),
        )
      }, 10_000)

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat)
          GlobalBus.off("event", handler)
          resolve()
        })
      })
    })
  })
}
