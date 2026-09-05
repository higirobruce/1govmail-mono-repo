#!/usr/bin/env node
// Embedding retrieval spot-check: embeds a small trilingual corpus plus
// probe questions, prints cosine rankings. A sane model ranks the matching
// document first for every probe. Usage:
//   OLLAMA_BASE_URL=http://192.168.100.2:11434/v1 EMBED_MODEL=bge-m3:latest node scripts/embed-spotcheck.mjs
const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1').replace(/\/$/, '').replace(/\/v1$/, '');
const model = process.env.EMBED_MODEL ?? 'bge-m3:latest';

const docs = [
  ['budget-en', 'Subject: Q3 budget\nFinance has approved the third-quarter budget revision of 45M RWF.'],
  ['meeting-fr', 'Subject: Réunion\nLa réunion de coordination est reportée à jeudi 14h en salle 2.'],
  ['deadline-rw', "Subject: Raporo\nMwihutire kohereza raporo y'umushinga bitarenze ku wa gatanu."],
  ['invoice-en', 'Subject: Invoice 2214\nPlease find attached invoice 2214 for the network equipment.'],
];
const probes = [
  ['what did finance approve?', 'budget-en'],
  ['quand est la réunion de coordination?', 'meeting-fr'],
  ['ni ryari raporo igomba koherezwa?', 'deadline-rw'],
  ['network equipment invoice', 'invoice-en'],
];

const cos = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
};

const embed = async (input) => {
  const res = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  return (await res.json()).embeddings;
};

const docVecs = await embed(docs.map(([, text]) => text));
let failures = 0;
for (const [probe, expected] of probes) {
  const [qv] = await embed([probe]);
  const ranked = docs
    .map(([id], i) => ({ id, score: cos(qv, docVecs[i]) }))
    .sort((a, b) => b.score - a.score);
  const ok = ranked[0].id === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${probe}" → ${ranked.map((r) => `${r.id}:${r.score.toFixed(3)}`).join('  ')}`);
}
console.log(failures === 0 ? `\nAll probes ranked correctly on ${model}.` : `\n${failures} probe(s) misranked on ${model}.`);
process.exit(failures === 0 ? 0 : 1);
