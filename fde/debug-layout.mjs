import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const arquivo = process.argv[2];
const alvos = new Set(["01.01.036", "01.01.037", "01.01.043", "01.01.044", "04.02.014", "2.30.05"]);
const doc = await getDocument({ data: new Uint8Array(readFileSync(arquivo)), verbosity: 0 }).promise;
for (const p of [2, 33]) {
  const page = await doc.getPage(p);
  const { height } = page.getViewport({ scale: 1 });
  const itens = (await page.getTextContent()).items.map((it) => ({
    x: Math.round(it.transform[4] * 100) / 100,
    y: Math.round((height - it.transform[5]) * 100) / 100,
    w: Math.round(it.width * 100) / 100,
    s: String(it.str ?? "").replace(/\s+/g, " ").trim(),
  })).filter((i) => i.s);
  if (p === 2) {
    const nomes = new Set(["Referência", "Descrição", "UN", "Coeficiente", "Custo Total"]);
    console.log("DEBUG CABECALHO", JSON.stringify(itens.filter((i) => nomes.has(i.s))));
  }
  for (const alvo of alvos) {
    const cod = itens.find((i) => i.s === alvo);
    if (!cod) continue;
    console.log(`DEBUG ${alvo} pagina=${p} y=${cod.y}`);
    console.log(JSON.stringify(itens.filter((i) => Math.abs(i.y - cod.y) <= 9).sort((a,b)=>a.y-b.y || a.x-b.x)));
  }
}
