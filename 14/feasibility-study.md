# Blazon — feasibility study

*2026-10-16. Commissioned by Robert: "critically think about the project intent/purpose, my ambition and return with a feasibility study." Inputs: `inload/svg-designer-product-requirements.md`, `inload/svg-designer-requirements-outline.md`, the Trail Boss card and its first-look counsel, and the existing Set/theme engine in `trail-boss/public/app/theme.mjs`.*

## Verdict

**Feasible, on one condition: the centre of gravity moves.** The PRD reads as an icon *editor* that also does libraries, theming and AI. Built in that order by one person it stalls in the editor and never reaches the part that is new. Read the other way round, as a **design-system engine for iconography whose editor exists to refine, not to draw**, every hard part is a known quantity and the whole thing is a three-to-four-month part-time build in your normal flow-state cadence.

The name already says this. A *blazon* is the textual specification of a coat of arms, from which any herald can draw the arms. Heraldry has named tinctures (or, argent, gules, azure) instead of literal colours, and a rule of tincture that validates combinations. Intent in words, drawn by an artist, coloured by named roles, checked by rules. That is the product. The editor is the herald's pen, not the point.

## What the PRD actually contains

Four products share one coat.

| Part | Requirements | Novelty | Solo feasibility |
|---|---|---|---|
| A. Vector editor | FR-001..010 | none (Inkscape, Boxy SVG, svg-edit exist) | **the trap**. "Basic" is weeks; Bézier editing is months and never finished |
| B. Design-system engine: library, semantic colours, skins, themes, export, consumer runtime | FR-011..041 | **high**. Nobody binds semantic skin/theme colour to a custom icon library with a portable project | good. Data model + resolution + transforms + a preview grid |
| C. AI loop: prompt composer, paste-back, agent API, candidates, feedback, revision history | FR-042..058 | high | good. You have built this layer twice (trail-boss `ai.mjs`, counsel) |
| D. Four hosts + pluggable storage | FR-059..069 | low | feasible only if each host is thin. Two are cheap, two are expensive |

Parts B and C are the value. Part A is the cost. Part D is the proof.

## Load-bearing assumptions, tested

**1. LLMs can draw usable icons as SVG. (medium risk, cheap to test, test first)**
Frontier models produce acceptable simple geometric SVG. Failure modes are predictable: off-grid coordinates, inconsistent stroke width, poor legibility at 16 to 24px, decorative filler. Local models (the gemma4 counsel) will be markedly worse at SVG than at prose. Three mitigations are already in the PRD and they are the right ones: constrained prompt templates (viewBox, grid, stroke width, allowed primitives), multiple candidates, and an editor that refines rather than redraws. The thing to do before any other work is a bake-off: ten icon briefs, three or four models, one constraint template, judged at 16/24/48px. You have an `ai-bakeoff` repo. One session answers this.

**2. Semantic colours can live inside SVG. (low risk, one hard boundary)**
`fill="var(--icon-primary)"` and `currentColor` work when the SVG is inline in the document or referenced by `<use>` from an inline sprite. They do **not** cross the document boundary of `<img src>` or a CSS `background-image`. So the consumer story is inline SVG or sprite, never image tags, and the resolved-literal export mode exists exactly for the places that cannot inherit. This is a documented constraint, not a problem.

**3. The core can be host-free. (low risk, you have done it)**
The core is a project model (JSON, versioned), a palette resolver, an SVG sanitiser/normaliser, exporters, and a prompt composer. None of that touches DOM, filesystem or network. Storage and AI providers are injected. Same shape as the Set loader's data-over-code rule.

**4. One person can carry four hosts. (true only in a specific order)**
- **SPA** is the primary host and nearly free: the core plus a UI, localStorage/IndexedDB adapters. The File System Access API in Chromium gives real file persistence with no Electron.
- **Node headless** is nearly free and is also the agent surface. An MCP server over the same core (you have `ai-mcp-db`) is the standard FR-049 asks for without naming it.
- **ASP.NET 10** is the host with a real payoff: your .NET consumers. Cost is a controller for persistence plus serving the SPA. Third.
- **Electron** proves nothing the SPA plus File System Access does not already prove, and it is the only host that drags a heavy dependency. Defer; possibly never.

Your own success criterion on the card says "at least two distinct deployment environments (e.g., SPA and Node.js)". That is the right bar.

## Apparent contradictions, dissolved

- *Lightweight footprint vs Electron.* Electron is a host, not a dependency of the core. The core's footprint stays zero. Deferring Electron removes the question anyway.
- *No build step vs single-file HTML.* A packaging script that inlines modules into one HTML file is a deployment artifact, not a development build. Development stays native ESM and steppable. Write the inliner yourself in about a hundred lines of Node; it is the kind of tool you can see through.
- *"No phases implied" in the PRD vs a feasibility study that sequences.* The PRD describes the destination. Feasibility is about the road. The sequence below is a recommendation, not a decision.
- *Developer persona vs UX designer persona (open on the card).* You are both, and you are the first user: a developer who art-directs and already runs themed Sets across a portfolio. Build for that persona. The dedicated-designer persona is speculative until someone shows up.

