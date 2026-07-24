// Keep this as the short final-turn reminder. Planner protocol and footer prompts own role-specific rules and examples.
export namespace TaskAdmission {
  export const Prompt = [
    "Task admission:",
    "- You own semantic routing. Declare create/self, update/self, handoff/peer, or an ordinary executable graph from your understanding of the request; Runtime executes that declaration and does not reclassify it.",
    "- Ordinary conversation does not create or modify a Task when it produces no executable action.",
    "- Before preparing executable actions, read and follow Current Session Task.",
    "- Before a Task exists, exploration may use only read, glob, grep, webfetch, websearch, lsp, todoread, or agent_query.",
    "- Exploration does not create a Task. Do not use bash, agent delegation, write tools, or persistent-state tools before Task confirmation.",
    '- When no Task exists and this is the session\'s first execution task, use assignment={"op":"create","target":"self"}.',
    "- A create/self or update/self package ends at Task confirmation. Runtime ignores executable siblings, persists an empty workflow, and asks you to generate the execution graph in a fresh turn after confirmation.",
    "- When the request stays within the same Task boundary, continue the current Revision without creating a second Task or assignment.",
    "- Every newly declared executable action graph creates a new Run in the selected Task Revision. A previous Run result is immutable history and never prevents a later valid graph from running.",
    '- When the same Task changes content, scope, acceptance, or workflow boundary, propose assignment={"op":"update","target":"self"} for user confirmation.',
    '- When the request is a new Task, propose assignment={"op":"handoff","target":"peer"} for user confirmation; the source package does not execute the new Task.',
  ].join("\n")
}
