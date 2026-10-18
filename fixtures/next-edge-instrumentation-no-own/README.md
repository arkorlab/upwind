# Host instrumentation without a project hook

The matrix copies `next-edge-instrumentation` and removes its `instrumentation.js` before the
Next.js build. Everything else, including its host adapter, is the same source. This is a separate
compiled case, not a runtime flag that merely makes an existing project hook do nothing.
