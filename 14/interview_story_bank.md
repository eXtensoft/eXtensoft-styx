# GS-14 IT Specialist Panel — Story Bank & Coverage Grid

## The Thesis (memorize this, everything hangs off it)

**"Senior architect with a 30-year pattern of building frameworks other people build on — now applied to AI. The model is the easy part; the governance around it is the work, and I've built a working miniature of what the agency needs at enterprise scale."**

Every answer should quietly deposit evidence into one of three accounts:
1. Senior architect, proven at enterprise scale
2. The division's only end-to-end AI practitioner — with governance instincts, not just enthusiasm
3. Ready to lead from day one — follower and leader, force multiplier

---

## The Seven Stories

### Story 1 — "Twenty Minutes to Enterprise Platform" (AppTrak)
**Use for:** initiative/proactivity, customer intimacy, translating vague requirements, ATO/federal compliance, force multiplication, adoption/change management.

- **Situation:** The branch's applications faced ATO requirements with no unified observability. Chuck — the technical lead responsible for answering ATO requests — described the need in a single 20-minute conversation; total direction received was half a dozen sentences.
- **Task:** Turn that directive into something real, with no spec, no requirements document, no follow-up meetings.
- **Action:** Designed and built a complete observability platform: a reusable NuGet package providing semantic structured logging, session-based clickstream capture, and health endpoints; a centralized aggregation API; automated health monitoring across DEV/VAL/UAT/PROD; and a dashboard for drill-down analysis. Then drove adoption without any mandate — demonstrated semantic logging and searchable event history to the other developers and let the capability sell itself.
- **Result:** 17 applications tracked. Three developers integrated the package into their own applications after seeing the demo. The person answering ATO requests now answers them with data.
- **Kicker:** "Twenty minutes of customer conversation became an enterprise platform because I've spent thirty years learning to hear the system inside the sentence. And adoption came from demonstration, not mandate — you win developers by showing them their own problem solved."

