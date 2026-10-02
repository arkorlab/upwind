# `fixtures/next-workflow`

An application that uses the Workflow SDK (`workflow`, 5.x): a workflow with steps and a sleep,
started from a route handler, and `withWorkflow` around an otherwise empty configuration.

What it is here to show: that the SDK's flow route comes out of the application's Function and into
one of its own (`functions.workflow`, with `workflow.route` naming it), and that the
`workflow-quickjs-wasm` patch reaches the chunk the SDK's QuickJS engine embeds its WebAssembly in —
in that Function and in no other, since nothing else of the application runs a workflow.

The build needs no World: the adapter warns that the host named none (`workflowWorldModule`), which
is what a build without a host's World is told, and the bundle is what it would otherwise be.

The `next` version in `package.json` is not a declaration of anything. `tools/next-matrix`
overwrites it for every build it runs; it is there so that an `npm install` in this directory,
for looking at something by hand, gets a version that works. `workflow` is pinned to the release
the adapter's patch was read against.
