/**
 * RAG Evaluation — generate answers from retrieved context and judge quality.
 *
 * Uses the same AgentProcess/Claude CLI pattern as the rest of the product:
 * short instruction via `-p`, long context via `--project-prompt`,
 * stream-json output parsed for result + cost.
 */

import { spawn } from 'node:child_process';
import type { ScoredChunk } from './types';
import type { RetrievalMode } from './retriever.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnswerResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  contextTokens: number;
}

export interface JudgeScore {
  correctness: number;
  completeness: number;
  groundedness: number;
  hallucination_count?: number;
  similarity?: number;
  overall: number;
  reasoning: string;
}

export interface JudgeResult {
  scores: Record<string, JudgeScore>;
  expertAnswer?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Claude CLI helper — same pattern as AgentProcess
// ---------------------------------------------------------------------------

const CLAUDE_BIN = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';

interface ClaudeResult {
  result: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Run Claude CLI with short prompt via `-p` and long context via `--project-prompt`.
 * Same split used by spawnQuickAction: -p gets the instruction, --project-prompt gets the context.
 * Uses `--output-format stream-json` and parses the result message.
 */
async function runClaude(
  prompt: string,
  projectPrompt: string,
  opts?: { model?: string },
): Promise<ClaudeResult> {
  const model = opts?.model ?? 'claude-sonnet-4-6';

  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--system-prompt', projectPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', '1',
      '--model', model,
      '--permission-mode', 'bypassPermissions',
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdin?.end();

    let buffer = '';
    let fullText = '';
    let resultData: ClaudeResult | null = null;

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Claude CLI timed out after 300s'));
    }, 600_000);

