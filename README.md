---
license: apache-2.0
tags:
  - n8n
  - workflow
  - rag
  - evaluation
  - llm-evaluation
  - snorkel
  - agentic-ai
  - human-in-the-loop
  - legal-ai
language:
  - en
pretty_name: Snorkel RAG Evaluation Pipeline (n8n Workflow)
---

# Snorkel RAG Evaluation Pipeline

An **agentic RAG evaluation system** built in n8n, inspired by [Snorkel AI's](https://snorkel.ai) programmatic labeling methodology. Automatically generates adversarial test questions from legal documents, evaluates a target RAG agent's responses with deterministic rubric functions, gates production deployment at ≥90% pass rate, and routes failed evaluations to a human-expert calibration form that writes corrections to a golden training dataset.

## Architecture

```
[Cron / PDF Upload Trigger]
          │
          ▼
[Extract PDF Content]
          │
          ▼
[Prepare Eval Context]
          │
          ▼
[AI Agent: Synthetic Eval Data Generator]  ← GPT-4o + Structured Output Parser
          │  (generates 10 adversarial questions)
          ▼
[Split Questions Into Items]
          │
          ▼
[splitInBatches: Evaluate Each Question]
  │                          │
  │ onEachBatch              │ onDone (all questions evaluated)
  ▼                          ▼
[Call Target RAG Agent]    [Aggregate All Eval Results]
  │                          │
  ▼                          ▼
[Bundle Q + A]            [Calculate Pass Rate]
  │                          │
  ▼                          ▼
[AI Agent: Programmatic Evaluator]    [Switch: Route by Pass Rate]
  ├── Tool: citation_checker           │
  ├── Tool: snorkel_rubric_evaluator   ├── ≥90% → [Supabase: Log as Production Ready]
  └── Structured Output Parser         │
  │                                    └── <90% → [Expert Adjudication Form]
  ▼                                                      │
[Flatten Eval Result]                                    ▼
  │                                       [Supabase: Log Expert Correction]
  └──────────────────────────────────────────────────────┘
                    (loop back to splitInBatches)
```

## Key Design Decisions

| Decision | Rationale |
|---|---|
| **Snorkel-style code tools** (`citation_checker`, `snorkel_rubric_evaluator`) | Deterministic labeling functions — zero hallucination risk in scoring |
| **splitInBatches (batchSize: 1)** | Per-question evaluation loop within a single workflow, no sub-workflow overhead |
| **Structured Output Parser** on both agents | Enforces JSON schema on LLM outputs, prevents downstream parse failures |
| **90% pass-rate gate** | Industry threshold before promoting an agent's eval run to "production ready" |
| **n8n Form (page operation)** | Pauses workflow execution mid-run for synchronous human expert input |
| **Dual triggers** (schedule + webhook) | Supports both automated daily runs and on-demand PDF uploads |

## Prerequisites

### n8n Credentials
1. **OpenAI API** — for GPT-4o (question generator + evaluator)
2. **Supabase** — for golden dataset logging

### Environment Variables
Set in your n8n instance:
```
TARGET_AGENT_API_KEY=<your-rag-agent-api-key>
```

### Supabase Tables
Run `supabase_schema.sql` in your Supabase SQL editor to create the required tables:
- `eval_results` — production-ready run summaries
- `expert_corrections` — golden dataset corrections from human experts

### Target RAG Agent
Update the **"Call Target RAG Agent"** HTTP Request node with your agent's actual endpoint URL. The node sends:
```json
{
  "question": "<generated question>",
  "session_id": "<question-id>",
  "mode": "document_qa"
}
```
and expects a response with an `answer`, `output`, or `response` field.

## Scoring Logic

The `Programmatic Evaluator Agent` calls two deterministic tools:

**`citation_checker`** (weight: 40%)
- Regex-matches `[Page N]`, `[Section N.N]`, `[Clause N.N]`, `(p. N)` patterns
- `citation_score` = `min(100, count * 25)`

**`snorkel_rubric_evaluator`** (weight: 60%)
- `+25` — response has >30 words (completeness)
- `+35` — response mentions required sections
- `+25` — conflict resolution language present (`however`, `notwithstanding`, etc.)
- `+15` — legal precision language (`shall`, `must`, `liable`, etc.)

```
final_score = (citation_score × 0.4) + (rubric_score × 0.6)
passed      = final_score ≥ 75
```

**Pass rate** = `(passed_count / total_questions) × 100`

## Deployment

### Option A: Import from JSON
1. Open your n8n instance
2. Go to **Workflows → Import**
3. Upload `workflow.json`
4. Configure credentials and the target agent URL

### Option B: Rebuild from SDK Source
```bash
# Requires n8n-mcp MCP server + czlonkowski/n8n-skills
# In a Claude Code session with n8n-mcp active:
create_workflow_from_code --file workflow_sdk_source.js
```

### Option C: Use the live n8n Cloud instance
The workflow is already deployed at:
```
https://aravind5.app.n8n.cloud/workflow/CzPeQdps0o9VB9Ym
```

## Webhook Endpoint
When active, the PDF upload webhook is available at:
```
POST https://aravind5.app.n8n.cloud/webhook/snorkel-eval-upload
Content-Type: multipart/form-data

# Body: binary PDF file
```

## Files

| File | Description |
|---|---|
| `workflow.json` | n8n workflow export — import directly into any n8n instance |
| `workflow_sdk_source.js` | TypeScript/JS source using the n8n Workflow SDK — rebuild programmatically |
| `supabase_schema.sql` | SQL DDL for `eval_results` and `expert_corrections` tables |

## Related

- [Snorkel AI](https://snorkel.ai) — programmatic labeling methodology that inspired this design
- [n8n](https://n8n.io) — workflow automation platform
- [czlonkowski/n8n-skills](https://github.com/czlonkowski/n8n-skills) — Claude Code skills used to build this workflow
