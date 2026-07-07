# Frontend Vercel Chatbot Replication Plan

## Scope

Target branch: `v2/research-workspace-agent`.

This plan rebuilds `apps/web` so the frontend systematically follows
`<reference-root>/vercel-chatbot` for visual language,
component decomposition, interaction behavior, responsive shell, and light/dark
theme behavior, while keeping Research Workspace Agent data flow on `apps/api`.

Do not port Vercel Chatbot backend behavior, Auth.js business logic, AI SDK
browser state, or mock data that looks real.

Repository docs and committed code must not include personal names, private
workspace paths, or complete local system paths. Use placeholders such as
`<reference-root>/vercel-chatbot`, `<repo-root>`, or relative paths.

## Reference Audit

### App Foundation

| Reference | Purpose | Migration strategy |
| --- | --- | --- |
| `package.json` | Defines the frontend dependency set: Radix umbrella package, `next-themes`, `class-variance-authority`, `cmdk`, `sonner`, `swr`, `usehooks-ts`, `framer-motion`, `motion`, `use-stick-to-bottom`, `streamdown` stack. | Add only the dependencies needed by the current step. Do not add `@ai-sdk/react`/`ai` as state plumbing. Add markdown/artifact dependencies in the artifact/message steps. |
| `components.json` | shadcn-style aliases and Tailwind v4 CSS location, `style: radix-maia`. | Add matching `apps/web/components.json` aliases so copied primitives keep `@/components`, `@/lib`, `@/hooks`. |
| `app/globals.css` | Tailwind v4 import, `@custom-variant dark`, neutral OKLCH tokens, sidebar tokens, shadow tokens, animation utilities, scrollbars. | Replace current temporary token file with the reference token system. Omit `katex`/`streamdown` imports until markdown/artifact steps install those packages. |
| `app/layout.tsx` | Geist fonts, `ThemeProvider`, global `TooltipProvider`, `theme-color` synchronization script. | Port provider structure with Research metadata. Do not include `SessionProvider`. |
| `components/theme-provider.tsx` | Thin wrapper around `next-themes`. | Copy directly into `apps/web/components/theme-provider.tsx`. |
| `app/(chat)/layout.tsx` | Composes `SidebarProvider`, `AppSidebar`, `SidebarInset`, `Toaster`, and `ChatShell`. | Use as target shell architecture for Step B/C, adapted to Research names and no Auth.js. |
| `app/(chat)/page.tsx` | Empty page because shell owns the route. | Keep `apps/web/app/page.tsx` thin; shell composition moves into components. |

### UI Primitives

| Reference | Purpose | Migration strategy |
| --- | --- | --- |
| `components/ui/button.tsx` | `cva` variants, Radix `Slot`, compact sizes, `data-slot`, active translate. | Copy/adapt in Step A. |
| `components/ui/sheet.tsx` | Dialog-backed side/bottom sheet with reference animation classes. | Copy/adapt in Step A; used by sidebar mobile and artifact mobile later. |
| `components/ui/dialog.tsx` | Modal overlay/content with rounded 4xl surface and close button. | Copy/adapt in Step A. |
| `components/ui/tooltip.tsx` | Radix tooltip with zero delay, arrow, rounded dark foreground bubble. | Copy/adapt in Step A and provide globally in root layout. |
| `components/ui/dropdown-menu.tsx` | Compact popover menu, submenus, checkbox/radio items, destructive variant. | Copy/adapt in Step A for user nav, sidebar item menus, theme menu. |
| `components/ui/command.tsx` | `cmdk` wrapper using `InputGroup`. | Copy/adapt in Step A because slash/model command UI depends on it. |
| `components/ui/input-group.tsx` | Rounded group container used by command and prompt input. | Copy/adapt in Step A, including `Input` and `Textarea` dependencies. |
| `components/ui/sidebar.tsx` | Sidebar provider, desktop collapse, rail hitbox, mobile bottom sheet, menu system. | Migrate in Step B, unchanged visually, with Research labels. |

Additional primitive dependencies read from the reference and needed by the
listed files: `input.tsx`, `textarea.tsx`, `separator.tsx`, `skeleton.tsx`,
`collapsible.tsx`, `badge.tsx`, `button-group.tsx`, `select.tsx`,
`hover-card.tsx`, `spinner.tsx`.

### AI Elements

