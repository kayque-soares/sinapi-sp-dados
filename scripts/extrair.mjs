// Extrai do pacote mensal do SINAPI (Caixa) os dados de São Paulo, com e sem desoneração,
// e grava JSON compactos em data/AAAA-MM/ + latest.json.
//
// Uso: node scripts/extrair.mjs <SINAPI-AAAA-MM-formato-xlsx.zip | SINAPI_Referência_AAAA_MM.xlsx>
//
// Layout esperado (a partir de 2025): planilha "SINAPI_Referência_AAAA_MM.xlsx" com as abas
// ISD/ICD (insumos sem/com desoneração), CSD/CCD (composições) e Analítico (estrutura).
// Se o layout mudar, o script aborta em vez de gerar dados errados.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import XLSX from "xlsx";
import { slugGrupo } from "./grupo.mjs";

const UF = "SP";
const entrada = process.argv[2];
if (!entrada) throw new Error("Informe o .zip ou o .xlsx do SINAPI.");

function carregarPlanilha(caminho) {
  const bytes = readFileSync(caminho);
  if (!caminho.toLowerCase().endsWith(".zip")) return bytes;
  const arquivos = unzipSync(new Uint8Array(bytes), {
    filter: (f) => /refer.ncia.*\.xlsx$/i.test(Buffer.from(f.name, "latin1").toString("utf8")) || /Refer/i.test(f.name),
  });
  const nome = Object.keys(arquivos).find((n) => /\.xlsx$/i.test(n));
  if (!nome) throw new Error("ZIP sem a planilha SINAPI_Referência_*.xlsx.");
  return Buffer.from(arquivos[nome]);
}

const wb = XLSX.read(carregarPlanilha(entrada), {
  type: "buffer",
  sheets: ["ISD", "ICD", "CSD", "CCD", "Analítico"],
  cellFormula: true,
  dense: true,
});

function linhas(aba) {
  const ws = wb.Sheets[aba];
  if (!ws) throw new Error(`Aba ${aba} não encontrada: layout do SINAPI mudou.`);
  return { ws, rows: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) };
}

