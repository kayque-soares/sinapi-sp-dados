// Extrai o Boletim Referencial de Custos da CDHU (PDFs) para JSON, pela posição do texto na página.
//
// Uso: node cdhu/extrair.mjs <pasta com os PDFs>
//   espera insumos.NNN.pdf, servicos.NNN-sd.pdf e composicao.NNN.pdf (NNN = versão do boletim)
// Saída: cdhu/NNN/{insumos,composicoes,estrutura,meta}.json e cdhu/index.json
//
// Formatos (compatíveis com a importação do sistema):
//   insumos     {c, d, u, cl, p, p0}   p = preço usado (mão de obra horária já com Leis Sociais),
//                                      p0 = preço do PDF de insumos
//   composicoes {c, d, u, g, p, mat, mo}  custo total, material e mão de obra (sem desoneração)
//   estrutura   {c, t:'I', i, k}
// Validação: Σ coeficiente × preço precisa reproduzir o custo oficial de cada serviço; o script aborta
// se menos de 99% dos serviços baterem (indica PDF com layout diferente).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const pasta = process.argv[2];
if (!pasta) throw new Error("Informe a pasta com os PDFs da CDHU.");
const arquivos = readdirSync(pasta);
const achar = (re) => {
  const f = arquivos.find((n) => re.test(n));
  if (!f) throw new Error(`Arquivo não encontrado na pasta: ${re}`);
  return join(pasta, f);
};
const exigir = (cond, msg) => {
  if (!cond) throw new Error(`CDHU: ${msg}`);
};

async function itensPdf(arquivo) {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(arquivo)), verbosity: 0 }).promise;
  const itens = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    for (const it of (await page.getTextContent()).items) {
      const s = it.str.replace(/\s+/g, " ").trim();
      if (s) itens.push({ p, x: it.transform[4], y: height - it.transform[5], w: it.width, s });
    }
  }
  return itens;
}

