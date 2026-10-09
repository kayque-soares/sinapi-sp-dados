import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const arquivo = process.argv[2];
if (!arquivo) throw new Error("Informe o PDF da FDE abril/2022.");

const COMPETENCIA = "2022-04";
const FONTE_PUBLICA = "https://registro.sp.gov.br/publicacoes/docs/445_Anexo%20I%20-%20Termo%20de%20Refer%C3%AAncia%20-%20Tabela-FDE-Abril-2022.pdf";
const RE_SERVICO = /^\d{2}\.\d{2}\.\d{3}$/;
const RE_INSUMO = /^\d{1,2}\.\d{2}\.\d{2}$/;
const RE_CODIGO = /^(?:\d{2}\.\d{2}\.\d{3}|\d{1,2}\.\d{2}\.\d{2})$/;

const exigir = (cond, msg) => { if (!cond) throw new Error(`FDE: ${msg}`); };
const semAcento = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const arred2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const arred4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

function numeroBR(s) {
  const t = String(s ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  const n = t.replace(/\./g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(n) ? Number(n) : null;
}

function classe(codigo, unidade) {
  const familia = Number(codigo.split(".")[0]);
  const u = String(unidade ?? "").toUpperCase();
  if (familia === 1 && u === "H") return "MAO DE OBRA";
  if ([8, 9].includes(familia) && u === "H") return "EQUIPAMENTO";
  if (familia === 6 && ["MV", "VB", "CJ"].includes(u)) return "SERVICO";
  return "MATERIAL";
}

function agruparLinhas(itens, tolerancia = 9.0) {
  const lista = [...itens].sort((a, b) => a.y - b.y || a.x - b.x);
  const linhas = [];
  for (const item of lista) {
    let l = linhas[linhas.length - 1];
    if (!l || Math.abs(l.y - item.y) > tolerancia) {
      l = { y: item.y, itens: [] };
      linhas.push(l);
    }
    l.itens.push(item);
  }
  return linhas;
}

function acharCabecalho(itens) {
  const acha = (re) => itens.find((i) => re.test(semAcento(i.s)));
  const ref = acha(/^Referencia$/i);
  const desc = acha(/^Descricao$/i);
  const un = acha(/^UN$/i);
  const coef = acha(/^Coeficiente$/i);
  const custo = acha(/^Custo(?: Total)?$/i) ?? acha(/^Total$/i);
  return ref && desc && un && coef && custo ? { ref, desc, un, coef, custo } : null;
}

function texto(itens) {
  return [...itens].sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
}

function parseLinha(linha, cab) {
  const itens = [...linha.itens].sort((a, b) => a.x - b.x);
  const codigoItem = itens.find((i) => RE_CODIGO.test(i.s));
  const numericos = itens.filter((i) => i.x > cab.coef.x - 35 && numeroBR(i.s) !== null);
  const valorItem = numericos[numericos.length - 1] ?? null;

  // A unidade fica visualmente sob a coluna UN. Usamos uma janela ampla porque
  // a FDE centraliza unidades curtas e algumas (ex.: M3X KM) podem ser fragmentadas.
  const unInicio = cab.un.x - 35;
  const unFim = cab.coef.x - 12;
  let unidadeItens = itens.filter((i) => i.x >= unInicio && i.x < unFim && i !== codigoItem);

  // Fallback: quando o PDF desloca ligeiramente a unidade, pega o último token antes
  // do coeficiente/custo, desde que seja curto e não numérico.
  if (!unidadeItens.length && valorItem) {
    const candidatos = itens.filter((i) => i.x > (codigoItem?.x ?? -Infinity) && i.x < valorItem.x && numeroBR(i.s) === null);
    const ultimo = candidatos[candidatos.length - 1];
    if (ultimo && ultimo.s.length <= 10) unidadeItens = [ultimo];
  }
  const unidade = texto(unidadeItens) || null;
  const xDescFim = unidadeItens.length ? Math.min(...unidadeItens.map((i) => i.x)) - 1 : unInicio;
  const xDescIni = codigoItem ? codigoItem.x + codigoItem.w + 2 : cab.desc.x - 20;
  const descricao = texto(itens.filter((i) => i.x >= xDescIni && i.x < xDescFim));

  return {
    codigo: codigoItem?.s ?? null,
    descricao,
    unidade,
    valor: valorItem ? numeroBR(valorItem.s) : null,
  };
}

async function extrairRegistros(caminho) {
  const bytes = readFileSync(caminho);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  exigir(doc.numPages === 404, `esperadas 404 páginas, recebidas ${doc.numPages}`);

  const registros = [];
  let atual = null;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const itens = content.items.map((it) => ({
      x: it.transform[4], y: height - it.transform[5], w: it.width,
      s: String(it.str ?? "").replace(/\s+/g, " ").trim(),
    })).filter((i) => i.s);
    const cab = acharCabecalho(itens);
    exigir(cab, `cabeçalho não reconhecido na página ${p}`);
    const topo = Math.max(cab.ref.y, cab.desc.y, cab.un.y, cab.coef.y, cab.custo.y) + 4;
    const rodape = itens.find((i) => /^Emiss[aã]o:/i.test(i.s))?.y ?? Infinity;
    const linhas = agruparLinhas(itens.filter((i) => i.y > topo && i.y < rodape - 2));

    for (const linha of linhas) {
      const r = parseLinha(linha, cab);
      if (r.codigo) {
        atual = { pagina: p, codigo: r.codigo, descricao: r.descricao, unidade: r.unidade, valor: r.valor };
        registros.push(atual);
      } else if (atual && r.descricao) {
        atual.descricao = `${atual.descricao} ${r.descricao}`.replace(/\s+/g, " ").trim();
        if (!atual.unidade && r.unidade) atual.unidade = r.unidade;
        if (atual.valor === null && r.valor !== null) atual.valor = r.valor;
      }
    }
  }
  return { registros, sha256, paginas: doc.numPages };
}

function montarBase(registros) {
  const composicoes = [];
  const estrutura = [];
  const insumosMap = new Map();
  const problemas = [];
  let pai = null;

  for (const r of registros) {
    if (RE_SERVICO.test(r.codigo)) {
      if (!r.descricao || !r.unidade || r.valor === null) problemas.push(`serviço incompleto ${r.codigo} pág ${r.pagina}`);
      pai = r.codigo;
      composicoes.push({ c: r.codigo, d: r.descricao, u: r.unidade, g: r.codigo.slice(0, 5), p: r.valor });
      continue;
    }
    if (!RE_INSUMO.test(r.codigo)) continue;
    if (!pai) { problemas.push(`insumo sem pai ${r.codigo}`); continue; }
    if (!r.descricao || !r.unidade || r.valor === null || r.valor <= 0) {
      problemas.push(`insumo incompleto ${r.codigo} em ${pai} pág ${r.pagina}`);
      continue;
    }
    const ex = insumosMap.get(r.codigo);
    if (ex && (ex.d !== r.descricao || ex.u !== r.unidade)) problemas.push(`metadados divergentes ${r.codigo}`);
    if (!ex) insumosMap.set(r.codigo, {
      c: r.codigo, d: r.descricao, u: r.unidade, cl: classe(r.codigo, r.unidade),
      p: null, status: "NAO_DETERMINADO", faixa: null, evidencias: 0,
    });
    estrutura.push({ c: pai, t: "I", i: r.codigo, k: r.valor });
  }

  const duplicadas = composicoes.filter((c, idx) => composicoes.findIndex((x) => x.c === c.c) !== idx);
  if (duplicadas.length) problemas.push(`${duplicadas.length} composições duplicadas`);
  exigir(problemas.length === 0, `${problemas.length} problemas: ${problemas.slice(0, 15).join("; ")}`);
  exigir(composicoes.length > 3000, `somente ${composicoes.length} composições`);
  exigir(insumosMap.size > 1000, `somente ${insumosMap.size} insumos`);
  exigir(estrutura.length > 10000, `somente ${estrutura.length} itens de estrutura`);
  return { composicoes, estrutura, insumos: [...insumosMap.values()] };
}

function equacoes(composicoes, estrutura) {
  const por = new Map();
  for (const e of estrutura) {
    if (!por.has(e.c)) por.set(e.c, new Map());
    const m = por.get(e.c);
    m.set(e.i, (m.get(e.i) ?? 0) + e.k);
  }
  return composicoes.map((c) => ({
    c: c.c, custo: c.p,
    itens: [...(por.get(c.c) ?? new Map()).entries()].map(([i, k]) => ({ i, k })),
  }));
}

function derivar(insumos, composicoes, estrutura) {
  const faixas = new Map(insumos.map((i) => [i.c, { lo: 0, hi: Infinity, evidencias: new Set(), divergente: false }]));
  const eqs = equacoes(composicoes, estrutura);

  const aplicar = (codigo, lo, hi, evid) => {
    const f = faixas.get(codigo);
    if (!f || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < 0) return false;
    lo = Math.max(0, lo);
    const nl = Math.max(f.lo, lo), nh = Math.min(f.hi, hi);
    if (nh + 1e-7 < nl) { f.divergente = true; return false; }
    const mudou = nl > f.lo + 1e-7 || nh < f.hi - 1e-7;
    f.lo = nl; f.hi = nh; f.evidencias.add(evid);
    return mudou;
  };

  for (let rodada = 0; rodada < 200; rodada++) {
    let mudou = 0;
    for (const eq of eqs) {
      if (!eq.itens.length || eq.custo === null) continue;
      const inf = eq.itens.filter(({ i }) => !Number.isFinite(faixas.get(i)?.hi));
      const alvos = inf.length === 1 ? inf : inf.length === 0 ? eq.itens : [];
      for (const alvo of alvos) {
        let loOut = 0, hiOut = 0, ok = true;
        for (const x of eq.itens) {
          if (x.i === alvo.i) continue;
          const f = faixas.get(x.i);
          if (!f || !Number.isFinite(f.hi)) { ok = false; break; }
          loOut += x.k * f.lo; hiOut += x.k * f.hi;
        }
        if (!ok) continue;
        const lo = (Math.max(0, eq.custo - 0.005) - hiOut) / alvo.k;
        const hi = (eq.custo + 0.005 - loOut) / alvo.k;
        if (aplicar(alvo.i, lo, hi, eq.c)) mudou++;
      }
    }
    if (!mudou) break;
  }

  const mapa = new Map(insumos.map((i) => [i.c, i]));
  for (const [codigo, f] of faixas) {
    const i = mapa.get(codigo);
    i.evidencias = f.evidencias.size;
    if (f.divergente) { i.status = "DIVERGENTE"; continue; }
    if (!Number.isFinite(f.hi)) continue;
    const largura = f.hi - f.lo;
    const meio = (f.lo + f.hi) / 2;
    i.faixa = [arred4(f.lo), arred4(f.hi)];
    if (f.evidencias.size >= 2 && largura <= 0.0050001) { i.status = "CONFIRMADO"; i.p = arred4(meio); }
    else if (f.evidencias.size >= 1 && largura <= 0.0200001) { i.status = "DERIVADO"; i.p = arred4(meio); }
  }
}

function validar(insumos, composicoes, estrutura) {
  const preco = new Map(insumos.filter((i) => i.p !== null).map((i) => [i.c, i.p]));
  const por = new Map();
  for (const e of estrutura) { if (!por.has(e.c)) por.set(e.c, []); por.get(e.c).push(e); }
  const linhas = [];
  let ok = 0, incompletas = 0, divergentes = 0;
  for (const c of composicoes) {
    const itens = por.get(c.c) ?? [];
    const falt = [...new Set(itens.filter((e) => !preco.has(e.i)).map((e) => e.i))];
    if (falt.length) {
      incompletas++;
      linhas.push({ c: c.c, oficial: c.p, recalculado: null, diferenca: null, situacao: "INCOMPLETA", insumos_sem_preco: falt });
      continue;
    }
    const calc = itens.reduce((s, e) => s + preco.get(e.i) * e.k, 0);
    const diff = calc - c.p;
    const bate = arred2(calc) === arred2(c.p) || Math.abs(diff) <= 0.011;
    bate ? ok++ : divergentes++;
    linhas.push({ c: c.c, oficial: c.p, recalculado: arred4(calc), diferenca: arred4(diff), situacao: bate ? "OK" : "DIVERGENTE", insumos_sem_preco: [] });
  }
  return { resumo: {
    composicoes: composicoes.length, ok, incompletas, divergentes,
    percentual_ok_total: arred4(ok / composicoes.length * 100),
    percentual_ok_das_completas: ok + divergentes ? arred4(ok / (ok + divergentes) * 100) : 0,
  }, composicoes: linhas };
}

const { registros, sha256, paginas } = await extrairRegistros(arquivo);
const { composicoes, estrutura, insumos } = montarBase(registros);
derivar(insumos, composicoes, estrutura);
const validacao = validar(insumos, composicoes, estrutura);
const status = insumos.reduce((a, i) => ({ ...a, [i.status]: (a[i.status] ?? 0) + 1 }), {});
const meta = {
  fonte: "FDE - Tabela de Composição",
  fonte_publica: FONTE_PUBLICA,
  competencia: COMPETENCIA,
  referencia: "abril/2022",
  leis_sociais: 1.2087,
  bdi: 0.23,
  paginas,
  sha256_pdf: sha256,
  contagens: { insumos: insumos.length, composicoes: composicoes.length, estrutura: estrutura.length, status_precos: status, validacao: validacao.resumo },
  gerado_em: new Date().toISOString(),
};

const raiz = dirname(fileURLToPath(import.meta.url));
const dir = join(raiz, COMPETENCIA);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "insumos.json"), JSON.stringify(insumos));
writeFileSync(join(dir, "composicoes.json"), JSON.stringify(composicoes));
writeFileSync(join(dir, "estrutura.json"), JSON.stringify(estrutura));
writeFileSync(join(dir, "validacao.json"), JSON.stringify(validacao));
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
const indexPath = join(raiz, "index.json");
const indice = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { versoes: [] };
indice.versoes = [...indice.versoes.filter((v) => v.competencia !== COMPETENCIA), { competencia: COMPETENCIA, referencia: "abril/2022", pasta: COMPETENCIA }]
  .sort((a, b) => b.competencia.localeCompare(a.competencia));
writeFileSync(indexPath, JSON.stringify(indice, null, 2));
console.log(JSON.stringify(meta, null, 2));
