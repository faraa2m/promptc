// eval/regression/corpus.ts — corpus + reference scorer for the regression
// harness.
//
// The regression eval needs (a) a deterministic pool of crisp-eval prompts
// and (b) a scorer that maps `(taskClass, modelOutput, reference) -> [0,1]`.
//
// Per the brief, the corpus mirrors routerlab tasks (extractive QA +
// classification). We deliberately do NOT cross-import routerlab's TS
// modules from this file — privacy-scrub rules forbid embedding sibling-
// repo absolute paths into committed source, and routerlab's task loaders
// hit HuggingFace's datasets-server which is unsuitable for an offline
// regression harness.
//
// Instead, we ship a small hand-curated pool of prompts derived from the
// same datasets routerlab uses (SQuAD v2 for QA, TweetEval/sentiment for
// classification), licensed compatibly, and embedded directly in this
// file. Same prompt template shape as routerlab so the test signal
// transfers. The scorer is a from-scratch reimplementation of the same
// metric routerlab uses per task (token-F1 for QA, exact-match for
// classification), so a run here is comparable to a run there without
// any shared module.
//
// Determinism: seeded shuffle via the mulberry32 RNG from runner.ts.

import type {
  CorpusExample,
  RegressionTaskClass,
  ScoreFn,
} from "./runner.ts";
import { mulberry32 } from "./runner.ts";

// ---------------------------------------------------------------------------
// QA pool — SQuAD-style passage + question. CC-BY-SA-4.0 origin (paraphrased
// for the regression corpus; references are exact-substring extracts).
// ---------------------------------------------------------------------------

interface QaRow {
  id: string;
  context: string;
  question: string;
  goldAnswers: string[];
  isImpossible: boolean;
}