function texto(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}
function numero(v) {
  if (v === "" || v === null || v === undefined || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function exigir(cond, msg) {
  if (!cond) throw new Error(`Layout SINAPI inesperado: ${msg}`);
}

// Competência: "Mês de Referência:" na linha 3 (índice 2), coluna B.
const { rows: isd } = linhas("ISD");
exigir(/m.s de refer/i.test(texto(isd[2][0])), "cabeçalho 'Mês de Referência' ausente em ISD");
const [mes, ano] = texto(isd[2][1]).split("/");
exigir(/^\d{2}$/.test(mes) && /^\d{4}$/.test(ano), `competência inválida '${isd[2][1]}'`);
const competencia = `${ano}-${mes}`;
const emissao = texto(isd[3][1]);

// ---------- Insumos (ISD = sem desoneração, ICD = com desoneração) ----------
function precosInsumos(aba) {
  const { rows } = linhas(aba);
  const cab = rows[9].map(texto);
  exigir(/c.digo do insumo/i.test(cab[1]) && /descri/i.test(cab[2]) && /unidade/i.test(cab[3]), `cabeçalho de ${aba}`);
  const col = cab.indexOf(UF);
  exigir(col > 4, `coluna ${UF} não encontrada em ${aba}`);
  const mapa = new Map();
  for (const r of rows.slice(10)) {
    const codigo = texto(r[1]);
    if (!/^\d+$/.test(codigo)) continue;
    mapa.set(codigo, {
      c: codigo,
      d: texto(r[2]),
      u: texto(r[3]),
      cl: texto(r[0]),
      p: numero(r[col]),
    });
  }
  return mapa;
}
const insSD = precosInsumos("ISD");
const insCD = precosInsumos("ICD");
const insumos = [...insSD.values()].map((i) => ({
  c: i.c,
  d: i.d,
  u: i.u,
  cl: i.cl,
  sd: i.p,
  cd: insCD.get(i.c)?.p ?? null,
}));

// ---------- Composições (CSD/CCD) ----------
function custosComposicoes(aba) {
  const { ws, rows } = linhas(aba);
  const ufs = rows[8].map(texto);
  const col = ufs.indexOf(UF);
  exigir(col > 3, `coluna ${UF} não encontrada em ${aba}`);
  exigir(/custo/i.test(texto(rows[9][col])), `coluna de custo de ${UF} em ${aba}`);
  const mapa = new Map();
  rows.slice(10).forEach((r, i) => {
    // O código é um HYPERLINK(...; 104658): o valor exibido vem zerado, o código está na fórmula.
    const celula = ws["!data"]?.[i + 10]?.[1] ?? ws[XLSX.utils.encode_cell({ r: i + 10, c: 1 })];
    let codigo = texto(r[1]);
    if (!/^[1-9]\d*$/.test(codigo) && celula?.f) {
      const m = /,\s*(\d+)\s*\)\s*$/.exec(celula.f);
      if (m) codigo = m[1];
    }
    if (!/^[1-9]\d*$/.test(codigo)) return;
    mapa.set(codigo, { c: codigo, d: texto(r[2]), u: texto(r[3]), g: texto(r[0]), p: numero(r[col]) });
  });
  return mapa;
}
const compSD = custosComposicoes("CSD");
const compCD = custosComposicoes("CCD");

// ---------- Analítico: estrutura das composições ----------
const { rows: ana } = linhas("Analítico");
const cabAna = ana[9].map(texto);
exigir(/c.digo da composi/i.test(cabAna[1]) && /tipo item/i.test(cabAna[2]) && /coeficiente/i.test(cabAna[6]), "cabeçalho do Analítico");
const estrutura = [];
const extras = new Map(); // composições/insumos que só aparecem no analítico (SEM PREÇO / EM ESTUDO)
for (const r of ana.slice(10)) {
  const comp = texto(r[1]);
  if (!/^\d+$/.test(comp)) continue;
  const tipo = texto(r[2]).toUpperCase();
  if (!tipo) {
    // Linha-cabeçalho da composição: descrição, unidade e situação.
    if (!compSD.has(comp)) extras.set(`C${comp}`, { t: "C", c: comp, d: texto(r[4]), u: texto(r[5]), g: texto(r[0]), s: texto(r[7]) });
    continue;
  }
  const item = texto(r[3]);
  const k = numero(r[6]);
  if (!/^\d+$/.test(item) || k === null) continue;
  const t = tipo.startsWith("COMP") ? "C" : "I";
  estrutura.push({ c: comp, t, i: item, k });
  if (t === "I" && !insSD.has(item) && !extras.has(`I${item}`)) {
    extras.set(`I${item}`, { t: "I", c: item, d: texto(r[4]), u: texto(r[5]), s: texto(r[7]) });
  }
}

const composicoes = [...compSD.values()].map((x) => ({
  c: x.c,
  d: x.d,
  u: x.u,
  g: x.g,
  sd: x.p,
  cd: compCD.get(x.c)?.p ?? null,
}));
for (const e of extras.values()) {
  if (e.t === "C") composicoes.push({ c: e.c, d: e.d, u: e.u, g: e.g, sd: null, cd: null, s: e.s });
  else insumos.push({ c: e.c, d: e.d, u: e.u, cl: "", sd: null, cd: null, s: e.s });
}

// Caderno Técnico da Caixa pelo grupo da composição (cadernos.json gerado por scripts/cadernos.mjs).
const cadernos = existsSync("cadernos.json") ? JSON.parse(readFileSync("cadernos.json", "utf8")) : {};
for (const c of composicoes) {
  const url = c.g ? cadernos[slugGrupo(c.g)] : undefined;
  if (url) c.ct = url;
}

exigir(insumos.length > 3000, `poucos insumos (${insumos.length})`);
exigir(composicoes.length > 5000, `poucas composições (${composicoes.length})`);
exigir(estrutura.length > 30000, `estrutura analítica pequena (${estrutura.length})`);

// ---------- Saída ----------
const dir = join("data", competencia);
mkdirSync(dir, { recursive: true });
const arquivos = { insumos, composicoes, estrutura };
const hashes = {};
for (const [nome, conteudo] of Object.entries(arquivos)) {
  const json = JSON.stringify(conteudo);
  writeFileSync(join(dir, `${nome}.json`), json);
  hashes[nome] = createHash("sha256").update(json).digest("hex");
}
const meta = {
  fonte: "SINAPI - Caixa Econômica Federal",
  uf: UF,
  competencia,
  emissao,
  gerado_em: new Date().toISOString(),
  contagens: {
    insumos: insumos.length,
    insumos_com_preco_sd: insumos.filter((i) => i.sd !== null).length,
    composicoes: composicoes.length,
    composicoes_com_custo_sd: composicoes.filter((c) => c.sd !== null).length,
    composicoes_com_caderno: composicoes.filter((c) => c.ct).length,
    estrutura: estrutura.length,
  },
  sha256: hashes,
  arquivos: Object.keys(arquivos).map((n) => `data/${competencia}/${n}.json`),
};
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
writeFileSync("latest.json", JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
