import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chunkScript } from '../nlp/chunk.js';
import { embed, embedBatch } from '../nlp/embed.js';
import { Matcher } from '../nlp/matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIMULATED_TRANSCRIPT: string[] = [
  "okay welcome everyone uh thanks for joining the quarterly review",
  "today I want to cover three things revenue features and feedback",
  "so first revenue we had a great quarter up about thirty two percent",
  "this was mostly enterprise deals in financial services",
  "our contract values went from forty grand up to around fifty five thousand",
  "moving on to the new features we launched this quarter",
  "we shipped real-time collaboration analytics dashboard and offline mobile",
  "the collab tool saw really strong adoption sixty percent of teams in two weeks",
  "now for customer feedback our NPS went up significantly from forty two to fifty eight",
  "people loved the performance gains and the new onboarding experience",
  "search speed got tons of praise specifically",
  "looking forward next quarter we're focused on AI recommendations",
  "we're also expanding to Europe and growing the support team",
  "thanks everyone happy to answer questions now",
];

async function main() {
  const scriptPath = join(__dirname, 'sample-script.txt');
  const raw = readFileSync(scriptPath, 'utf-8');

  console.log('[scripter:proto] chunking script...');
  const chunks = chunkScript(raw);
  console.log(`[scripter:proto] ${chunks.length} chunks`);

  console.log('[scripter:proto] embedding script chunks (first run downloads model ~80MB)...');
  const t0 = Date.now();
  const chunkEmbeds = await embedBatch(chunks.map((c) => c.text));
  console.log(`[scripter:proto] embedded in ${Date.now() - t0}ms`);

  const matcher = new Matcher(chunks, chunkEmbeds);

  console.log('\n[scripter:proto] simulating live transcript stream...\n');
  const window: string[] = [];
  const WINDOW_SIZE = 3;

  for (const utterance of SIMULATED_TRANSCRIPT) {
    window.push(utterance);
    if (window.length > WINDOW_SIZE) window.shift();
    const ctx = window.join(' ');

    const e = await embed(ctx);
    const r = matcher.match(e);
    const target = chunks[r.chunkId];
    const flag = r.committed ? 'JUMP' : 'hold';
    console.log(
      `[${flag}] heard: "${utterance.slice(0, 50)}..." -> chunk#${r.chunkId} slide${target.slide ?? '-'} raw=${r.rawScore.toFixed(3)} adj=${r.adjustedScore.toFixed(3)}`
    );
    console.log(`        script: "${target.text.slice(0, 70)}..."\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
