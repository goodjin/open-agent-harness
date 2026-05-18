const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const ports = [
  {
    value: 4096,
    stale: (line: string) => line.includes("src/index.ts serve"),
  },
  {
    value: 3001,
    stale: (line: string) => line.includes(root),
  },
]

async function text(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) return err.trim()
  return out.trim()
}

async function pids(port: number) {
  const out = await text(["lsof", `-tiTCP:${port}`, "-sTCP:LISTEN"])
  return out
    .split("\n")
    .map((pid) => pid.trim())
    .filter(Boolean)
}

async function cmd(pid: string) {
  return await text(["ps", "-p", pid, "-o", "command="])
}

async function cleanup() {
  for (const port of ports) {
    for (const pid of await pids(port.value)) {
      const line = await cmd(pid)
      if (!port.stale(line)) continue
      console.log(`[dev:web] stopping stale process on ${port.value}: ${pid}`)
      Bun.spawn(["kill", pid])
    }
  }
  await Bun.sleep(300)
}

function start(name: string, cwd: string, args: string[]) {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })

  const pump = async (stream: ReadableStream<Uint8Array>, error = false) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const lines = decoder.decode(next.value).split("\n")
      for (const line of lines) {
        if (!line) continue
        console[error ? "error" : "log"](`[${name}] ${line}`)
      }
    }
  }

  void pump(proc.stdout)
  void pump(proc.stderr, true)
  return proc
}

await cleanup()

const server = start("server", `${root}/packages/opencode`, [
  "bun",
  "--watch",
  "--conditions=browser",
  "src/index.ts",
  "serve",
  "--port",
  "4096",
  "--hostname",
  "127.0.0.1",
  "--cors",
  "http://127.0.0.1:3001",
])

const app = start("web", `${root}/packages/app`, ["bun", "dev", "--host", "127.0.0.1", "--port", "3001", "--strictPort"])

const stop = () => {
  server.kill()
  app.kill()
}

process.on("SIGINT", () => {
  stop()
  process.exit(130)
})

process.on("SIGTERM", () => {
  stop()
  process.exit(143)
})

await Promise.race([server.exited, app.exited])
stop()
