## ADDED Requirements

### Requirement: Repo Root Is Not A Vercel App Root

The repository root MUST be treated only as the pnpm workspace root and MUST NOT be configured as a Vercel Next.js application root.

#### Scenario: Root does not trigger Next.js detection

- **WHEN** deploying the web application
- **THEN** Vercel uses `apps/web` as the Root Directory and detects Next.js from `apps/web/package.json`
- **AND** deployment does not depend on root `package.json` containing `next`

### Requirement: Web And API Are Independent Vercel Projects

`apps/web` and `apps/api` MUST be deployed as independent Vercel projects with independent Root Directory settings.

#### Scenario: API project serves health publicly

- **WHEN** the API preview deployment is Ready
- **THEN** `GET https://<api-host>/health` returns 200 from the Hono app

#### Scenario: Web project proxies API to hosted Hono

- **WHEN** the web preview deployment is Ready
- **THEN** its `API_PROXY_TARGET` points to the hosted API URL
- **AND** web `/api/health` reaches hosted API rather than `localhost:8787`

### Requirement: Hono Has A Vercel Entry

`apps/api` MUST provide a Vercel Hono zero-config entry that default exports the Hono app while preserving the local Node dev entry.

#### Scenario: Same app runs locally and on Vercel

- **WHEN** running local dev
- **THEN** `apps/api/src/index.ts` starts the Hono app through `@hono/node-server`
- **WHEN** running on Vercel
- **THEN** `src/server.ts` imports the same Hono app, default exports it, and handles all routes

### Requirement: Hosted API Is Required For Sandbox Callback

Any workflow that requires Vercel Sandbox callbacks MUST use a public hosted API base URL.

#### Scenario: Sandbox does not call localhost

- **WHEN** Control Plane starts a sandbox runtime for a run
- **THEN** the runtime config contains hosted `ingestUrl`, `llmProxyUrl`, and `controlUrl`
- **AND** none of those URLs point to `localhost`

### Requirement: Manual Confirmation Before Resource Creation

Creating the API Vercel project, binding custom domains, or migrating environment variables MUST require explicit user confirmation.

#### Scenario: Domain not yet confirmed

- **WHEN** API project name or domain choice is not confirmed
- **THEN** implementation may prepare code/config
- **BUT** MUST NOT create the project, bind domains, or migrate secrets
