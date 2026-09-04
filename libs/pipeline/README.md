# Pipeline Library

`buildMessagePipeline()` — one shared way to wire agents onto a `MessageProcessor`, so
`apps/chatbots`, `libs/evals`'s pipeline-snapshot runner, and `apps/cli` don't each hand-assemble
agents independently. Callers select exactly the pipeline stages they need (`admin`, `router`,
`filter`, `imageLinker`, `scribe`, `registrar`, `historian`, `facilitatorNudge`); construction
validates that the providers/models/message sender a requested stage needs are actually present.