## Does the world need it

Stock icons are a solved problem: Lucide, Phosphor, Heroicons, and Iconify unifying them all. The PRD's lead claim, "replace icon fonts and framework icons", is not the differentiator and should not be the pitch. What nobody does is **custom iconography that re-skins with the application's identity**, with semantic colour, portable projects, and an AI loop with human approval. Your Sets (Rome, Greece, China, Trail Boss) are themed fictions whose icons should change with the fiction. That is a need you already have in production, which makes this dogfood-driven, the strongest kind of justification. Market beyond you is a niche of design-system teams; real but small. Build it for the portfolio first.

## Scope calls that change the outcome

1. **Editor scope: refine, not draw.** Primitives, select/move/resize/rotate, group, props panel, align/snap to grid, SVG source editing with live preview, undo/redo, multi-size preview. **No freeform Bézier editing in v1.** Creation comes from import, source editing and AI. This answers the PRD's first open question and removes the single largest schedule risk.
2. **Consumer runtime is inline-SVG/sprite only.** One tiny `.mjs` that resolves a name to markup and injects it, plus a sprite exporter. No image-tag path.
3. **Manual prompt-copy/paste before any provider integration.** Zero dependencies, immediate value, and it produces the prompt template that the agent path reuses.
4. **Approval is a status flag with timestamp and author.** Multi-user review is out of v1.
5. **SVG sanitiser is an allowlist, not a blocklist.** Icons need a dozen elements and a few dozen attributes. Strip script, foreignObject, external hrefs, event attributes, filters by default. Allowlist stays small and auditable; no DOMPurify dependency.
6. **Accessibility rides in the model.** Every icon carries `title` and `description`; the runtime emits `aria-label` or `aria-hidden` by use. Counsel's point, and it is cheap.

## Effort, roughly

Solo plus Claude, part-time, your usual session rhythm. Weeks are focused effort, not calendar.

| Slice | Weeks | Notes |
|---|---|---|
| Bake-off spike (assumption 1) | 0.5 | go/no-go on the AI leg's quality bar |
| Core: project model, palette/skin/theme resolver, sanitiser, exporters (svg, sprite, mjs) | 2 to 3 | pure modules, fully testable headless |
| Library UI, skin/theme preview grid, candidate gallery, prompt composer, paste-back | 2 | |
| Editor (refine scope) | 3 to 5 | the one that grows; hold the line at no Bézier |
| Agent/provider layer, Node CLI, MCP server | 2 | reuse trail-boss provider patterns |
| SPA host, storage adapters, single-file inliner | 1 | |
| ASP.NET 10 host | 1 to 2 | |
| Electron | deferred | |
| **Total to the two-host success criterion** | **11 to 14** | ASP.NET adds 1 to 2 |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Editor absorbs the project | high if built first | fatal to the novel parts | build the editor last of the core slices, refine scope only |
| AI icon quality below the bar at small sizes | medium | AI leg becomes prompt-and-paste only | bake-off first; constraint templates; candidates + refine |
| Local models unusable for SVG | medium | provider abstraction still works, local path is weak | treat local as optional; design the abstraction, do not promise parity |
| Semantic colours leak into literal colours in consumers | low | theming silently breaks | export validation (FR-025) and the inline-only runtime rule |
| Four hosts dilute attention | high if parallel | nothing finishes | SPA, then Node, then ASP.NET; Electron deferred |
| Project format churn | medium | portability promise breaks | version field from day one, migration function per version |

## Recommended sequence (a recommendation, not a decision)

1. Bake-off spike. Decide the AI quality bar from evidence.
2. Core modules, headless, tested. Project format v1.
3. SPA host with library, preview grid, prompt composer, paste-back. First real icons for a Set.
4. Node CLI and MCP server. Agent candidate loop.
5. Editor at refine scope.
6. ASP.NET 10 host.
7. Electron only if a concrete need appears.

Step 3 is the first dogfood moment: a Set in trail-boss wearing Blazon icons. That is also the first moment the product can be judged honestly.

## Open items

- Which Set is the first consumer, and which ten icons form the "critical 10" (counsel's framing)?
- Project interchange format: single JSON, or a folder with one SVG per icon plus a manifest? Folder diffs better in git; single file travels better. Leaning folder-with-manifest, zipped for transfer. Decide at core design.
- Provider credentials: host-owned wallet file, per the 2026-07-06 ruling. Confirm how this applies to the SPA host, which has no wallet: user-supplied key in IndexedDB, or proxy through the ASP.NET/Node host.
- Does Blazon own the skin/theme definitions, or import them from the consuming app's Set? For trail-boss the Set already owns the tokens. Blazon should import palettes, not be their source of truth.
