// Turn a long competition writing prompt into a topic, the issues it raises and search queries.
import { generateJSON, llmInfo } from './llm.js';

const SCHEMA = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'The core topic in one short noun phrase' },
    task_type: { type: 'string', description: 'e.g. opinion (agree/disagree), discussion (both views), problem-solution, advantages-disadvantages, mixed' },
    summary: { type: 'string', description: 'One or two sentences: what the essay must argue' },
    key_issues: { type: 'array', items: { type: 'string' }, description: '3-6 sub-issues worth researching' },
    academic_queries: { type: 'array', items: { type: 'string' }, description: '3-5 short keyword queries (2-6 words) for scholarly databases' },
    editorial_queries: { type: 'array', items: { type: 'string' }, description: '3-5 natural-language queries for opinion pieces, editorials and quality journalism' },
  },
  required: ['topic', 'task_type', 'summary', 'key_issues', 'academic_queries', 'editorial_queries'],
};

const SYSTEM = `You help a Vietnamese high-school student prepare for the writing section of the national excellent student competition in English (HSG Quốc gia). Prompts are IELTS Task 2 style but longer: they may quote a statement, a passage or data before the task.
Identify what the essay is really about, then write search queries that will find (a) peer-reviewed research and (b) editorials, op-eds and long-form journalism with arguments and evidence on both sides.
Queries must be in English and about the substance of the debate, not about essay writing. Do not include words like "essay", "IELTS" or "agree".`;

export async function analyzePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) throw Object.assign(new Error('The prompt is empty.'), { status: 400 });
  if (llmInfo().provider) {
    try {
      const out = await generateJSON({ system: SYSTEM, user: `Writing prompt:\n"""\n${text.slice(0, 8000)}\n"""`, schema: SCHEMA, maxTokens: 2048 });
      return { ...tidy(out), source: 'ai' };
    } catch (error) {
      const fallback = heuristicAnalysis(text);
      return { ...fallback, source: 'keywords', warning: `${error.message} Using keyword extraction instead.` };
    }
  }
  return { ...heuristicAnalysis(text), source: 'keywords' };
}

function tidy(out) {
  const list = (v, n) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, n);
  return {
    topic: String(out.topic || '').trim(),
    task_type: String(out.task_type || '').trim(),
    summary: String(out.summary || '').trim(),
    key_issues: list(out.key_issues, 6),
    academic_queries: list(out.academic_queries, 5),
    editorial_queries: list(out.editorial_queries, 5),
  };
}

// ---------- Fallback without an AI key ----------

