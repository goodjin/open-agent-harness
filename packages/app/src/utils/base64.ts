import { base64Decode, base64Encode } from "@open-agent-harness/util/encode"

export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    const decoded = base64Decode(value)
    if (base64Encode(decoded) !== value) return
    return decoded
  } catch {
    return
  }
}
