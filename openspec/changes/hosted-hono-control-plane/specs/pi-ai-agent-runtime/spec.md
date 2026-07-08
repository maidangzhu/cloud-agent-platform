## ADDED Requirements

### Requirement: Pi AI Runtime Is The Product Runtime

The product sandbox execution path MUST run the real Pi AI runtime from `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. The self-written project loop MAY remain only as a deterministic fixture or migration aid.

#### Scenario: Product run starts Pi AI

- **WHEN** a user creates a run in production mode
- **THEN** Control Plane starts Pi AI runtime inside the Vercel Sandbox
- **AND** does not start the self-written loop as the product runner

### Requirement: Pi AI Runtime Uses Control Plane Adapters

Pi AI runtime MUST access platform capabilities through scoped Control Plane adapters, not through direct database, Redis, auth, or long-lived provider credentials.

#### Scenario: Runtime writes facts through ingest

- **WHEN** Pi AI runtime emits events, tool calls, files, artifacts, sources, or terminal state
- **THEN** it sends them through hosted ingest APIs using a scoped run token

#### Scenario: Runtime calls model through proxy

- **WHEN** Pi AI runtime needs an LLM response
- **THEN** it calls the hosted LLM proxy
- **AND** the sandbox environment does not contain long-lived provider keys

### Requirement: Pi AI Runtime Supports Deterministic Verification

The Pi AI integration MUST provide a deterministic mode or fixture path that allows workflow/live tests to assert protocol behavior without relying on nondeterministic model output.

#### Scenario: Deterministic Pi AI workflow completes

- **WHEN** workflow tests run against hosted API and real Vercel Sandbox
- **THEN** Pi AI runtime can complete a deterministic run that creates events, files, artifacts, and terminal state