const INSTRUCTION_PATTERNS = [
  /to what extent do you agree or disagree[^.?!]*[.?!]?/gi,
  /do you agree or disagree[^.?!]*[.?!]?/gi,
  /discuss both (these )?views and give your (own )?opinion[^.?!]*[.?!]?/gi,
  /give reasons for your answer[^.?!]*[.?!]?/gi,
  /include (any )?relevant examples from your (own )?knowledge or experience[^.?!]*[.?!]?/gi,
  /write (an essay|a composition|about)[^.?!]*\d+\s*words[^.?!]*[.?!]?/gi,
  /(you should )?write at least \d+ words[^.?!]*[.?!]?/gi,
  /in (about|approximately|no more than) \d+ words[^.?!]*[.?!]?/gi,
  /(what is|what's) your opinion[^.?!]*[.?!]?/gi,
  /support your (answer|ideas|opinion)[^.?!]*[.?!]?/gi,
];

const STOP = new Set(`a about above after again against all also although am an and any are aren't as at be because been before being below between both but by can cannot could did do does doing down during each either else ever every few for from further had has have having he her here hers herself him himself his how however i if in into is isn't it it's its itself just like many may me might more most much must my myself neither no nor not now of off often on once one only or other others ought our ours ourselves out over own people person rather really same say says she should since so some such than that the their theirs them themselves then there these they thing things think this those though through thus to too under until up upon us very was we were what when where whether which while who whom whose why will with within without would yet you your yours yourself yourselves
essay write writing words word opinion view views agree disagree extent discuss reasons answer examples example knowledge experience relevant argue argued argument believe believed claim claimed statement following prompt task question topic own give provide support some many nowadays today modern recent recently increasingly becoming become becomes become nowadays world countries country society societies way ways important
make makes made making learn learns learned learning anything something everything nothing anyone someone everyone remain remains remained help helps helped use used uses using take takes took get gets got allow allows allowed lead leads led need needs needed want wants wanted provide provides provided come comes came go goes went see seen know known feel felt keep kept put let seem seems seemed tend tends try tries tried show shows shown mean means meant bring brings brought spend spends spent better best worse worst good bad great new old large small big long high low able unable essential necessary possible likely certain whole entire own pace instead rather even still already always never sometimes usually others`.split(/\s+/));

// Gerunds and past forms like "developing" at the edges of a phrase are verbs, not topics.
const EDGE_VERB = /^(?!(?:learning|teaching|training|funding|housing|marketing|advertising|clothing|engineering|nursing|parenting|banking|computing|gaming|shopping|tourism|warming)$)[a-z]{4,}(ing|ed)$/;

export function heuristicAnalysis(text) {
  let body = text;
  for (const p of INSTRUCTION_PATTERNS) body = body.replace(p, ' ');
  const sentences = body.split(/(?<=[.?!])\s+|\n+/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 4);

  // Candidate phrases = runs of content words between stop words / punctuation.
  const counts = new Map();
  const firstSeen = new Map();
  let order = 0;
  for (const s of sentences) {
    const tokens = s.toLowerCase().replace(/[^a-z0-9'\- ]+/g, ' | ').split(/\s+/).filter(Boolean);
    let run = [];
    const flush = () => {
      while (run.length && EDGE_VERB.test(run[0])) run.shift();
      while (run.length && EDGE_VERB.test(run[run.length - 1])) run.pop();
      for (let n = Math.min(3, run.length); n >= 1; n--) {
        for (let i = 0; i + n <= run.length; i++) {
          const phrase = run.slice(i, i + n).join(' ');
          if (phrase.length < 4) continue;
          counts.set(phrase, (counts.get(phrase) || 0) + n); // longer phrases weigh more
          if (!firstSeen.has(phrase)) firstSeen.set(phrase, order++);
        }
      }
      run = [];
    };
    for (const t of tokens) {
      const w = t.replace(/^'+|'+$/g, '');
      if (w === '|' || STOP.has(w) || /^\d+$/.test(w) || w.length < 3) flush();
      else run.push(w);
    }
    flush();
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0]) - firstSeen.get(b[0]))
    .map(([p]) => p);
  const keywords = [];
  for (const p of ranked) {
    if (keywords.some((k) => k.includes(p) || p.includes(k))) continue;
    keywords.push(p);
    if (keywords.length >= 8) break;
  }
  const topic = keywords.slice(0, 2).join(', ') || sentences[0]?.slice(0, 80) || 'Essay topic';
  const anchor = keywords[0] || '';
  const withAnchor = (k) => (k === anchor ? k : `${anchor} ${k}`).split(' ').slice(0, 6).join(' ');
  return {
    topic,
    task_type: detectTaskType(text),
    summary: sentences.slice(0, 2).join(' ').slice(0, 300),
    key_issues: keywords.slice(0, 6),
    academic_queries: [...new Set(keywords.slice(0, 4).map(withAnchor))],
    editorial_queries: [...new Set([`${anchor} debate`, ...keywords.slice(1, 4).map(withAnchor)])].filter((q) => q.trim() !== 'debate'),
  };
}

function detectTaskType(text) {
  const t = text.toLowerCase();
  if (/both (these )?views|discuss both/.test(t)) return 'discussion (both views + opinion)';
  if (/advantages?.*disadvantages?|benefits?.*drawbacks?/.test(t)) return 'advantages-disadvantages';
  if (/(problems?|causes?).*(solutions?|measures?)/.test(t)) return 'problem-solution';
  if (/agree or disagree|to what extent/.test(t)) return 'opinion (agree/disagree)';
  return 'mixed / open';
}
