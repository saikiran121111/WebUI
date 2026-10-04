# Graph Report - WebUI  (2026-10-04)

## Corpus Check
- 48 files · ~14,231 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 1, .css 1, .tsbuildinfo 1)

## Summary
- 308 nodes · 503 edges · 17 communities (12 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9985873d`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- lib/types.ts
- MarkdownRenderer.tsx
- package.json
- disk.ts
- client.ts
- parser.ts
- compilerOptions
- page.tsx
- BrowserTool
- dependencies
- devDependencies
- probe-vision.py
- next.config.mjs
- postcss.config.mjs
- next
- @playwright/test

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 17 edges
2. `cn()` - 14 edges
3. `BrowserTool` - 13 edges
4. `HomePage()` - 11 edges
5. `createStreamParser()` - 11 edges
6. `createSseParser()` - 9 edges
7. `scripts` - 8 edges
8. `react` - 8 edges
9. `ChatInput()` - 7 edges
10. `useChat()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `GET()` --calls--> `getConversationOnDisk()`  [EXTRACTED]
  app/api/conversations/[id]/route.ts → lib/persistence/disk.ts
- `PUT()` --calls--> `saveConversationOnDisk()`  [EXTRACTED]
  app/api/conversations/[id]/route.ts → lib/persistence/disk.ts
- `POST()` --calls--> `saveConversationOnDisk()`  [EXTRACTED]
  app/api/conversations/route.ts → lib/persistence/disk.ts
- `HomePage()` --calls--> `useChat()`  [EXTRACTED]
  app/page.tsx → hooks/useChat.ts
- `ChatInput()` --calls--> `validateAttachment()`  [EXTRACTED]
  components/ChatInput.tsx → lib/files/docProcessor.ts

## Import Cycles
- None detected.

## Communities (17 total, 5 thin omitted)

### Community 0 - "lib/types.ts"
Cohesion: 0.08
Nodes (28): ChatMessageProps, buildResearchToolDefs(), SendStatus, uid(), useChat(), UseChatOptions, UseChatReturn, ChatClientError (+20 more)

### Community 1 - "MarkdownRenderer.tsx"
Cohesion: 0.08
Nodes (3): LANGUAGE_MODULES, prismjs, prismjs/components/prism-*

### Community 2 - "package.json"
Cohesion: 0.07
Nodes (27): name, private, scripts, build, dev, lint, start, test (+19 more)

### Community 3 - "disk.ts"
Cohesion: 0.21
Nodes (12): DELETE(), GET(), PUT(), GET(), POST(), deleteConversationOnDisk(), ensureDir(), file() (+4 more)

### Community 4 - "client.ts"
Cohesion: 0.11
Nodes (14): ChatClient, iterate(), Attachment, ChatRequest, ChatStreamCallback, OpenAIMessage, ToolDef, countPdfPages() (+6 more)

### Community 5 - "parser.ts"
Cohesion: 0.19
Nodes (15): createStreamParser(), normaliseUsage(), ToolCallAccumulator, boundaryLength(), createSseParser(), indexOfBoundary(), parseEvent(), SseMessage (+7 more)

### Community 6 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, downlevelIteration, esModuleInterop, incremental, isolatedModules, jsx, lib (+11 more)

### Community 7 - "page.tsx"
Cohesion: 0.10
Nodes (32): EmptyState(), HomePage(), uid(), ChatInput(), ChatInputProps, EFFORT_LABEL, EFFORT_LEVELS, EffortMenu() (+24 more)

### Community 9 - "dependencies"
Cohesion: 0.15
Nodes (13): dependencies, clsx, framer-motion, idb-keyval, lucide-react, next, prismjs, react (+5 more)

### Community 10 - "devDependencies"
Cohesion: 0.17
Nodes (12): devDependencies, autoprefixer, @playwright/test, postcss, tailwindcss, @tailwindcss/typography, @types/node, @types/prismjs (+4 more)

### Community 15 - "next"
Cohesion: 0.14
Nodes (3): POST(), metadata, next

### Community 16 - "@playwright/test"
Cohesion: 0.20
Nodes (5): @playwright/test, itemByTitle(), openMenuFor(), itemByTitle(), openMenuFor()

## Knowledge Gaps
- **88 isolated node(s):** `metadata`, `EFFORT_LEVELS`, `EFFORT_LABEL`, `HeroComposerProps`, `LANGUAGE_MODULES` (+83 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 147 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `page.tsx` to `lib/types.ts`, `MarkdownRenderer.tsx`, `package.json`?**
  _High betweenness centrality (0.213) - this node is a cross-community bridge._
- **Why does `next` connect `next` to `package.json`, `disk.ts`?**
  _High betweenness centrality (0.155) - this node is a cross-community bridge._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **What connects `metadata`, `EFFORT_LEVELS`, `EFFORT_LABEL` to the rest of the system?**
  _88 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `lib/types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0782051282051282 - nodes in this community are weakly interconnected._
- **Should `MarkdownRenderer.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._