/**
 * Snorkel RAG Evaluation Pipeline — n8n Workflow SDK Source
 *
 * Build tool: n8n Workflow SDK  (@n8n/workflow-sdk)
 * Platform:   n8n Cloud / self-hosted n8n >= 1.70
 *
 * To recreate this workflow in your own n8n instance:
 *   1. Install the n8n-mcp MCP server and czlonkowski/n8n-skills
 *   2. Paste this file into a Claude Code session with n8n-mcp active
 *   3. Run: create_workflow_from_code with this code
 */

import { workflow, node, trigger, sticky, languageModel, tool, outputParser, switchCase, splitInBatches, nextBatch, expr, newCredential, placeholder } from '@n8n/workflow-sdk';

// ── LANGUAGE MODELS ───────────────────────────────────────────────────────────
const gpt4oGenerator = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'GPT-4o (Question Generator)',
    parameters: { temperature: 0.7 },
    credentials: { openAiApi: newCredential('OpenAI API') }
  }
});

const gpt4oEvaluator = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'GPT-4o (Programmatic Evaluator)',
    parameters: { temperature: 0 },
    credentials: { openAiApi: newCredential('OpenAI API') }
  }
});

// ── OUTPUT PARSERS ─────────────────────────────────────────────────────────────
const questionSetParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Question Set Schema',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: '{"questions":[{"id":"q1","question":"According to Section 4, what is the liability cap and does it conflict with Section 9?","source_sections":["Section 4","Section 9"],"complexity":"multi-turn","expected_citation":"[Section 4.2]"}]}'
    }
  }
});

const evalResultParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Eval Result Schema',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: '{"question_id":"q1","score":78,"passed":false,"citations_valid":true,"rubric_match":false,"failure_mode":"wrong_section_referenced","reasoning":"Agent cited Section 4 but missed the Section 9 conflict."}'
    }
  }
});

// ── CODE TOOLS (Snorkel-style programmatic labeling functions) ────────────────
const citationCheckerTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolCode',
  version: 1.3,
  config: {
    name: 'citation_checker',
    parameters: {
      description: 'Deterministically checks if an agent response contains valid source citations like [Page X] or [Section Y]. Input: the agent response string. Returns JSON: {citation_found, citations_list, citation_score (0-100)}.',
      language: 'javaScript',
      jsCode: 'const response = query;\nconst patterns = [/\\[Page\\s+\\d+\\]/gi, /\\[Section\\s+[\\d.]+\\]/gi, /\\[Clause\\s+[\\d.]+\\]/gi, /\\(p\\.\\s*\\d+\\)/gi];\nconst found = [];\nfor (const p of patterns) { const m = response.match(p) || []; found.push(...m); }\nconst unique = [...new Set(found)];\nreturn JSON.stringify({ citation_found: unique.length > 0, citations_list: unique, citation_score: Math.min(100, unique.length * 25) });'
    }
  }
});

const rubricEvaluatorTool = tool({
  type: '@n8n/n8n-nodes-langchain.toolCode',
  version: 1.3,
  config: {
    name: 'snorkel_rubric_evaluator',
    parameters: {
      description: 'Evaluates agent response against Snorkel compliance rubrics. Input JSON string: {"response":"<agent answer>","expected_sections":["Section 4","Section 9"]}. Returns {rubric_score (0-100), rubric_passed, grade (PASS/MARGINAL/FAIL), details}.',
      language: 'javaScript',
      jsCode: 'const input = JSON.parse(query);\nconst { response = "", expected_sections = [] } = input;\nlet score = 0;\nconst completeness = response.split(" ").length > 30;\nconst sectionCoverage = expected_sections.some(s => response.toLowerCase().includes(s.toLowerCase()));\nconst conflictResolution = /however|conflict|supersede|notwithstanding|despite/i.test(response);\nconst legalPrecision = /shall|must|liable|obligation|breach/i.test(response);\nif (completeness) score += 25;\nif (sectionCoverage) score += 35;\nif (conflictResolution) score += 25;\nif (legalPrecision) score += 15;\nreturn JSON.stringify({ rubric_score: score, rubric_passed: score >= 60, grade: score >= 80 ? "PASS" : score >= 60 ? "MARGINAL" : "FAIL", details: { completeness, section_coverage: sectionCoverage, conflict_resolution: conflictResolution, legal_precision: legalPrecision } });'
    }
  }
});

// ── TRIGGERS ──────────────────────────────────────────────────────────────────
const dailySchedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Daily Evaluation Schedule',
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1 }] } }
  }
});

const pdfUploadWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'PDF Upload Trigger',
    parameters: { httpMethod: 'POST', responseMode: 'responseNode', path: 'snorkel-eval-upload' }
  }
});

// ── STEP 1: EXTRACT PDF ───────────────────────────────────────────────────────
const extractPdfContent = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: { name: 'Extract PDF Content', parameters: { operation: 'pdf' } }
});

// ── STEP 2: PREPARE EVAL CONTEXT ──────────────────────────────────────────────
const prepareEvalContext = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Prepare Eval Context',
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'doc-text', name: 'document_text', value: expr('{{ $json.text }}'), type: 'string' },
          { id: 'eval-run-id', name: 'eval_run_id', value: expr('{{ $execution.id }}'), type: 'string' },
          { id: 'doc-source', name: 'document_source', value: expr('{{ $json.metadata?.source ?? "uploaded_document" }}'), type: 'string' },
          { id: 'started-at', name: 'started_at', value: expr('{{ $now.toISO() }}'), type: 'string' }
        ]
      }
    }
  }
});

// ── STEP 3: SYNTHETIC DATA GENERATOR AGENT ────────────────────────────────────
const syntheticDataGeneratorAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Synthetic Eval Data Generator',
    parameters: {
      promptType: 'define',
      systemMessage: 'You are an expert AI evaluation engineer for Snorkel AI, specializing in adversarial test generation for enterprise RAG systems. Always return structured JSON with a questions array.',
      text: expr(
        'Generate exactly 10 intricate evaluation questions from this legal document.\n\n' +
        'DOCUMENT TEXT:\n{{ $json.document_text }}\n\n' +
        'Return structured JSON with a questions array.'
      ),
      hasOutputParser: true
    },
    subnodes: { model: gpt4oGenerator, outputParser: questionSetParser }
  }
});

// ── STEP 4: SPLIT QUESTIONS ───────────────────────────────────────────────────
const splitQuestionsIntoItems = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: {
    name: 'Split Questions Into Items',
    parameters: { fieldToSplitOut: 'output.questions', include: 'allOtherFields' }
  }
});

// ── STEP 5: PER-QUESTION BATCH LOOP ───────────────────────────────────────────
const questionBatchLoop = splitInBatches({
  version: 3,
  config: { name: 'Evaluate Each Question', parameters: { batchSize: 1 } }
});

// ── STEP 5a: CALL TARGET RAG AGENT ────────────────────────────────────────────
const callTargetRagAgent = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Call Target RAG Agent',
    parameters: {
      method: 'POST',
      url: placeholder('Target RAG Agent URL — e.g. https://your-agent.company.com/api/query'),
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: 'Authorization', value: expr('Bearer {{ $env.TARGET_AGENT_API_KEY }}') }]
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: expr('"keypair"'),
      bodyParameters: {
        parameters: [
          { name: 'question', value: expr('{{ $json.question }}') },
          { name: 'session_id', value: expr('{{ $json.id }}') },
          { name: 'mode', value: 'document_qa' }
        ]
      }
    }
  }
});

// ── STEP 5b-d: EVALUATE ───────────────────────────────────────────────────────
const bundleQA = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Bundle Question and Agent Answer',
    parameters: {
      mode: 'manual', includeOtherFields: true,
      assignments: { assignments: [
        { id: 'agent-answer', name: 'agent_answer', value: expr('{{ $json.answer ?? $json.output ?? $json.response ?? "ERROR: No answer returned" }}'), type: 'string' },
        { id: 'answered-at', name: 'answered_at', value: expr('{{ $now.toISO() }}'), type: 'string' }
      ]}
    }
  }
});

const programmaticEvaluatorAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Programmatic Evaluator Agent',
    parameters: {
      promptType: 'define',
      systemMessage: 'You are a Snorkel AI programmatic evaluator. Call both tools before synthesizing. Return structured evaluation JSON.',
      text: expr(
        'QUESTION: {{ $json.question }}\nAGENT ANSWER: {{ $json.agent_answer }}\n' +
        '1. Call citation_checker\n2. Call snorkel_rubric_evaluator\n' +
        '3. final_score = (citation_score * 0.4) + (rubric_score * 0.6)\n4. passed = final_score >= 75'
      ),
      hasOutputParser: true
    },
    subnodes: { model: gpt4oEvaluator, tools: [citationCheckerTool, rubricEvaluatorTool], outputParser: evalResultParser }
  }
});

