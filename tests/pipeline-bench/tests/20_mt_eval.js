import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { f1, tinyBleu2 } from './util/metrics.js';

const argv = yargs(hideBin(process.argv))
  .option('text', {type:'string'})
  .option('ref', {type:'string'})
  .option('tsv', {type:'string'})
  .option('from', {type:'string', default:'en'})
  .option('to', {type:'string', demandOption:true})
  .argv;

async function translate(text, from, to) {
  const endpoint = 'https://api.cognitive.microsofttranslator.com/translate';
  const params = new URLSearchParams({ 'api-version': '3.0', from, to, includeSentenceLength:'true' });
  const headers = {
    'Ocp-Apim-Subscription-Key': process.env.TRANSLATOR_KEY,
    'Ocp-Apim-Subscription-Region': process.env.TRANSLATOR_REGION,
    'Content-Type': 'application/json'
  };
  const body = [{ Text: text }];
  const r = await axios.post(`${endpoint}?${params.toString()}`, body, { headers });
  return r.data?.[0]?.translations?.[0]?.text || '';
}

async function main() {
  if (argv.tsv) {
    const lines = fs.readFileSync(argv.tsv, 'utf8').split(/\r?\n/).filter(Boolean);
    let sumF1=0, sumBleu=0, n=0;
    for (const line of lines) {
      const [src, ref] = line.split('\t');
      if (!src || !ref) continue;
      const hyp = await translate(src, argv.from, argv.to);
      const m1 = f1(hyp, ref);
      const m2 = tinyBleu2(hyp, ref);
      sumF1 += m1.f; sumBleu += m2; n++;
      console.log(JSON.stringify({src, ref, hyp, f1:m1.f, bleu2:m2}));
    }
    console.log(JSON.stringify({avg_f1: sumF1/n, avg_bleu2: sumBleu/n, n}));
  } else {
    const text = argv.text;
    const ref  = argv.ref || '';
    const hyp = await translate(text, argv.from, argv.to);
    const m1 = ref ? f1(hyp, ref) : {f:null};
    const m2 = ref ? tinyBleu2(hyp, ref) : null;
    console.log(JSON.stringify({src:text, ref, hyp, f1:m1.f, bleu2:m2}));
  }
}
main().catch(e=>{ console.error(e?.response?.data||e.message); process.exit(1); });