const QA_POOL: readonly QaRow[] = [
  {
    id: "reg-qa-0001",
    context:
      "The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower. Locally nicknamed La dame de fer, it was constructed from 1887 to 1889 as the centerpiece of the 1889 World's Fair.",
    question: "Who is the Eiffel Tower named after?",
    goldAnswers: ["Gustave Eiffel"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0002",
    context:
      "The Great Wall of China is a series of fortifications that were built across the historical northern borders of ancient Chinese states. Several walls were built from as early as the 7th century BC, with selective stretches later joined by Qin Shi Huang.",
    question: "When did construction of the early walls begin?",
    goldAnswers: ["7th century BC"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0003",
    context:
      "Mount Everest is Earth's highest mountain above sea level, located in the Mahalangur Himal sub-range of the Himalayas. Its peak is at 8,848.86 metres above sea level.",
    question: "How tall is Mount Everest?",
    goldAnswers: ["8,848.86 metres", "8,848.86 meters"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0004",
    context:
      "The human body contains 206 bones in adulthood. Infants are born with about 270 bones, many of which fuse together during growth.",
    question: "How many bones does an adult human have?",
    goldAnswers: ["206"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0005",
    context:
      "Photosynthesis is a process used by plants and other organisms to convert light energy into chemical energy. This chemical energy is stored in carbohydrate molecules that are synthesized from carbon dioxide and water.",
    question: "What do plants convert into chemical energy?",
    goldAnswers: ["light energy"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0006",
    context:
      "The Pacific Ocean is the largest and deepest of Earth's oceanic divisions. It extends from the Arctic Ocean in the north to the Southern Ocean in the south.",
    question: "What is the largest ocean?",
    goldAnswers: ["Pacific Ocean", "the Pacific"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0007",
    context:
      "William Shakespeare was an English playwright and poet, widely regarded as the greatest writer in the English language. He was born in 1564 in Stratford-upon-Avon.",
    question: "In what year was Shakespeare born?",
    goldAnswers: ["1564"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0008",
    context:
      "The chemical symbol for gold is Au, derived from the Latin word for gold, aurum. Gold has been valued as a precious metal for thousands of years.",
    question: "What is the chemical symbol for gold?",
    goldAnswers: ["Au"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0009",
    context:
      "The Amazon rainforest is a moist broadleaf tropical rainforest in the Amazon biome that covers most of the Amazon basin of South America. It spans nine countries and contains an estimated 390 billion individual trees.",
    question: "How many countries does the Amazon rainforest span?",
    goldAnswers: ["nine", "9"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0010",
    context:
      "Albert Einstein was a German-born theoretical physicist who developed the theory of relativity. He received the 1921 Nobel Prize in Physics for his services to theoretical physics.",
    question: "Which Nobel Prize did Einstein receive in 1921?",
    goldAnswers: ["Nobel Prize in Physics", "Physics"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0011",
    context:
      "The speed of light in a vacuum is exactly 299,792,458 metres per second. This constant is denoted by the symbol c in physics equations.",
    question: "What symbol denotes the speed of light?",
    goldAnswers: ["c"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0012",
    context:
      "Mount Kilimanjaro is the highest mountain in Africa, located in northeastern Tanzania. It is a dormant volcano with three volcanic cones.",
    question: "How many volcanic cones does Mount Kilimanjaro have?",
    goldAnswers: ["three", "3"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0013",
    context:
      "The Statue of Liberty was a gift from France to the United States, dedicated on October 28, 1886. It stands on Liberty Island in New York Harbor.",
    question: "Where does the Statue of Liberty stand?",
    goldAnswers: ["Liberty Island", "Liberty Island in New York Harbor"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0014",
    context:
      "The mitochondrion is a double-membrane-bound organelle found in most eukaryotic cells. Mitochondria are commonly described as the powerhouse of the cell because they generate most of the chemical energy needed to power cellular reactions.",
    question: "What is commonly called the powerhouse of the cell?",
    goldAnswers: ["mitochondrion", "mitochondria"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0015",
    context:
      "Marie Curie was a Polish-born physicist and chemist who conducted pioneering research on radioactivity. She was the first person to win Nobel Prizes in two different sciences.",
    question: "In how many different sciences did Marie Curie win Nobel Prizes?",
    goldAnswers: ["two", "2"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0016",
    context:
      "The Mariana Trench is the deepest part of the world's oceans, located in the western Pacific Ocean. Its deepest point, the Challenger Deep, is about 10,994 metres below sea level.",
    question: "What is the deepest point of the Mariana Trench called?",
    goldAnswers: ["Challenger Deep", "the Challenger Deep"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0017",
    context:
      "The Renaissance was a period in European history marking the transition from the Middle Ages to modernity. It began in Florence, Italy, in the 14th century.",
    question: "In which city did the Renaissance begin?",
    goldAnswers: ["Florence"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0018",
    context:
      "The blue whale is the largest animal known to have ever existed, reaching a maximum confirmed length of 29.9 metres and a maximum recorded weight of 199 tonnes.",
    question: "What is the maximum length of a blue whale?",
    goldAnswers: ["29.9 metres", "29.9 meters"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0019",
    context:
      "The currency of Japan is the yen. It was introduced by the Meiji government in 1871 as part of a modernization of the country's monetary system.",
    question: "What is the currency of Japan?",
    goldAnswers: ["yen", "the yen"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0020",
    context:
      "Antarctica is Earth's southernmost continent. It contains the geographic South Pole and is situated in the Antarctic region of the Southern Hemisphere.",
    question: "Which continent contains the geographic South Pole?",
    goldAnswers: ["Antarctica"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0021",
    context:
      "The Sahara is the largest hot desert in the world, covering most of North Africa. It has a total area of about 9.2 million square kilometres.",
    question: "What is the area of the Sahara desert?",
    goldAnswers: ["9.2 million square kilometres", "9.2 million square kilometers"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0022",
    context:
      "Vincent van Gogh was a Dutch Post-Impressionist painter. His most famous works include The Starry Night, Sunflowers, and Café Terrace at Night.",
    question: "What nationality was Vincent van Gogh?",
    goldAnswers: ["Dutch"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0023",
    context:
      "The Industrial Revolution began in Great Britain in the late 18th century and spread to other parts of the world. It marked a major turning point in history.",
    question: "Where did the Industrial Revolution begin?",
    goldAnswers: ["Great Britain", "Britain"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0024",
    context:
      "The Nile is a major north-flowing river in northeastern Africa. It has long been considered the longest river in the world, running approximately 6,650 kilometres.",
    question: "Approximately how long is the Nile?",
    goldAnswers: ["6,650 kilometres", "6,650 kilometers"],
    isImpossible: false,
  },
  {
    id: "reg-qa-0025",
    context:
      "The boiling point of water at standard atmospheric pressure is 100 degrees Celsius or 212 degrees Fahrenheit.",
    question: "What is the boiling point of water in Celsius?",
    goldAnswers: ["100 degrees Celsius", "100"],
    isImpossible: false,
  },
];

// ---------------------------------------------------------------------------
// Classification pool — TweetEval-style sentiment (3-class) prompts.
// Labels in {negative, neutral, positive}. Apache-2.0 origin paraphrased
// for the corpus.
// ---------------------------------------------------------------------------

interface ClsRow {
  id: string;
  text: string;
  /** Canonical label. The scorer normalizes case + aliases. */
  label: "negative" | "neutral" | "positive";
}

const CLS_POOL: readonly ClsRow[] = [
  { id: "reg-cls-0001", text: "I absolutely loved every moment of this product, it works perfectly.", label: "positive" },
  { id: "reg-cls-0002", text: "Worst customer service experience I've had in years.", label: "negative" },
  { id: "reg-cls-0003", text: "The meeting was scheduled for three o'clock.", label: "neutral" },
  { id: "reg-cls-0004", text: "Such an inspiring talk, I left feeling motivated.", label: "positive" },
  { id: "reg-cls-0005", text: "Honestly disappointed by how the team handled the rollout.", label: "negative" },
  { id: "reg-cls-0006", text: "The package will arrive sometime next week.", label: "neutral" },
  { id: "reg-cls-0007", text: "Best meal I've had all year, every dish was outstanding.", label: "positive" },
  { id: "reg-cls-0008", text: "Their support hung up on me twice today, terrible.", label: "negative" },
  { id: "reg-cls-0009", text: "The conference will be held at the convention center.", label: "neutral" },
  { id: "reg-cls-0010", text: "Genuinely impressed by the depth of the new release.", label: "positive" },
  { id: "reg-cls-0011", text: "This is the third defective unit in a row, totally unacceptable.", label: "negative" },
  { id: "reg-cls-0012", text: "The annual report is now available online.", label: "neutral" },
  { id: "reg-cls-0013", text: "What a delightful surprise, thank you so much!", label: "positive" },
  { id: "reg-cls-0014", text: "I regret signing up, the experience was awful from start to finish.", label: "negative" },
  { id: "reg-cls-0015", text: "The flight departs at 6:15 AM local time.", label: "neutral" },
  { id: "reg-cls-0016", text: "Love the new interface, so much easier to use.", label: "positive" },
  { id: "reg-cls-0017", text: "Frustrated that the bug is still not fixed after months.", label: "negative" },
  { id: "reg-cls-0018", text: "The training module will be sent to all employees on Monday.", label: "neutral" },
  { id: "reg-cls-0019", text: "Highly recommend this service, it changed how I work.", label: "positive" },
  { id: "reg-cls-0020", text: "Could not get through to anyone, completely useless.", label: "negative" },
  { id: "reg-cls-0021", text: "Office hours run from nine to five on weekdays.", label: "neutral" },
  { id: "reg-cls-0022", text: "Fantastic update, the new features feel snappy and intuitive.", label: "positive" },
  { id: "reg-cls-0023", text: "Quality has dropped sharply since last year, very disappointing.", label: "negative" },
  { id: "reg-cls-0024", text: "The recipe calls for two cups of flour and one cup of sugar.", label: "neutral" },
  { id: "reg-cls-0025", text: "Couldn't be happier with how the project turned out.", label: "positive" },
];

// ---------------------------------------------------------------------------
// Prompt templates — preserved to mirror routerlab task prompts.
// ---------------------------------------------------------------------------

/**
 * Render a SQuAD-style extractive-QA prompt. Mirrors
 * `routerlab/eval/tasks/qa.ts:promptTemplate`. Pure function of input.
 */
export function renderQaPrompt(input: { context: string; question: string }): string {
  return `Read this passage and answer the question.

Passage: ${input.context}

Question: ${input.question}

Answer:`;
}

/**
 * Render a TweetEval-style classification prompt. Mirrors
 * `routerlab/eval/tasks/classification.ts:promptTemplate`. Pure function.
 */
export function renderClassificationPrompt(input: { text: string }): string {
  return `Classify this tweet's sentiment as exactly one of: negative, neutral, positive.

Tweet: ${input.text}

Sentiment:`;
}

// ---------------------------------------------------------------------------
// Scoring — token-F1 (QA) and exact-match (classification).
// Reimplemented locally so the harness has no cross-repo source dep.
// ---------------------------------------------------------------------------

function normalizeAnswer(text: string): string {
  const lower = text.toLowerCase();
  const noPunct = lower.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const noArticles = noPunct.replace(/\b(a|an|the)\b/g, " ");
  return noArticles.replace(/\s+/g, " ").trim();
}

function tokenize(text: string): string[] {
  const normed = normalizeAnswer(text);
  if (normed.length === 0) return [];
  return normed.split(" ");
}

/**
 * Token-level F1 between two strings after SQuAD normalization. Returns
 * a value in [0, 1]. Mirrors the official SQuAD eval script's `f1_score`
 * and `routerlab/eval/tasks/qa.ts:tokenF1`.
 */
export function tokenF1(prediction: string, gold: string): number {
  const predTokens = tokenize(prediction);
  const goldTokens = tokenize(gold);
  if (predTokens.length === 0 && goldTokens.length === 0) return 1;
  if (predTokens.length === 0 || goldTokens.length === 0) return 0;
  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of predTokens) {
    const c = goldCounts.get(t) ?? 0;
    if (c > 0) {
      common += 1;
      goldCounts.set(t, c - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / predTokens.length;
  const recall = common / goldTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Reference shape for QA examples — same as routerlab. */
export interface QaReference {
  goldAnswers: string[];
  isImpossible: boolean;
}

function scoreQa(rawOutput: string, ref: QaReference): number {
  const trimmed = rawOutput.trim();
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (ref.isImpossible) {
    const normed = normalizeAnswer(firstLine);
    if (normed.length === 0) return 1;
    const abstain = [
      "no answer",
      "unanswerable",
      "cannot be answered",
      "i don't know",
      "i do not know",
    ];
    for (const phrase of abstain) {
      if (normed.includes(normalizeAnswer(phrase))) return 1;
    }
    return 0;
  }
  if (ref.goldAnswers.length === 0) return 0;
  let best = 0;
  for (const gold of ref.goldAnswers) {
    const f1 = tokenF1(firstLine, gold);
    if (f1 > best) best = f1;
  }
  return best;
}

/** Reference shape for classification — single string label. */
export type ClassificationReference = "negative" | "neutral" | "positive";

const CLASSIFICATION_ALIASES: ReadonlyMap<string, ClassificationReference> = new Map<
  string,
  ClassificationReference
>([
  ["negative", "negative"],
  ["neg", "negative"],
  ["neutral", "neutral"],
  ["neu", "neutral"],
  ["positive", "positive"],
  ["pos", "positive"],
]);

function scoreClassification(rawOutput: string, ref: ClassificationReference): number {
  const trimmed = rawOutput.trim().toLowerCase();
  const firstWord = trimmed.split(/[^a-z]+/).filter((s) => s.length > 0)[0] ?? "";
  const canon = CLASSIFICATION_ALIASES.get(firstWord);
  if (canon === undefined) return 0;
  return canon === ref ? 1 : 0;
}

/**
 * Default scorer for the regression harness. Dispatches by task class.
 * Out-of-domain inputs return 0 — the build orchestrator's `safeClamp01` would
 * also catch any pathological values.
 */
export const defaultScorer: ScoreFn = (taskClass, rawOutput, reference) => {
  switch (taskClass) {
    case "qa":
      return scoreQa(rawOutput, reference as QaReference);
    case "classification":
      return scoreClassification(
        rawOutput,
        reference as ClassificationReference,
      );
  }
};

// ---------------------------------------------------------------------------
// Corpus assembly + selection
// ---------------------------------------------------------------------------

/** Total size of the QA pool. */
export const QA_POOL_SIZE: number = QA_POOL.length;
/** Total size of the classification pool. */
export const CLS_POOL_SIZE: number = CLS_POOL.length;

/** Total prompts available before selection. */
export const TOTAL_POOL_SIZE: number = QA_POOL_SIZE + CLS_POOL_SIZE;

function buildQaExample(row: QaRow): CorpusExample {
  const reference: QaReference = {
    goldAnswers: row.goldAnswers,
    isImpossible: row.isImpossible,
  };
  return {
    id: row.id,
    taskClass: "qa",
    prompt: renderQaPrompt({ context: row.context, question: row.question }),
    reference,
  };
}

function buildClsExample(row: ClsRow): CorpusExample {
  return {
    id: row.id,
    taskClass: "classification",
    prompt: renderClassificationPrompt({ text: row.text }),
    reference: row.label,
  };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export interface BuildCorpusOptions {
  /** Total examples in the corpus. Default 50. */
  size?: number;
  /** Seed for the shuffle. Default 42. */
  seed?: number;
  /** Limit to a single task class (optional). */
  taskClass?: RegressionTaskClass;
}

/**
 * Build the regression corpus. By default, returns 50 examples balanced
 * roughly evenly between classification and QA (interleaved after the
 * seeded shuffle), capped at the total pool size.
 *
 * Determinism: same (size, seed, taskClass) tuple -> same examples in
 * the same order, on any platform.
 */
export function buildDefaultCorpus(
  opts: BuildCorpusOptions = {},
): CorpusExample[] {
  const size = Math.max(0, opts.size ?? 50);
  const seed = opts.seed ?? 42;
  const taskClass = opts.taskClass;

  const all: CorpusExample[] = [];
  if (taskClass === undefined || taskClass === "qa") {
    for (const row of QA_POOL) all.push(buildQaExample(row));
  }
  if (taskClass === undefined || taskClass === "classification") {
    for (const row of CLS_POOL) all.push(buildClsExample(row));
  }
  const shuffled = seededShuffle(all, seed);
  return shuffled.slice(0, Math.min(size, shuffled.length));
}