const flattenEvalResult = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Flatten Eval Result',
    parameters: {
      mode: 'manual', includeOtherFields: true,
      assignments: { assignments: [
        { id: 'eval-score', name: 'eval_score', value: expr('{{ $json.output.score }}'), type: 'number' },
        { id: 'eval-passed', name: 'eval_passed', value: expr('{{ $json.output.passed }}'), type: 'boolean' },
        { id: 'failure-mode', name: 'failure_mode', value: expr('{{ $json.output.failure_mode ?? "none" }}'), type: 'string' },
        { id: 'eval-reasoning', name: 'eval_reasoning', value: expr('{{ $json.output.reasoning }}'), type: 'string' }
      ]}
    }
  }
});

// ── STEP 6–8: AGGREGATE → SCORE → ROUTE ──────────────────────────────────────
const aggregateEvalResults = node({
  type: 'n8n-nodes-base.aggregate', version: 1,
  config: { name: 'Aggregate All Eval Results', parameters: { aggregate: 'aggregateAllItemData', destinationFieldName: 'eval_results', include: 'allFields' } }
});

const calculatePassRate = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: {
    name: 'Calculate Pass Rate',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: 'const results = $input.all()[0].json.eval_results || [];\nconst total = results.length;\nconst passed = results.filter(r => r.eval_passed === true).length;\nconst passRate = total > 0 ? Math.round((passed / total) * 100) : 0;\nconst avgScore = total > 0 ? Math.round(results.reduce((s, r) => s + (r.eval_score || 0), 0) / total) : 0;\nconst failedItems = results.filter(r => !r.eval_passed).map(r => ({ question: r.question, failure_mode: r.failure_mode, score: r.eval_score, reasoning: r.eval_reasoning }));\nreturn [{ json: { eval_run_id: $input.all()[0].json.eval_run_id || "unknown", total_questions: total, passed_count: passed, failed_count: total - passed, pass_rate: passRate, average_score: avgScore, production_ready: passRate >= 90, failed_items: failedItems, evaluated_at: new Date().toISOString() } }];'
    }
  }
});

const routeByPassRate = switchCase({
  version: 3.2,
  config: {
    name: 'Route by Pass Rate',
    parameters: {
      rules: { values: [
        { outputKey: 'production_ready', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.pass_rate }}'), operator: { type: 'number', operation: 'gte' }, rightValue: 90 }], combinator: 'and' } },
        { outputKey: 'needs_expert_review', conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' }, conditions: [{ leftValue: expr('{{ $json.pass_rate }}'), operator: { type: 'number', operation: 'lt' }, rightValue: 90 }], combinator: 'and' } }
      ]},
      options: { fallbackOutput: 'none' }
    }
  }
});

// ── BRANCH A: PRODUCTION READY ────────────────────────────────────────────────
const logProductionReady = node({
  type: 'n8n-nodes-base.supabase', version: 1,
  config: {
    name: 'Log as Production Ready',
    parameters: {
      resource: 'row', operation: 'create', tableId: 'eval_results', dataToSend: 'defineBelow',
      fieldsUi: { fieldValues: [
        { fieldId: 'eval_run_id', fieldValue: expr('{{ $json.eval_run_id }}') },
        { fieldId: 'pass_rate', fieldValue: expr('{{ $json.pass_rate }}') },
        { fieldId: 'average_score', fieldValue: expr('{{ $json.average_score }}') },
        { fieldId: 'total_questions', fieldValue: expr('{{ $json.total_questions }}') },
        { fieldId: 'passed_count', fieldValue: expr('{{ $json.passed_count }}') },
        { fieldId: 'status', fieldValue: 'PRODUCTION_READY' },
        { fieldId: 'evaluated_at', fieldValue: expr('{{ $json.evaluated_at }}') }
      ]}
    },
    credentials: { supabaseApi: newCredential('Supabase') }
  }
});