| Reference | Purpose | Migration strategy |
| --- | --- | --- |
| `ai-elements/prompt-input.tsx` | Self-managed/provider prompt composer, attachments, paste/drop, Enter submit, command/select/hover-card bridges. | Step C: adapt as `Composer` foundation. Keep visual and keyboard behavior; disable unavailable file/model features explicitly until real API exists. |
| `ai-elements/message.tsx` | Message layout, actions, branch controls, Streamdown markdown rendering. | Step D: port message primitives. Add `streamdown` stack only when rendering run content/reason chunks. |
| `ai-elements/tool.tsx` | Collapsible tool block with status badge, input/output renderers. | Step D: map AgentRun tool events to these states. Tool/event payloads are complete objects, not token streams. |
| `ai-elements/reasoning.tsx` | Collapsible reasoning with streaming auto-open and delayed auto-close. | Step D: map Redis reason chunks into this visual pattern. |
| `ai-elements/conversation.tsx` | Stick-to-bottom conversation wrapper, scroll-to-bottom button, markdown download helper. | Step C/D: use for conversation scroll behavior if it fits our snapshot/SSE model; otherwise keep current custom hook but match visuals. |

### Chat Business Components

| Reference | Purpose | Research component |
| --- | --- | --- |
| `components/chat/shell.tsx` | Two-pane conversation/artifact layout; composer sticky bottom; artifact width split. | `ResearchShell` |
| `components/chat/app-sidebar.tsx` | Sidebar header logo/trigger, new chat, delete all, footer user nav. | `ResearchSidebar` |
| `components/chat/sidebar-history.tsx` | Loading, unauthorized, empty, date-grouped history list, infinite sentinel. | `WorkspaceThreadNav` |
| `components/chat/sidebar-history-item.tsx` | Active thread row, dashed active underline, hover action menu. | `WorkspaceThreadNavItem` |
| `components/chat/sidebar-user-nav.tsx` | User footer, generated avatar, theme toggle dropdown. | `ResearchUserNav` |
| `components/chat/chat-header.tsx` | Top bar, mobile sidebar trigger, compact actions. | `WorkspaceThreadHeader` |
| `components/chat/messages.tsx` | Greeting empty state, scroll container, message list, scroll button. | `ConversationMessages` |
| `components/chat/message.tsx` | User bubble, assistant icon row, reasoning merge, tool/document rendering. | `RunEventMessage`, `ToolCallRenderer`, `ReasoningRenderer` |
| `components/chat/multimodal-input.tsx` | Suggested actions, slash commands, prompt input, stop/send state. | `Composer` |
| `components/chat/slash-commands.tsx` | Command palette over composer. | `ComposerSlashCommands`, adapted to workspace/thread/run actions. |
| `components/chat/suggested-actions.tsx` | First-screen suggestion chips. | Research-specific suggestion chips only if clearly empty-state suggestions, not fake data. |
| `components/chat/message-reasoning.tsx` | Thin wrapper over `Reasoning`. | `RunReasoning` |
| `components/chat/message-actions.tsx` | Copy/edit/vote hover actions. | Copy/edit actions; no vote unless product requires it. |

### Artifact Components

| Reference | Purpose | Research component |
| --- | --- | --- |
| `components/chat/document-preview.tsx` | Inline artifact preview with header, 257px content, fullscreen hitbox, bounding box capture. | `ArtifactPreview` |
| `components/chat/document.tsx` | Tool result/call buttons that open artifact panel. | `ArtifactEventPreview` |
| `components/chat/artifact.tsx` | Desktop right panel, mobile full-screen motion panel, version management, toolbar. | `ArtifactPanel` |
| `components/chat/artifact-actions.tsx` | Vertical icon actions with tooltips. | `ArtifactActions` |
| `components/chat/artifact-close-button.tsx` | Close/reset behavior. | `ArtifactCloseButton` |
| `components/chat/artifact-messages.tsx` | Message list inside artifact mode. | Optional if Research artifact needs embedded run conversation. |
| `components/chat/version-footer.tsx` | Previous/next/diff/latest/restore footer. | `ArtifactVersionFooter` |
| `components/chat/toolbar.tsx` | Floating right-bottom artifact tools with motion. | `ArtifactToolbar` |
| `hooks/use-artifact.ts` | SWR local artifact state and metadata store. | Replace SWR dependency if needed, but preserve state shape: visible, bounding box, title, content, status. |

### Hooks

| Reference | Purpose | Migration strategy |
| --- | --- | --- |
| `hooks/use-mobile.ts` | `matchMedia` under 768px. | Copy in Step B with sidebar. |
| `hooks/use-messages.tsx` | Wraps scroll-to-bottom and tracks submitted message state. | Step C/D, adapted to run status. |
| `hooks/use-scroll-to-bottom.tsx` | Mutation/resize observers, scroll button state, reset on chat change. | Step C, useful for conversation snapshot + stream chunks. |

## Data Flow Contract

Snapshot APIs:

- `GET /api/me`
- `GET /api/workspaces`
- `GET /api/workspaces/:workspaceId/threads`
- `GET /api/threads/:threadId`
- `GET /api/runs/:runId`

Mutations:

- `POST /api/workspaces`
- `POST /api/workspaces/:workspaceId/threads`
- `POST /api/threads/:threadId/runs`
- `POST /api/runs/:runId/cancel`

Realtime:

- `POST /api/runs/:runId/events`（GET remains compatible）
- SSE accelerates display only.
- Refresh must restore from snapshot.
- `reason`/`content` render Redis stream chunks.
- Tool calls and other events render complete event objects, not token streams.

## Dependency Strategy

Step A:

- Runtime: `class-variance-authority`, `radix-ui`, `cmdk`, `next-themes`.
- Dev/style: `tailwindcss-animate`, `@tailwindcss/typography`.

Step B/C:

- Add `sonner`, `usehooks-ts`, `swr` or keep project-standard cache if chosen.

Step D/E:

- Add `framer-motion`/`motion`, `use-stick-to-bottom`, `streamdown`,
  `@streamdown/cjk`, `@streamdown/code`, `@streamdown/math`,
  `@streamdown/mermaid`, `katex`, and any code/artifact renderer dependencies
  only when those components are migrated.

Avoid:

- `@ai-sdk/react` and `ai` as browser state core. If later used for type-only
  compatibility, it must not own Research run state.

## Step Plan

### Step A: Tokens, Theme, Tooltip, Base Primitives

Files:

- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/components.json`
- `apps/web/app/globals.css`
- `apps/web/app/layout.tsx`
- `apps/web/components/theme-provider.tsx`
- `apps/web/components/ui/button.tsx`
- `apps/web/components/ui/dialog.tsx`
- `apps/web/components/ui/sheet.tsx`
- `apps/web/components/ui/tooltip.tsx`
- `apps/web/components/ui/dropdown-menu.tsx`
- `apps/web/components/ui/command.tsx`
- `apps/web/components/ui/input-group.tsx`
- supporting primitives: `input`, `textarea`, `separator`, `skeleton`,
  `collapsible`, `badge`, `button-group`, `select`, `hover-card`, `spinner`.

Acceptance:

- Light/dark/system mode behavior matches reference provider setup.
- Theme color meta follows light/dark class.
- `pnpm --dir apps/web typecheck` passes.
- `pnpm --dir apps/web build` passes.
- Desktop/mobile light/dark screenshots show no global layout regression.

### Step B: Sidebar Primitive + ResearchSidebar

Migrate `components/ui/sidebar.tsx`, `hooks/use-mobile.ts`, and Research
sidebar components. Acceptance: desktop collapse, rail, mobile bottom sheet,
workspace/thread loading/empty/active states match reference interaction.

### Step C: Shell, Header, Conversation, Greeting, Composer

Migrate shell/header/conversation/composer visual system. Acceptance: first
screen resembles reference chat experience, composer is sticky bottom, mobile
safe area is correct, no dashboard-style layout.

### Step D: Message, Reasoning, Tool, Event Renderers

Map AgentRun snapshot/events to reference message/tool/reasoning visuals.
Acceptance: reason/content stream chunks render incrementally; tool calls and
other events render as complete objects.

### Step E: Artifact Preview, Panel, Actions, Version Footer

Migrate preview hitbox, desktop side artifact, mobile full-screen artifact,
close/actions/version footer. Acceptance: artifact does not break conversation
layout and interaction is close to reference.

### Step F: Real API + SSE

Wire snapshot, creation, run start/cancel, and SSE resume. Acceptance:
workspace/thread/run create flows work, refresh restores from snapshot, and SSE
resume avoids duplicate/lost chunks.

Implementation note:

- `apps/web` treats `GET /api/runs/:runId` as the authoritative run snapshot.
- `POST /api/runs/:runId/events` accelerates display with SSE `snapshot`,
  `stream_chunk`, event-type messages, `done`, and `ping`.
- Run events are deduplicated by `seq`; stream chunks are deduplicated by Redis
  stream id from `MessageEvent.lastEventId`.
- `GET /api/threads/:threadId` exposes recent runs so refresh can choose the
  latest run and then restore full authoritative data from `GET /api/runs/:runId`.
- The browser still stores the last selected run id per thread in local storage
  as a compatibility fallback for older or empty thread snapshots. This remains
  a frontend recovery bridge, not mocked run content.

## Verification Required Per Step

- `pnpm --dir apps/web typecheck`
- `pnpm --dir apps/web build`
- Playwright screenshots for visual steps:
  - desktop `1440x900`
  - mobile `390x844`
  - light mode
  - dark mode

Screenshot checks:

- No text overflow.
- No incoherent control overlap.
- Sidebar collapse/mobile sheet works after Step B.
- Composer does not cover content after Step C.
- Artifact panel does not break conversation after Step E.
- Overall visual direction remains close to the reference.
