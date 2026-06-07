const shown = (value: unknown) => {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export function genericToolText(input: {
  input?: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
}) {
  return [
    input.input && Object.keys(input.input).length > 0 ? `input\n${shown(input.input)}` : undefined,
    input.output ? `output\n${input.output}` : undefined,
    input.metadata && Object.keys(input.metadata).length > 0 ? `metadata\n${shown(input.metadata)}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n\n")
}