// ── BRANCH B: EXPERT CALIBRATION ─────────────────────────────────────────────
const expertAdjudicationForm = node({
  type: 'n8n-nodes-base.form', version: 2.5,
  config: {
    name: 'Expert Adjudication Form',
    parameters: {
      operation: 'page', defineForm: 'fields',
      formFields: { values: [
        { fieldType: 'html', elementName: 'eval_context', html: '<h3>Snorkel AI Expert Calibration Required</h3><p>Pass rate below 90%. Provide corrections to update the golden dataset.</p>' },
        { fieldName: 'eval_run_id', fieldType: 'hiddenField', fieldValue: expr('{{ $json.eval_run_id }}') },
        { fieldName: 'pass_rate', fieldType: 'hiddenField', fieldValue: expr('{{ $json.pass_rate }}') },
        { fieldName: 'failed_count', fieldType: 'hiddenField', fieldValue: expr('{{ $json.failed_count }}') },
        { fieldName: 'root_cause', fieldLabel: 'Root Cause Classification', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Citation Missing' }, { option: 'Wrong Section Referenced' }, { option: 'Multi-hop Reasoning Failure' }, { option: 'Context Window Truncation' }, { option: 'Hallucination' }, { option: 'Edge Case — Rubric needs updating' }] } },
        { fieldName: 'corrected_ground_truth', fieldLabel: 'Corrected Ground Truth Answer', fieldType: 'textarea', placeholder: 'Provide the correct answer with citations...' },
        { fieldName: 'update_training_set', fieldLabel: 'Update Golden Training Dataset?', fieldType: 'dropdown', fieldOptions: { values: [{ option: 'Yes — Add to golden dataset' }, { option: 'No — Edge case only' }, { option: 'Modify Rubric — Update eval criteria' }] } },
        { fieldName: 'expert_notes', fieldLabel: 'Expert Notes', fieldType: 'textarea' }
      ]}
    }
  }
});

const logExpertCorrection = node({
  type: 'n8n-nodes-base.supabase', version: 1,
  config: {
    name: 'Log Expert Correction to Golden Set',
    parameters: {
      resource: 'row', operation: 'create', tableId: 'expert_corrections', dataToSend: 'defineBelow',
      fieldsUi: { fieldValues: [
        { fieldId: 'eval_run_id', fieldValue: expr('{{ $json.eval_run_id }}') },
        { fieldId: 'root_cause', fieldValue: expr('{{ $json.root_cause }}') },
        { fieldId: 'corrected_ground_truth', fieldValue: expr('{{ $json.corrected_ground_truth }}') },
        { fieldId: 'update_training_set', fieldValue: expr('{{ $json.update_training_set }}') },
        { fieldId: 'expert_notes', fieldValue: expr('{{ $json.expert_notes ?? "" }}') },
        { fieldId: 'status', fieldValue: 'EXPERT_REVIEWED' },
        { fieldId: 'submitted_at', fieldValue: expr('{{ $now.toISO() }}') }
      ]}
    },
    credentials: { supabaseApi: newCredential('Supabase') }
  }
});

// ── STICKY NOTE ───────────────────────────────────────────────────────────────
const pipelineNote = sticky(
  '## Snorkel RAG Evaluation Pipeline\n\n' +
  '**Architecture**: Synthetic Generation → Programmatic Eval → Expert Calibration Loop\n\n' +
  '### Prerequisites\n' +
  '- Env var: TARGET_AGENT_API_KEY\n' +
  '- Credentials: OpenAI API, Supabase\n' +
  '- Supabase tables: eval_results, expert_corrections\n\n' +
  '### How It Works\n' +
  '1. PDF uploaded (webhook) or daily schedule fires eval run\n' +
  '2. GPT-4o generates 10 adversarial questions from the document\n' +
  '3. Each question is sent to the target RAG agent under test\n' +
  '4. Programmatic evaluator scores: citation check + rubric compliance\n' +
  '5. Pass rate >= 90% → Production Ready log in Supabase\n' +
  '6. Pass rate < 90% → Expert form pauses execution for human calibration\n' +
  '7. Expert correction logged to golden training dataset in Supabase',
  [], { color: 4 }
);

// ── WORKFLOW COMPOSITION ───────────────────────────────────────────────────────
export default workflow('snorkel-rag-eval-pipeline', 'Snorkel RAG Evaluation Pipeline')
  .add(pipelineNote)
  .add(dailySchedule)
  .to(extractPdfContent)
  .to(prepareEvalContext)
  .to(syntheticDataGeneratorAgent)
  .to(splitQuestionsIntoItems)
  .to(questionBatchLoop
    .onDone(
      aggregateEvalResults
        .to(calculatePassRate)
        .to(routeByPassRate
          .onCase(0, logProductionReady)
          .onCase(1, expertAdjudicationForm.to(logExpertCorrection))
        )
    )
    .onEachBatch(
      callTargetRagAgent
        .to(bundleQA)
        .to(programmaticEvaluatorAgent)
        .to(flattenEvalResult)
        .to(nextBatch(questionBatchLoop))
    )
  )
  .add(pdfUploadWebhook)
  .to(extractPdfContent);
