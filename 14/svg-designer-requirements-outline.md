# Portable SVG Icon Designer — Requirements at a Glance

*A compact hierarchical outline of the complete product requirements. This is a summary, not a phased plan or implementation guide.*

## Product intent
- Replace icon fonts, framework icons, and custom image icons with reusable SVGs.
- Support manual design, external AI assistance, and autonomous agent workflows.
- Keep icons and projects portable across applications and hosts.

## Functional requirements

### SVG creation and editing
- Interactive canvas, configurable grid and viewBox.
- Shapes, paths, transforms, groups, and alignment tools.
- Fill, stroke, opacity, and other visual properties.
- SVG import, source editing, undo/redo.
- Previews at different sizes and backgrounds.

### Icon libraries
- Multiple icons per library or project.
- Names, tags, categories, descriptions, and search.
- Outline, filled, and other icon variants.
- Reuse across applications; retain design provenance.

### Palettes, skins, and themes
- Create, manage, import, and export palettes.
- Named semantic colors instead of fixed colors.
- Named skins (e.g., Outdoors, Winter).
- Dark, Medium, and Light themes per skin.
- Preview across skin/theme combinations.
- Export CSS variables, fixed values, or `currentColor`.
- Validate palette references and share constraints with AI.

### Workspaces, projects, and assets
- Workspaces for multiple projects and experiments.
- Project creation, saving, duplication, import/export.
- Draft, candidate, approved, and finalized asset states.
- Autosave, recovery, and unsaved-change detection.
- Portable, versioned project files containing all related resources.

### SVG export and application use
- Export individual SVGs, sprites, and JavaScript assets.
- Clean, standards-compatible output.
- Configurable color resolution at export.
- Lightweight application-side icon lookup and rendering.
- Preserve editable originals separately from exported output.

### Manual AI assistance
- Describe icon purpose, use, appearance, and constraints.
- Reusable prompt templates and prompt generation.
- Copy prompts to ChatGPT, Claude, Gemini, etc.
- Paste, validate, preview, and edit AI-generated SVGs.
- Generate refinement prompts using existing SVGs and feedback.

### Automated AI agents
- Programmatic access to designer capabilities and project context.
- Interchangeable local and remote AI providers.
- Generate multiple icon candidates per concept.
- Side-by-side candidate comparison.
- Accept/reject choices, preferences, and written feedback.
- Iterative revisions with candidate and feedback history.
- Human approval before final library inclusion.

### Host integration and persistence
- Reusable `.mjs` / ES module and embeddable interface.
- Host configuration, events, and integration contracts.
- Interchangeable storage and asset services.
- Browser storage, filesystem, and API-backed persistence.
- Standalone browser and single-file HTML deployment.
- Headless programmatic operation.

## Non-functional requirements

### Portability and modularity
- Core independent of Electron, ASP.NET, and storage providers.
- Same project format and operations across hosts.
- Lightweight dependencies and replaceable integrations.

### Data integrity and interoperability
- Fully editable, versioned project data.
- Standards-compatible SVG exports.
- Stable semantic colors across skins and themes.
- No reliance on host-specific paths or identifiers.

### Safety and reliability
- Safely validate imported and AI-generated SVGs.
- Restrict untrusted agent output and require approval.
- Protect against silent loss of work.
- Preserve local editing when external services fail.

### Usability and consistency
- Clear small-size previews and theme comparisons.
- Unified editing experience for human- and AI-created icons.
- Clearly distinguish drafts, candidates, and approved assets.

### Extensibility and testability
- Add hosts, storage providers, AI models, and exporters.
- Verify equivalent behavior across supported environments.
- Document integration interfaces for third-party developers.

## Reference clients and portability demonstrations
- **Electron:** Desktop editing and filesystem storage.
- **Standalone SPA:** Browser storage and downloadable projects; single-file distribution.
- **ASP.NET Ten:** Embedded editor with backend persistence and asset services.
- **Node.js headless/CLI:** Automated project and SVG operations without a UI.
- **Cross-host verification:** Open and edit the same projects in every client.

## End-to-end usage scenarios
- Draw or import an icon, refine it, and save it.
- Switch skins and themes without redesigning the icon.
- Generate an external AI prompt, paste the SVG back, and refine it.
- Have an agent propose candidates, collect feedback, and iterate.
- Move an editable project between different hosts.
- Embed the designer and consume its icon library in another app.

## Open product questions
- Exact scope of advanced path-editing tools.
- Which project and asset metadata should be mandatory.
- Which additional palette and export formats are needed.
- Which agent integration standards and provider capabilities are required.
- How approvals and sharing should work for multi-user environments.

*No priorities, phases, or development sequence are implied.*
