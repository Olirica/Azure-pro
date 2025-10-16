export function tokenize(s='') {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s\-']/gu,' ').split(/\s+/).filter(Boolean);
}
export function f1(hyp, ref) {
  const h = tokenize(hyp), r = tokenize(ref);
  const H = new Map(); h.forEach(t=>H.set(t,(H.get(t)||0)+1));
  const R = new Map(); r.forEach(t=>R.set(t,(R.get(t)||0)+1));
  let overlap=0; for (const [t,c] of H) overlap += Math.min(c, R.get(t)||0);
  const prec = h.length? overlap/h.length : 0;
  const rec  = r.length? overlap/r.length : 0;
  const f = (prec+rec)? (2*prec*rec/(prec+rec)) : 0;
  return {prec, rec, f};
}
// BLEU-2 (tiny, un-smoothed) just for quick signal; use sacreBLEU for real eval
function ngrams(tokens, n) {
  const arr=[]; for (let i=0;i+ n<=tokens.length;i++) arr.push(tokens.slice(i,i+n).join(' ')); return arr;
}
export function tinyBleu2(hyp, ref) {
  const h = tokenize(hyp), r = tokenize(ref);
  const h1 = ngrams(h,1), r1 = ngrams(r,1);
  const h2 = ngrams(h,2), r2 = ngrams(r,2);
  const p1 = precision(h1, r1), p2 = precision(h2, r2);
  const bp = brevityPenalty(h.length, r.length);
  const bleu = bp * Math.exp(0.5*(Math.log(p1||1e-9) + Math.log(p2||1e-9)));
  return bleu;
}
function brevityPenalty(c, r) { return c>r?1: Math.exp(1 - r/Math.max(c,1)); }
function precision(h, r) {
  const R = new Map(); r.forEach(t=>R.set(t,(R.get(t)||0)+1));
  let match=0; h.forEach(t=>{ const v=R.get(t)||0; if(v){R.set(t,v-1); match++;}});
  return h.length? match/h.length : 0;
}
