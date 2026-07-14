export function persistFollowup<T extends { id: string }>(input: {
  item: T
  append(item: T): void
  send(id: string): void
}) {
  input.append(input.item)
  input.send(input.item.id)
}
