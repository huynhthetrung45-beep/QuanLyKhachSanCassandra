// To dam cac tu khoa trong doan trich (so khop ca co dau / khong dau).
export default function Highlight({ text, terms }) {
  if (!terms.length || !text) return text;
  // To dam theo tu da bo dau (so khop ca co dau / khong dau).
  const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const folded = fold(text);
  const marks = new Array(text.length).fill(false);
  for (const t of terms) {
    let i = folded.indexOf(t);
    while (i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = folded.indexOf(t, i + t.length); }
  }
  const out = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    out.push(marks[i] ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j));
    i = j;
  }
  return out;
}
