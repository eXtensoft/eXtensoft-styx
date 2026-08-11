# The Rollout Doctrine — What They Haven't Thought Of Yet

Nine named principles. Each: the trap → the principle → your evidence.
Deploy ONE per answer, as considered opinion. Never all nine — that's a lecture, not an interview.

---

## 1. "Tools don't transform; workflows do" — the Copilot Fallacy

- **Trap:** Buy licenses for everyone → usage plateaus at autocomplete → no outcome change → leadership concludes "AI is overhyped" → program dies having never been tried
- **Principle:** Value is nonlinear across the adoption curve. The big gains live at the agentic/workflow-redesign rung — which a seat license alone never reaches. Uniform distribution to heterogeneous roles guarantees a mediocre average
- **Evidence:** Your own arc — 14 months of Copilot produced modest gains; 4 months of agentic tooling with governance produced a measured 3–5×. Same person. The tool wasn't the variable; the workflow was

## 2. "Rungs, not switches" — meeting people where they are

- **Trap:** Treating adoption as binary (has AI / doesn't) instead of a ladder people climb at different speeds
- **Principle:** The ladder: chat assistant → IDE copilot → agentic delegation. Each rung requires different skills and different trust. Training must target the person's *current* rung
- **Corollary — the two-speed workforce risk:** fast adopters and slow adopters diverge; the gap breeds resentment and political friction. Mitigation: convert the fast into teachers (make speed a service, not a status)
- **Evidence:** You climbed every rung personally, with dates, and can name what each transition felt like. And the teacher-conversion pattern is your pipeline story: taught 3, they self-serve

## 3. "The org chart feels it before the codebase does" — where disruption actually lands

- **Trap:** Bracing for developer resistance while the intermediation layer (requirements, scrum masters, coordination PMs) absorbs the real identity shock unprepared
- **Principle:** Developer output is verifiable → easiest AI fit. Intermediation work is *translation between people* → exactly what LLMs collapse. But the roles invert rather than vanish:
  - Requirements → **spec engineering** (in an AI shop, the spec IS the work product; it matters MORE)
  - Scrum master → **flow management** of mixed human/agent work
  - Reviewer → elevated (see #7)
- **Evidence:** ai-chezmoi — 34.5K LOC built against a *frozen spec set*. The spec was the labor; the build was throughput

## 4. "Capacity restoration, not headcount justification" — THE SSA-2026 PRINCIPLE

- **Trap:** At a post-RIF, unionized, morale-scorched agency, AI will be read as "automating us to justify the cuts." One whiff of that framing — adoption dies, the fight begins
- **Principle:** The people are already gone. AI is how the people who remain survive the workload. Every communication, pilot charter, and metric must be built on *restoring capacity to a diminished workforce* — never "more with fewer"
- **Deployment note:** One sentence, delivered as considered concern for the workforce. Zero commentary on the cuts themselves. This is your sharpest arrow — it demonstrates political comprehension no vendor deck contains

## 5. "Baseline before you buy" — measurement doctrine

- **Trap:** "Did it improve anything?" is unanswerable without a *before*. Most orgs can't state their current cycle time or defect rate — then ask AI to prove a delta
- **Principle — the measurement stack:**
  1. **Instrument first** (step zero is observability, not licenses)
  2. **Pilot with a control** (paired teams, or before/after on the same team)
  3. **Outcomes, never activity** — cycle time, escaped defects, backlog burn, time-to-onboard — NOT prompts sent / suggestions accepted (activity metrics get gamed; Goodhart wins)
  4. **Never metrics-as-surveillance** — measure teams and flow, not individuals' AI usage, or trust dies and honest usage goes underground
- **Evidence:** AppTrak IS the agency's measurement reflex, built by you — "apply the same discipline to the delivery process itself." Plus the bake-offs: model selection by measurement, verdict against your own vendor

## 6. "WHERE before HOW" — the task-shape screen

- **Trap:** Deploying by org unit ("give the dev teams AI") instead of by task shape
- **Principle — a task is AI-leverageable when:**
  - Output is **verifiable** (compiles, tests, schema-validates)
  - **Context can be assembled** (code, docs, data dictionaries exist)
  - **Iteration is cheap** (wrong draft costs minutes, not incidents)
  - **Volume is high** or the work is **chronically deferred**
- **First-target matrix for this agency (the deferred-work goldmine):**
  | Target | Why it's first |
  |---|---|
  | Legacy intent recovery | Thousands of systems, knowledge retiring, your dig pipeline proves it |
  | Documentation debt | Nobody's identity is threatened; everyone hates the backlog |
  | Test coverage | Verifiable by definition |
  | ATO evidence generation | Chuck's pain, AppTrak-adjacent, compliance-shaped |
- **Anti-targets:** irreversible decisions, sparse-context judgment calls, anything PII-touching before governance exists
- **Evidence:** Dig briefs — 6 repos, 110 machine-validated schemas

## 7. "Verification is the new bottleneck" — the skill inversion

- **Trap:** Training everyone to *generate* while nobody scales *review*. Output volume explodes; review capacity doesn't; quality risk concentrates at the merge
- **Principle:** The scarce skill shifts from writing to **specifying and verifying**. Delegation is the skill, not prompting: intent + constraints + acceptance criteria — which is exactly what good technical leads already do with junior developers. Train delegation like a leadership skill, because it is one
- **Evidence:** The dig brief is delegation formalized — a task package a cold agent executes and *self-validates* (bundled Ajv, 0 errors first run). The guardian gauntlet is review capacity automated

## 8. "Aim at the hated work first" — adoption psychology

- **Trap:** First pilots aimed at people's identity work ("AI will write your code") → threat response → quiet sabotage
- **Principle:** Sequence pilots at work people *resent* — documentation, boilerplate, test scaffolding, status reporting. Early wins then feel like liberation, not replacement. Let **pull replace push**: seed champions, demo, let capability sell itself. Grant experimentation amnesty (no one punished for trying and failing)
- **Evidence:** AppTrak adoption — no mandate; you demoed semantic search and "once they saw it, they were sold." Three integrations by pull

## 9. "Governance rides with the tool" — policy as configuration, not PDF

- **Trap:** Governance as a memo nobody reads, arriving after the incident
- **Principle:** Rules must install with the tooling — standing instructions, scaffolded contracts, automated gates — so compliance is the default path, not a memory test. Data boundary defined *before* scale: what may enter a model, which models for which sensitivity, validation gates on output
- **Evidence:** 150-line portable config auto-loaded into every session · `tb enlist` scaffolds the rules into any repo in one command · guardian gauntlet enforces invariants pre-commit · zero SSA code/data has ever touched a commercial model — the boundary was your requirement zero, self-imposed
- **Federal hook (name it, don't claim it):** this is the posture NIST AI RMF and ATO processes will demand; the formal mapping is work you *want* to do from the government side

---

## Deployment Map — which principle answers which question

| Panel question | Lead principle | Backup |
|---|---|---|
| "How would you approach the AI rollout?" | 6 (WHERE before HOW) | 5 |
| "What would you do in your first 90 days?" | 5 (baseline) | 8 |
| "How do you measure success?" | 5 | 1 |
| "How do you handle resistance?" | 8 | 4, 2 |
| "What about the workforce impact?" | 4 ← the arrow | 3 |
| "What roles change?" | 3 | 7 |
| "How do you keep quality up?" | 7 | 9 |
| "What are the risks?" | 9 (data boundary) | 1, 4 |
| "Why not just give everyone Copilot?" | 1 | 2, 6 |
| Your own question to the panel | "Where is the division on the adoption curve, and what's the appetite for governance versus experimentation?" (opens the door to 2 and 9) | |

## Delivery discipline

- One principle per answer. Named principles are quotable; nine at once is a manifesto
- Every principle lands harder with its evidence clause: *principle → "and I've run this in miniature: [artifact]"*
- Principle 4 exactly once, one sentence, as concern for the workforce — never as commentary on the cuts
- If they've thought of it already: "good — then we agree on the hard part" and go one level deeper, don't compete
