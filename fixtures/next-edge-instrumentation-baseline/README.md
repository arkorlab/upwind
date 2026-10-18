# Edge error-dispatch baseline

The matrix copies `next-edge-instrumentation` without changing its application, project hook or
Next.js configuration. Its adapter configures only Node host instrumentation, leaving Edge host
composition disabled. An actual compiled Edge route must await its project registration, return
HTTP 500 for a thrown GET, and invoke neither error hook. This independently checks the upstream
Next.js 16.4.2 behavior used by the opt-in fixture's Edge route contract.