    proc.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);

          // Collect text content
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                fullText += block.text;
              }
            }
          }

          // Result message — has cost + usage
          if (msg.type === 'result') {
            resultData = {
              result: msg.result ?? fullText,
              costUsd: msg.total_cost_usd ?? 0,
              inputTokens: msg.usage?.input_tokens ?? 0,
              outputTokens: msg.usage?.output_tokens ?? 0,
              durationMs: msg.duration_ms ?? 0,
            };
          }
        } catch { /* skip unparseable lines */ }
      }
    });

    let stderr = '';
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (resultData) {
        resolve(resultData);
      } else if (code === 0 && fullText) {
        resolve({ result: fullText, costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 });
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Answer Generation
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM = `You are a code expert answering questions about a codebase.
Rules:
- Answer using ONLY the provided code context in your project prompt.
- If the context doesn't contain enough information, say so explicitly.
- Be specific — reference file paths, function names, and line numbers when relevant.
- Keep your answer concise (2-4 paragraphs max).
- Do NOT make up information not present in the context.
- Do NOT use any tools. Just answer from the context provided.`;

export async function generateAnswer(
  query: string,
  chunks: ScoredChunk[],
  graphContext: string,
  opts?: { model?: string },
): Promise<AnswerResult> {
  // Build context for --project-prompt (long, goes in project prompt)
  const contextParts: string[] = [];
  if (graphContext) {
    contextParts.push(`## Structural Context\n${graphContext}`);
  }
  for (const sc of chunks) {
    contextParts.push(
      `## ${sc.chunk.filePath} (${sc.chunk.entityType}: ${sc.chunk.entityName ?? 'anonymous'})\n\`\`\`${sc.chunk.language}\n${sc.chunk.content}\n\`\`\``,
    );
  }
  const contextText = contextParts.join('\n\n');
  const contextTokens = Math.ceil(contextText.length / 4);

  const projectPrompt = `${ANSWER_SYSTEM}\n\n# Code Context\n\n${contextText}`;

  // Short instruction via -p
  const prompt = `Answer this question using ONLY the code context in your project prompt:\n\n${query}`;

  const result = await runClaude(prompt, projectPrompt, { model: opts?.model });

  return {
    answer: result.result,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    model: opts?.model ?? 'claude-sonnet-4-6',
    contextTokens,
  };
}

// ---------------------------------------------------------------------------
// Judge Evaluation
// ---------------------------------------------------------------------------

const MODE_LABELS: Record<string, string> = {
  'vector': 'Vector (semantic similarity)',
  'bm25': 'BM25 (keyword matching)',
  'vector+bm25': 'Vector + BM25 (hybrid)',
  'vector+graph': 'Vector + Graph (structural)',
  'vector+bm25+graph': 'Full Hybrid (vector + BM25 + graph)',
};

export async function judgeAnswers(
  query: string,
  answers: Record<string, string>,
  referenceAnswer?: string,
  opts?: { model?: string },
): Promise<JudgeResult> {
  const answerSection = Object.entries(answers)
    .map(([mode, answer]) => `### ${MODE_LABELS[mode] ?? mode}\n${answer}`)
    .join('\n\n');

  const refSection = referenceAnswer
    ? `\n## Reference Answer (ground truth)\n${referenceAnswer}\n`
    : '';

  const similarityInstruction = referenceAnswer
    ? '\n- **similarity** (1-10): How close is this answer to the reference answer in meaning and coverage?'
    : '';

  const similarityJson = referenceAnswer ? ', "similarity": <1-10>' : '';

  // Long content goes in --project-prompt
  const projectPrompt = `You are an expert evaluator of code search and RAG quality. Always respond with valid JSON only.\n\n## Question\n${query}\n${refSection}\n## Answers to Evaluate\n\n${answerSection}`;

  // Short instruction via -p
  const prompt = `Score each answer in your project prompt. Dimensions (1-10 each):
- correctness: Is the answer factually accurate?
- completeness: Does it cover all aspects?
- groundedness: Is every claim supported by code context?${similarityInstruction}

Respond with ONLY valid JSON:
{
  ${Object.keys(answers).map((mode) => `"${mode}": { "correctness": <1-10>, "completeness": <1-10>, "groundedness": <1-10>${similarityJson}, "reasoning": "<1-2 sentences>" }`).join(',\n  ')}
}`;

  const result = await runClaude(prompt, projectPrompt, { model: opts?.model });

  // Parse JSON from response
  let scoresRaw = result.result.trim();
  if (scoresRaw.startsWith('```')) {
    scoresRaw = scoresRaw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: Record<string, { correctness: number; completeness: number; groundedness: number; similarity?: number; reasoning: string }>;
  try {
    parsed = JSON.parse(scoresRaw);
  } catch {
    parsed = {};
    for (const mode of Object.keys(answers)) {
      parsed[mode] = { correctness: 5, completeness: 5, groundedness: 5, reasoning: 'Judge output could not be parsed' };
    }
  }

  const scores: Record<string, JudgeScore> = {};
  for (const [mode, raw] of Object.entries(parsed)) {
    const dims = [raw.correctness, raw.completeness, raw.groundedness];
    if (raw.similarity !== undefined) dims.push(raw.similarity);
    const overall = dims.reduce((s, v) => s + v, 0) / dims.length;
    scores[mode] = {
      correctness: raw.correctness,
      completeness: raw.completeness,
      groundedness: raw.groundedness,
      similarity: raw.similarity,
      overall: Math.round(overall * 10) / 10,
      reasoning: raw.reasoning,
    };
  }

  return {
    scores,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    model: opts?.model ?? 'claude-sonnet-4-6',
  };
}

// ---------------------------------------------------------------------------
// Expert Judge — reads the actual code, writes its own answer, then scores
// ---------------------------------------------------------------------------

const EXPERT_JUDGE_SYSTEM = `You are an expert code reviewer and evaluator. You will be given:
1. Actual source code from the codebase (this is the ground truth)
2. A question about the code
3. Five candidate answers generated by different retrieval strategies

Your job:

STEP 1: Read ALL the source code carefully. Write your own comprehensive, accurate answer to the question based on what you see in the code. This is your expert reference answer. Be thorough — cover every relevant function, file, and data flow you can find in the provided code.

STEP 2: Score each of the 5 candidate answers by comparing them against the source code AND your expert answer.

Scoring dimensions (1-10 each):
- **correctness**: Does the answer accurately describe what the code actually does? Deduct for any incorrect claim about function behavior, data flow, or logic.
- **completeness**: How much of your expert answer does this candidate cover? If your answer has 5 key points and the candidate covers 3, score ~6.
- **groundedness**: Does every specific claim (function names, file paths, behavior descriptions) match the actual source code provided? Deduct heavily for hallucinated names, invented file paths, or fabricated logic.
- **hallucination_count**: Count the number of specific factual claims that are NOT verifiable from the provided source code. A function name that doesn't exist = 1 hallucination. A file path not in the code = 1 hallucination. 0 = perfect.

Respond with ONLY valid JSON (no markdown fences, no explanation outside the JSON):`;

/**
 * Expert judge: retrieves broad context, writes its own gold answer, then scores all 5 answers.
 * More expensive than blind judging (~$0.35-0.55) but produces reliable scores because
 * the judge has read the actual code.
 */
export async function expertJudge(
  query: string,
  answers: Record<string, string>,
  expertChunks: ScoredChunk[],
  opts?: { model?: string },
): Promise<JudgeResult> {
  // Build code context for the judge
  const codeContext = expertChunks
    .map((sc) => `## ${sc.chunk.filePath} (${sc.chunk.entityType}: ${sc.chunk.entityName ?? 'module'})\n\`\`\`${sc.chunk.language}\n${sc.chunk.content}\n\`\`\``)
    .join('\n\n');

  const answerSection = Object.entries(answers)
    .map(([mode, answer]) => `### ${MODE_LABELS[mode] ?? mode}\n${answer}`)
    .join('\n\n');

  // Long context: code + answers
  const projectPrompt = `${EXPERT_JUDGE_SYSTEM}\n\n# Source Code (Ground Truth)\n\n${codeContext}\n\n# Question\n\n${query}\n\n# Candidate Answers to Evaluate\n\n${answerSection}`;

  // Short instruction
  const prompt = `Read the source code in your project prompt, write your expert answer, then score each candidate.

Respond with ONLY this JSON structure:
{
  "expert_answer": "Your comprehensive answer based on the source code...",
  ${Object.keys(answers).map((mode) => `"${mode}": { "correctness": <1-10>, "completeness": <1-10>, "groundedness": <1-10>, "hallucination_count": <0-N>, "reasoning": "<2-3 sentences comparing to source code>" }`).join(',\n  ')}
}`;

  const result = await runClaude(prompt, projectPrompt, { model: opts?.model });

  // Parse JSON
  let scoresRaw = result.result.trim();
  if (scoresRaw.startsWith('```')) {
    scoresRaw = scoresRaw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(scoresRaw);
  } catch {
    // Fallback — try to extract JSON from the response
    const jsonMatch = scoresRaw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch { parsed = {}; }
    } else {
      parsed = {};
    }
  }

  const expertAnswer = typeof parsed.expert_answer === 'string' ? parsed.expert_answer : undefined;

  const scores: Record<string, JudgeScore> = {};
  for (const mode of Object.keys(answers)) {
    const raw = parsed[mode];
    if (raw && typeof raw === 'object') {
      const dims = [raw.correctness ?? 5, raw.completeness ?? 5, raw.groundedness ?? 5];
      const overall = dims.reduce((s: number, v: number) => s + v, 0) / dims.length;
      scores[mode] = {
        correctness: raw.correctness ?? 5,
        completeness: raw.completeness ?? 5,
        groundedness: raw.groundedness ?? 5,
        hallucination_count: typeof raw.hallucination_count === 'number' ? raw.hallucination_count : undefined,
        overall: Math.round(overall * 10) / 10,
        reasoning: raw.reasoning ?? 'No reasoning provided',
      };
    } else {
      scores[mode] = { correctness: 5, completeness: 5, groundedness: 5, overall: 5, reasoning: 'Judge output missing for this mode' };
    }
  }

  return {
    scores,
    expertAnswer,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    model: opts?.model ?? 'claude-sonnet-4-6',
  };
}