### Story 2 — "The Pipeline Standard" (Azure DevOps) — CROWN JEWEL for leadership
**Use for:** force multiplier (the chief's literal definition), mentorship, implementing standards, initiative, staying current, cross-workforce (contractor + fed) influence.

- **Situation:** The team's applications were deployed inconsistently; no standardized build/release process existed across environments.
- **Task:** Self-assigned. Nobody asked.
- **Action:** Self-taught Azure DevOps build/release pipelines. Standardized how the team's applications deploy to DEV/VAL/PROD. Then taught the process to two contractors and one government employee — hands-on, until they could do it without me.
- **Result:** All three now build their own pipelines. The standard survives without my involvement — which is the only proof that teaching worked.
- **Kicker:** "A force multiplier's job is to make himself unnecessary to the process he created. The standard is still there; my hands aren't."

### Story 3 — "Disagree and Commit" (the overruled recommendation)
**Use for:** follower/leader duality, conflict with leadership, accountability, professional maturity. This is the chief's "great follower and great leader" line, lived.

- **Situation:** Asked to implement an approach I had technical concerns about.
- **Task/Action:** Made my recommendation against it, clearly and with reasons, before the decision. Was overruled and directed how to implement. Implemented it — as well as it could possibly be built within the constraints given. No relitigating, no slow-walking, no "I told you so."
- **Result:** The solution works within its limits. The relationship and the mission stayed intact. Leadership knows my dissent is honest and my execution is unconditional.
- **Kicker:** "I owe leadership my honest recommendation before the decision, and my full craftsmanship after it. If the evidence changes, I'll raise it again through the front door."
- **Delivery note:** Do NOT editorialize about the solution being bad in the interview. The story is about your conduct, not the decision's quality. One neutral clause ("an approach I had concerns about") is all the criticism you voice.

### Story 4 — "No Debugger, No Docs, No Excuses" (ColdFusion → .NET 6)
**Use for:** legacy modernization (the agency's whole predicament), problem solving under uncertainty, risk management, project ownership, mentorship (woven in).

- **Situation:** A legacy ColdFusion application managing mainframe SoftDate job scheduling. No debugging access. A partially functional development site with no mainframe integration. No documentation of what was live versus dead.
- **Task:** Full replacement, without breaking the operators who depend on it daily.
- **Action:** Reverse-engineered the ColdFusion codebase cold — separated active functionality from dead code by reading, tracing, and inference. Designed and built the .NET 6 replacement: state-machine-driven wizards for complex job configuration, queue-based asynchronous submission, FTP mainframe integration, Server-Sent Events for real-time operator feedback. Worked under Chuck's direction across two years. Brought a government developer along through the build — he learned .NET Core, dependency injection, and loose coupling through the work itself.
- **Result:** A modern, maintainable application replaced an unmaintainable one with continuity for operators — and the government workforce gained a developer who's productive in the modern stack.
- **Kicker / segue to Story 7:** "That was intent-recovery by hand — months of it. It's exactly why I later built an AI pipeline for the same problem, because the agency has thousands of these systems and not thousands of months."

### Story 5 — "Governed Autonomy" (AI guardians)
**Use for:** AI depth, governance/standards (PD language), innovation with discipline.

- **Situation:** Solo greenfield project at high AI-assisted velocity — real risk of architectural drift when a model generates a large share of the code.
- **Action:** Encoded eight named architectural invariants into project memory. Built three read-only subagents that fan out in parallel before any significant commit: one audits the diff against the invariants, one lints for domain-model contamination, one runs typecheck and tests and reports proof. Maintained a decisions log recording not just choices but their preclusions, with a standing rule that the model consult it before proposing alternatives.
- **Result:** 304 commits in 30 days — roughly 19K lines of code plus 12K lines of documentation, solo, evenings. Against a typical sustained solo rate of 100–300 LOC/day, that's a measured 3–5× multiplier — with the architecture intact, because conformance was enforced by automation, not memory.
- **Kicker:** "Constraints enforced by automation, not by remembering. That's the pattern that scales to a division: the governance rides with the tool."

### Story 6 — "Measure, Don't Believe" (bake-offs)
**Use for:** contractor/vendor oversight, evaluation judgment, vendor neutrality, the "how do you know AI output is good?" probe.

- **Action:** Ran two structured bake-offs. First: eight images across four vision engines, scored on schema conformance, latency, and error rates — selected a 7B local model because the bigger-name alternative had a 100% error rate on the test set. Second: two frontier models building the same frozen spec, six-facet rubric, adversarial cross-check of each other's artifacts — scored it 28–28 and awarded the win on a stated tiebreak principle to the competitor of my primary vendor.
- **Kicker:** "The agency is about to be sold a great deal of AI. I evaluate by measurement, and I've already demonstrated I'll rule against my own favorite when the evidence says so."
- **Honesty guardrail:** Say "I ran two structured bake-offs." Never say "I do evals" — no golden dataset, no regression suite, and an informed panelist could expose that.

### Story 7 — "Legacy Archaeology at Scale" (dig briefs / app-spec)
**Use for:** AI applied to the agency's actual bottleneck; the modernization vision question; "where would you start?"

- **Situation:** The hardest modernization problem isn't writing new code — it's recovering intent from old code, which usually lives in retired employees' heads.
- **Action:** Built a repeatable AI pipeline for intent recovery: a portable, self-contained, self-validating "dig brief" a cold agent can execute against any repository, extracting system intent into 110 machine-validated JSON Schema files with provenance. Ran it across roughly six unrelated codebases. Separately, on an inherited 34K-LOC platform, generated a complete governing corpus — schema documentation, data-access pattern standards (now the written standard for new work), a security review, feature specs, and a remediation backlog.
- **Result:** Validation is executed, not asserted — a cold agent's first run passed schema validation with zero errors. Portfolio-scale analysis that would never be attempted manually.
- **Kicker:** "By hand, the ColdFusion dig cost months for one system. The pipeline changes that arithmetic — and every output is machine-validated, because 'the AI said so' is not a standard."

### Story 8 — "Upgrade, Hand Off, Walk Away" (gateway + two microservices)
**Use for:** followership, team membership, knowledge transfer, cross-area flexibility, sustainability of work — and as the second proof (with Story 2) that your work outlives your presence.

- **Situation:** A federated data platform — gateway API and downstream services in legacy VB.NET/.NET Framework — needed modernization while a team of roughly half a dozen developers carried the enterprise application forward. My role on the team side was straightforward: execute assigned tasks inside the team's cadence.
- **Task:** Modernize the gateway and two downstream microservices in place, without disrupting operation — then transfer ownership entirely.
- **Action:** Refactored VB.NET/.NET Framework to C#/.NET Core, retrofitting dependency injection and modern patterns while preserving operational behavior; built a façade over the tightly coupled legacy query engine so modern architecture could coexist with it. Documented and handed the services off.
- **Result:** All three run today without me. The handoff stuck.
- **Kicker:** "The measure of a modernization isn't the day it ships — it's whether it survives your departure. Mine have, twice: the deployment standard and these services. I re-architect in place, stabilize, and hand off. That's a repeatable act, and it's exactly what a division with a long modernization queue needs done across a lot of areas."
- **Delivery note:** The team detail ("half a dozen devs, executing assigned work") is your answer to "have you worked on a team?" — offer it plainly, without inflation. A senior architect content to take tickets on someone else's application is followership evidence; don't dress it up as more.

---

## The Layered AI Tenure Answer (exact phrasing)

"Three years total, in three distinct phases. I started with GPT when it was genuinely painful — I know, because I used it to build a knowledge-base site capturing thirty years of my architecture notes, and it fought me the whole way. Then fourteen months of daily Copilot inside Visual Studio. And since February, agentic tooling — Codex CLI and Claude Code — which is where the step-change is. The orchestration work I can show you comes from the last four months of that."

Why this works: it's true at every layer, it maps to the exact adoption curve every developer in the division will have to climb, and it positions you as the person who knows what each rung feels like. If pressed on depth: "Four months of agentic work produced an authored MCP server, three guardian subagents, two eval harnesses, and a measured 3–5× velocity gain — I'll take depth-per-month over years of shallow use."

---

## Handling the Standard Hard Questions

**"Tell me about a failure."** Silverlight. "At Inovalon I built a member-outreach application and portal plug-ins on Silverlight — genuine expertise, real investment. Microsoft killed the platform. Nobody's fault, but I'd bet skill and product on a vendor-locked runtime and lost the bet. It permanently changed how I architect: standards-based over vendor-locked, seams where the vendor is. It's why my AI layer today has tested multi-provider adapters, and why my one head-to-head model evaluation went to my primary vendor's competitor — I don't get locked in twice." Never say "I can't think of a failure."

**"Have you led AI adoption for a team?"** "Not yet — and that's precisely the job I'm applying for. What I've built is the onboarding kit: a plain-English subagent explainer for someone who's never seen one, a portable 150-line configuration that installs on another developer's machine as-is, a one-command scaffold that installs AI-session rules into any repository, and a collaboration contract refined twenty times over a month with a dated change log. I've spent thirty years building frameworks other developers build on — Inovalon's LOB framework, the pluggable portal, AppTrak's NuGet adoption at SSA. This is the same discipline. The kit is packed; this role is where it deploys."

**"How have you used AI on agency work?"** "Deliberately, not at all. Government code and data have never touched a commercial model. I built my entire AI practice on personal projects and my own hardware — including local models for anything sensitive — and my one database-touching tool is read-only, row-governed, human-gated, against an offline copy. I treated the data boundary as requirement zero, because that's what the agency will have to do at scale." (Then, if the room invites it: candidly note that formal NIST AI RMF / policy work is ahead, and it's work you want to do from the government side.)

**"What about hallucination / how do you trust output?"** Guardian gauntlet (Story 5) + executed validation (Story 7: Ajv, zero errors) + bake-off measurement (Story 6) + "every generated claim must cite the real artifact it stands on — no free invention" as a standing rule in your orchestration.

**"Why leave contracting for government service?"** Ownership and mission — not comfort. "For eight years I've built what I was directed to build, and built it well. The AI transition is the one I want accountability for, not proximity to — requirements, governance, standards, contractor oversight from the government side. And the mission is personal: I spent ten years in insurance operations before software — I adjudicated claims. This agency's business is the one I started in." (Do not mention benefits or retirement. Ever.)

**Weakness (if asked separately from failure):** "I've optimized for individual throughput for a long time. The deliberate growth edge is scaling through others — which is why the pipeline teaching happened, why the AI onboarding kit exists, and frankly why this role and not another IC seat."

---

## Coverage Grid

| Dimension | Primary story | Backup |
|---|---|---|
| Hands-on technical execution | 4, 5 | any |
| Architecture & design | 4, 7 | backstory (Inovalon frameworks) |
| Governance / standards | 2, 5 | 1, 7 (data-access standards) |
| Industry currency | 5, 6 | 2 (self-taught ADO) |
| Legacy modernization | 4 | 8, 7 |
| Federal constraints / ATO | 1 | AI data-boundary answer |
| AI rollout strategy | 7, 5 | 6, tenure arc |
| Leadership via expertise | 2 | 1 (adoption by demo) |
| Mentorship | 2 | 4 (gov dev → .NET Core) |
| Follower/leader | 3 | 8 (assigned tasks on team of ~6) |
| Force multiplication | 2 | 1, 8 (handoffs that stick), AI onboarding kit |
| Conflict / difficult situations | 3 | — |
| Contractor→fed credibility | Why-fed answer | 6 (vendor oversight) |
| Project planning / accountability | 4 | 5 (304 commits, solo cadence) |
| Proactivity / initiative | 1, 2 | 5 |
| Prioritization under constraint | 4 (no dev env) | 3 |
| Risk management | 4 | 6, AI data boundary |
| Metrics / outcomes | 17 apps · 3 adopters · 3 taught · 304 commits/30d · 3–5× · 60+ datastores | |
| Customer / analyst interfacing | 1 (Chuck) | Insurance-origin story |
| Cross-divisional flexibility | 8 (60+ datastores, handoff model) | multi-env monitoring |
| Contractor oversight | 6 | interview-panel experience |
| Change management | 1 (adoption by demonstration) | 2 |
| Mission fluency | Insurance/claims origin | NIH years |
| Failure / lessons | Silverlight | 3 |

## Four Core 2210 Competencies — explicit coverage
- **Problem solving:** Story 4 (no debugger, no docs) — lead with it.
- **Customer service:** Story 1 + insurance-origin ("I've sat in the customer's chair for a decade").
- **Oral communication:** demonstrated live; keep answers to 90–120 seconds, headline → story → kicker.
- **Attention to detail:** Story 7 (machine-validated, provenance-cited) + Story 5 (invariant enforcement).

## Questions to Ask the Panel (pick 2–3)
1. "What does success in this seat look like at the twelve-month mark — what will have visibly changed?"
2. "Where is the division on the AI adoption curve today, and what's the appetite for standards versus experimentation?"
3. "What's the biggest obstacle the modernization effort has hit that wasn't technical?"
4. (If the 15 is present) "You'd be allocating this role across areas — which fire would you point it at first?"

## Discipline Notes
- Never claim: "years of agentic AI experience," "I do evals," production AI systems, team AI rollout, or ringer as your work.
- Never mention: benefits/retirement as motivation, the pre-wiring, criticism of the overruled decision, internal system details beyond what the panel already knows.
- Every story ends on a kicker sentence. Practice each aloud until the kicker lands without notes.