const num = (s) => {
  const t = String(s ?? "").replace(/\./g, "").replace(",", ".");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
const RE_SERVICO = /^\d{2}\.\d{2}\.\d{3}$/;
const RE_INSUMO = /^[A-Z]\.\d{2}\.\d{3}\.\d{6}$/;
const RE_CODIGO = /^(?:\d{2}\.\d{2}\.\d{3}|[A-Z]\.\d{2}\.\d{3}\.\d{6})$/;
const RE_NUMERO = /^-?[\d.,]+$/;

/**
 * Agrupa os trechos de cada página em registros ancorados no código (coluna esquerda).
 * A descrição pode ocupar várias linhas acima/abaixo do código; cada trecho vai para a âncora
 * mais próxima. Colunas numéricas ("d") são comparadas pela borda direita (alinhadas à direita).
 */
function registros(itens, { xCodigo, xDescricao, colunas }) {
  const porPagina = new Map();
  for (const i of itens) {
    if (!porPagina.has(i.p)) porPagina.set(i.p, []);
    porPagina.get(i.p).push(i);
  }
  const saida = [];
  for (const [p, lista] of [...porPagina].sort((a, b) => a[0] - b[0])) {
    const cab = lista.find((i) => /^Refer[eê]ncia$/i.test(i.s));
    const topo = cab ? cab.y + 4 : 0;
    const corpo = lista.filter((i) => i.y > topo);
    const ancoras = corpo
      .filter((i) => i.x >= xCodigo[0] && i.x <= xCodigo[1] && RE_CODIGO.test(i.s))
      .sort((a, b) => a.y - b.y);
    ancoras.forEach((a, k) => {
      const ini = k === 0 ? topo : (ancoras[k - 1].y + a.y) / 2;
      const fim = k === ancoras.length - 1 ? Infinity : (a.y + ancoras[k + 1].y) / 2;
      const faixa = corpo.filter((i) => i !== a && i.y > ini && i.y <= fim);
      const r = { p, codigo: a.s };
      r.descricao = faixa
        .filter((i) => i.x >= xDescricao[0] && i.x < xDescricao[1] && !RE_NUMERO.test(i.s))
        .sort((x, y) => x.y - y.y || x.x - y.x)
        .map((i) => i.s)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      for (const [nome, [x0, x1, borda]] of Object.entries(colunas)) {
        const pos = (i) => (borda === "d" ? i.x + i.w : i.x);
        const c = faixa
          .filter((i) => pos(i) >= x0 && pos(i) <= x1 && (borda !== "d" || RE_NUMERO.test(i.s)))
          .sort((x, y) => Math.abs(x.y - a.y) - Math.abs(y.y - a.y))[0];
        r[nome] = c ? c.s : null;
      }
      saida.push(r);
    });
  }
  return saida;
}

const [itInsumos, itServicos, itComposicao] = await Promise.all([
  itensPdf(achar(/^insumos\.\d+\.pdf$/i)),
  itensPdf(achar(/^servicos\.\d+-sd\.pdf$/i)),
  itensPdf(achar(/^composicao\.\d+\.pdf$/i)),
]);

// Cabeçalho: versão, data-base e Leis Sociais (tabela sem desoneração).
const cab = itServicos.filter((i) => i.p === 1);
const versao = Number(/Vers[aã]o\s+(\d+)/i.exec(cab.map((i) => i.s).join(" "))?.[1]);
const dataBase = cab.find((i) => /^[A-ZÇ]{3,9}\/\d{2}$/.test(i.s))?.s;
const rotuloLs = cab.find((i) => /^L\.S\.:?$/i.test(i.s));
const textoLs = rotuloLs && cab.filter((i) => Math.abs(i.y - rotuloLs.y) < 2 && i.x > rotuloLs.x).sort((a, b) => a.x - b.x)[0]?.s;
const leisSociais = num(String(textoLs ?? "").replace("%", "")) / 100;
exigir(versao > 0, "versão do boletim não encontrada");
exigir(leisSociais > 0.5 && leisSociais < 3, `Leis Sociais inválidas (${textoLs})`);
const MESES = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, MAIO: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
const [mesTxt, anoTxt] = String(dataBase ?? "").split("/");
const mes = MESES[mesTxt?.slice(0, 3)] ?? MESES[mesTxt];
const ano = 2000 + Number(anoTxt);
exigir(mes && ano > 2000, `data-base inválida (${dataBase})`);

const ehMaoDeObra = (codigo, unidade) => codigo.startsWith("B.01.") && unidade === "H";

const insumosBrutos = registros(itInsumos, {
  xCodigo: [15, 60],
  xDescricao: [90, 460],
  colunas: { unidade: [460, 510], custo: [555, 580, "d"] },
});
const insumos = insumosBrutos.map((r) => {
  const p0 = num(r.custo);
  const mo = ehMaoDeObra(r.codigo, r.unidade);
  return {
    c: r.codigo,
    d: r.descricao,
    u: r.unidade,
    cl: mo ? "MAO DE OBRA" : r.unidade === "H" ? "EQUIPAMENTO" : "MATERIAL",
    p: p0 === null ? null : mo ? Math.round(p0 * (1 + leisSociais) * 10000) / 10000 : p0,
    p0,
  };
});

const composicoes = registros(itServicos, {
  xCodigo: [30, 70],
  xDescricao: [90, 345],
  colunas: { unidade: [345, 395], material: [425, 445, "d"], mao_obra: [480, 500, "d"], total: [540, 560, "d"] },
}).map((r) => ({
  c: r.codigo,
  d: r.descricao,
  u: r.unidade,
  g: r.codigo.slice(0, 5),
  p: num(r.total),
  mat: num(r.material),
  mo: num(r.mao_obra),
}));

const estrutura = [];
let pai = null;
const problemas = [];
for (const r of registros(itComposicao, {
  xCodigo: [15, 60],
  xDescricao: [90, 460],
  colunas: { unidade: [460, 505], coeficiente: [555, 580, "d"] },
})) {
  const k = num(r.coeficiente);
  if (k === null && RE_SERVICO.test(r.codigo)) {
    pai = r.codigo;
  } else if (!pai || k === null) {
    problemas.push(`${r.codigo} (pág ${r.p})`);
  } else {
    estrutura.push({ c: pai, t: RE_SERVICO.test(r.codigo) ? "C" : "I", i: r.codigo, k });
  }
}

// ---------- Validações
for (const i of insumos) {
  if (!RE_INSUMO.test(i.c) || i.p === null || !i.u) problemas.push(`insumo ${i.c}`);
}
for (const s of composicoes) {
  if (!RE_SERVICO.test(s.c) || s.p === null || !s.u) problemas.push(`serviço ${s.c}`);
}
exigir(problemas.length === 0, `${problemas.length} registros inválidos: ${problemas.slice(0, 10).join(", ")}`);
exigir(insumos.length > 1000 && composicoes.length > 1000 && estrutura.length > 5000, "volume abaixo do esperado");

const preco = new Map(insumos.map((i) => [i.c, i.p]));
const itensPor = new Map();
for (const e of estrutura) {
  if (!itensPor.has(e.c)) itensPor.set(e.c, []);
  itensPor.get(e.c).push(e);
}
let batem = 0;
const divergentes = [];
for (const s of composicoes) {
  const itens = itensPor.get(s.c) ?? [];
  const calc = itens.reduce((t, e) => t + (preco.get(e.i) ?? NaN) * e.k, 0);
  if (Math.abs(calc - s.p) <= Math.max(0.011, s.p * 0.01)) batem++;
  else divergentes.push(`${s.c}: calculado ${calc.toFixed(2)} x oficial ${s.p}`);
}
const taxa = batem / composicoes.length;
exigir(taxa >= 0.99, `só ${(taxa * 100).toFixed(1)}% dos serviços batem: ${divergentes.slice(0, 5).join("; ")}`);

// ---------- Saída
const dir = join("cdhu", String(versao));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "insumos.json"), JSON.stringify(insumos));
writeFileSync(join(dir, "composicoes.json"), JSON.stringify(composicoes));
writeFileSync(join(dir, "estrutura.json"), JSON.stringify(estrutura));
const meta = {
  fonte: "CDHU - Boletim Referencial de Custos",
  versao,
  competencia: `${ano}-${String(mes).padStart(2, "0")}`,
  data_base: dataBase,
  desonerada: false,
  leis_sociais: leisSociais,
  observacao: "Mão de obra horária (B.01, unidade H) já inclui as Leis Sociais; p0 é o preço do relatório de insumos.",
  contagens: {
    insumos: insumos.length,
    composicoes: composicoes.length,
    estrutura: estrutura.length,
    servicos_conferidos: batem,
    servicos_divergentes: divergentes.length,
  },
  divergentes: divergentes.slice(0, 50),
  gerado_em: new Date().toISOString(),
};
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
const indice = existsSync("cdhu/index.json") ? JSON.parse(readFileSync("cdhu/index.json", "utf8")) : { versoes: [] };
indice.versoes = [
  ...indice.versoes.filter((v) => v.versao !== versao),
  { versao, competencia: meta.competencia, data_base: dataBase },
].sort((a, b) => b.versao - a.versao);
writeFileSync("cdhu/index.json", JSON.stringify(indice, null, 2));
console.log(JSON.stringify({ versao, competencia: meta.competencia, leis_sociais: leisSociais, ...meta.contagens }, null, 1));
