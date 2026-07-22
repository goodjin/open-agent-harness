// Keep this as the short final-turn reminder. Planner protocol and footer prompts own role-specific rules and examples.
export namespace TaskAdmission {
  export const Prompt = [
    "Task admission:",
    "- Ordinary conversation does not create or modify a Task when it produces no executable action.",
    "- Before preparing executable actions, read and follow Current Session Task.",
    "- Before a Task exists, exploration may use only read, glob, grep, webfetch, websearch, lsp, todoread, or agent_query.",
    "- Exploration does not create a Task. Do not use bash, agent delegation, write tools, or persistent-state tools before Task confirmation.",
    '- When no Task exists and this is the session\'s first execution task, use assignment={"op":"create","target":"self"}.',
    "- When the first Task and its execution graph are already clear, put the create/self confirm item and the complete executable graph in the same package. Runtime persists the Task and workflow before dispatching any executable item.",
    "- When the request stays within the same Task boundary, continue the current Revision without creating a second Task or assignment.",
    '- When the same Task changes content, scope, acceptance, or workflow boundary, propose assignment={"op":"update","target":"self"} for user confirmation.',
    '- When the request is a new Task, propose assignment={"op":"handoff","target":"peer"} for user confirmation; the source package does not execute the new Task.',
  ].join("\n")
}
