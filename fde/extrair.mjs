// Extrai a Tabela de Composição FDE abril/2022 para JSON auditável.
//
// Uso:
//   node fde/extrair.mjs caminho/para/Tabela-FDE-Abril-2022.pdf
//
// Saída:
//   fde/2022-04/insumos.json
//   fde/2022-04/composicoes.json
//   fde/2022-04/estrutura.json
//   fde/2022-04/validacao.json
//   fde/2022-04/meta.json
//   fde/index.json
//
// Importante: a publicação FDE traz o custo total das composições e os coeficientes,
// mas não publica nesta mesma tabela os preços unitários dos componentes. O script
// NÃO inventa preços: ele trabalha com intervalos impostos pelo arredondamento do
// custo oficial para centavos e só grava p quando a faixa matemática fica estreita.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const arquivo = process.argv[2];
if (!arquivo) throw new Error("Informe o PDF da FDE abril/2022.");

const COMPETENCIA = "2022-04";
const FONTE = "FDE - Tabela de Composição, referência abril/2022";
const FONTE_PUBLICA = "https://registro.sp.gov.br/publicacoes/docs/445_Anexo%20I%20-%20Termo%20de%20Refer%C3%AAncia%20-%20Tabela-FDE-Abril-2022.pdf";
const LEIS_SOCIAIS = 1.2087;
const BDI = 0.23;

const RE_SERVICO = /^\d{2}\.\d{2}\.\d{3}$/;
const RE_INSUMO = /^\d{1,2}\.\d{2}\.\d{2}$/;
const RE_CODIGO = /^(?:\d{2}\.\d{2}\.\d{3}|\d{1,2}\.\d{2}\.\d{2})$/;
const EPS = 1e-9;

const exigir = (cond, msg) => {
  if (!cond) throw new Error(`FDE: ${msg}`);
};

const semAcento = (s) => String(s ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ")
  .trim();

const numeroBR = (s) => {
  const t = String(s ?? "").trim().replace(/\s/g, "");
  if (!t) return null;
  const n = t.replace(/\./g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(n) ? Number(n) : null;
};

const arred2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const arred4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

function classeInsumo(codigo, unidade) {
  const familia = Number(codigo.split(".")[0]);
  const u = String(unidade ?? "").toUpperCase();
  if (familia === 1 && u === "H") return "MAO DE OBRA";
  if ((familia === 8 || familia === 9) && u === "H") return "EQUIPAMENTO";
  if (familia === 6 && ["MV", "VB", "CJ"].includes(u)) return "SERVICO";
  return "MATERIAL";
}

function textoItens(itens) {
  return itens
    .sort((a, b) => a.x - b.x)
    .map((i) => i.s)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function agruparLinhas(itens, tolerancia = 2.2) {
  const ordenados = [...itens].sort((a, b) => a.y - b.y || a.x - b.x);
  const linhas = [];
  for (const item of ordenados) {
    let linha = linhas[linhas.length - 1];
    if (!linha || Math.abs(linha.y - item.y) > tolerancia) {
      linha = { y: item.y, itens: [] };
      linhas.push(linha);
    } else {
      linha.y = (linha.y * linha.itens.length + item.y) / (linha.itens.length + 1);
    }
    linha.itens.push(item);
  }
  return linhas;
}

function acharCabecalho(itens) {
  const por = (re) => itens.find((i) => re.test(semAcento(i.s)));
  const ref = por(/^Referencia$/i);
  const desc = por(/^Descricao$/i);
  const un = por(/^UN$/i);
  const coef = por(/^Coeficiente$/i);
  const custo = por(/^Custo(?: Total)?$/i) ?? por(/^Total$/i);
  if (!ref || !desc || !un || !coef || !custo) return null;
  return { ref, desc, un, coef, custo };
}

function colunaTexto(linha, x0, x1 = Infinity) {
  return textoItens(linha.itens.filter((i) => i.x >= x0 && i.x < x1));
}

function registrosPagina(itens, pagina) {
  const cab = acharCabecalho(itens);
  exigir(cab, `cabeçalho não reconhecido na página ${pagina}`);

  const xRef = cab.ref.x;
  const xDesc = cab.desc.x;
  const xUn = cab.un.x;
  const xCoef = cab.coef.x;
  const xCusto = cab.custo.x;
  const limites = [
    -Infinity,
    (xRef + xDesc) / 2,
    (xDesc + xUn) / 2,
    (xUn + xCoef) / 2,
    (xCoef + xCusto) / 2,
    Infinity,
  ];

  const topo = Math.max(cab.ref.y, cab.desc.y, cab.un.y, cab.coef.y, cab.custo.y) + 4;
  const rodape = itens
    .filter((i) => /^Emiss[aã]o:/i.test(i.s))
    .sort((a, b) => a.y - b.y)[0]?.y ?? Infinity;
  const corpo = itens.filter((i) => i.y > topo && i.y < rodape - 2);
  const linhas = agruparLinhas(corpo);
  const saida = [];
  let atual = null;

  for (const linha of linhas) {
    const ref = colunaTexto(linha, limites[0], limites[1]);
    const desc = colunaTexto(linha, limites[1], limites[2]);
    const un = colunaTexto(linha, limites[2], limites[3]);
    const coef = colunaTexto(linha, limites[3], limites[4]);
    const custo = colunaTexto(linha, limites[4], limites[5]);
    const codigo = ref.split(/\s+/).find((s) => RE_CODIGO.test(s)) ?? null;

    if (codigo) {
      atual = {
        pagina,
        codigo,
        descricao: desc,
        unidade: un || null,
        coeficiente: numeroBR(coef),
        custo: numeroBR(custo),
      };
      saida.push(atual);
      continue;
    }

    // Descrições longas da FDE podem quebrar para uma segunda linha; a unidade e o
    // custo às vezes ficam nessa continuação. Anexamos apenas ao registro anterior.
    if (atual && desc) {
      atual.descricao = `${atual.descricao} ${desc}`.replace(/\s+/g, " ").trim();
      if (!atual.unidade && un) atual.unidade = un;
      if (atual.coeficiente === null && numeroBR(coef) !== null) atual.coeficiente = numeroBR(coef);
      if (atual.custo === null && numeroBR(custo) !== null) atual.custo = numeroBR(custo);
    }
  }
  return saida;
}

async function lerPdf(caminho) {
  const bytes = readFileSync(caminho);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  exigir(doc.numPages === 404, `esperadas 404 páginas, recebidas ${doc.numPages}`);

  const registros = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const itens = content.items
      .map((it) => ({
        x: it.transform[4],
        y: height - it.transform[5],
        w: it.width,
        s: String(it.str ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((i) => i.s);
    registros.push(...registrosPagina(itens, p));
  }
  return { registros, hash, paginas: doc.numPages };
}

function montarBase(registros) {
  const composicoes = [];
  const estrutura = [];
  const insumosMap = new Map();
  const problemas = [];
  let pai = null;

  for (const r of registros) {
    if (RE_SERVICO.test(r.codigo)) {
      if (!r.descricao || !r.unidade || r.custo === null) {
        problemas.push(`serviço incompleto ${r.codigo} (pág ${r.pagina})`);
      }
      pai = r.codigo;
      composicoes.push({
        c: r.codigo,
        d: r.descricao,
        u: r.unidade,
        g: r.codigo.slice(0, 5),
        p: r.custo,
      });
      continue;
    }

    if (!RE_INSUMO.test(r.codigo)) continue;
    if (!pai) {
      problemas.push(`insumo sem composição-pai ${r.codigo} (pág ${r.pagina})`);
      continue;
    }
    if (!r.descricao || !r.unidade || r.coeficiente === null || r.coeficiente <= 0) {
      problemas.push(`insumo incompleto ${r.codigo} em ${pai} (pág ${r.pagina})`);
      continue;
    }

    const existente = insumosMap.get(r.codigo);
    if (existente && (existente.d !== r.descricao || existente.u !== r.unidade)) {
      problemas.push(`metadados divergentes do insumo ${r.codigo}`);
    } else if (!existente) {
      insumosMap.set(r.codigo, {
        c: r.codigo,
        d: r.descricao,
        u: r.unidade,
        cl: classeInsumo(r.codigo, r.unidade),
        p: null,
        status: "NAO_DETERMINADO",
        faixa: null,
        evidencias: 0,
      });
    }
    estrutura.push({ c: pai, t: "I", i: r.codigo, k: r.coeficiente });
  }

  const compCodigos = new Set(composicoes.map((c) => c.c));
  const duplicadas = composicoes.filter((c, idx) => composicoes.findIndex((x) => x.c === c.c) !== idx);
  if (duplicadas.length) problemas.push(`${duplicadas.length} composições duplicadas`);
  for (const e of estrutura) {
    if (!compCodigos.has(e.c)) problemas.push(`estrutura aponta para composição inexistente ${e.c}`);
    if (!insumosMap.has(e.i)) problemas.push(`estrutura aponta para insumo inexistente ${e.i}`);
  }

  exigir(problemas.length === 0, `${problemas.length} problemas de extração: ${problemas.slice(0, 12).join("; ")}`);
  exigir(composicoes.length > 3000, `volume de composições abaixo do esperado (${composicoes.length})`);
  exigir(insumosMap.size > 1000, `volume de insumos abaixo do esperado (${insumosMap.size})`);
  exigir(estrutura.length > 10000, `volume de estrutura abaixo do esperado (${estrutura.length})`);

  return { composicoes, estrutura, insumos: [...insumosMap.values()] };
}

function equacoesDaBase(composicoes, estrutura) {
  const porComposicao = new Map();
  for (const e of estrutura) {
    if (!porComposicao.has(e.c)) porComposicao.set(e.c, new Map());
    const mapa = porComposicao.get(e.c);
    mapa.set(e.i, (mapa.get(e.i) ?? 0) + e.k);
  }
  return composicoes.map((c) => ({
    c: c.c,
    custo: c.p,
    itens: [...(porComposicao.get(c.c) ?? new Map()).entries()].map(([i, k]) => ({ i, k })),
  }));
}

function derivarPrecos(insumos, composicoes, estrutura) {
  const eqs = equacoesDaBase(composicoes, estrutura);
  const faixas = new Map(insumos.map((i) => [i.c, {
    lo: 0,
    hi: Infinity,
    evidencias: new Set(),
    divergente: false,
  }]));

  function aplicar(codigo, lo, hi, evidencia) {
    const f = faixas.get(codigo);
    if (!f || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < 0) return false;
    lo = Math.max(0, lo);
    const novoLo = Math.max(f.lo, lo);
    const novoHi = Math.min(f.hi, hi);
    if (novoHi + 1e-7 < novoLo) {
      f.divergente = true;
      return false;
    }
    const mudou = novoLo > f.lo + 1e-7 || novoHi < f.hi - 1e-7;
    f.lo = novoLo;
    f.hi = novoHi;
    f.evidencias.add(evidencia);
    return mudou;
  }

  // Cada custo oficial C publicado em centavos representa o intervalo
  // [C - 0,005 ; C + 0,005]. A propagação abaixo é conservadora.
  for (let rodada = 0; rodada < 200; rodada++) {
    let alteracoes = 0;
    for (const eq of eqs) {
      if (!eq.itens.length || eq.custo === null) continue;
      const custoLo = Math.max(0, eq.custo - 0.005);
      const custoHi = eq.custo + 0.005;
      const infinitos = eq.itens.filter(({ i }) => !Number.isFinite(faixas.get(i)?.hi));

      const alvos = infinitos.length === 1
        ? infinitos
        : infinitos.length === 0
          ? eq.itens
          : [];

      for (const alvo of alvos) {
        let outrosLo = 0;
        let outrosHi = 0;
        let valido = true;
        for (const item of eq.itens) {
          if (item.i === alvo.i) continue;
          const f = faixas.get(item.i);
          if (!f || !Number.isFinite(f.hi)) {
            valido = false;
            break;
          }
          outrosLo += item.k * f.lo;
          outrosHi += item.k * f.hi;
        }
        if (!valido || alvo.k <= 0) continue;
        const lo = (custoLo - outrosHi) / alvo.k;
        const hi = (custoHi - outrosLo) / alvo.k;
        if (aplicar(alvo.i, lo, hi, eq.c)) alteracoes++;
      }
    }
    if (alteracoes === 0) break;
  }

  const porCodigo = new Map(insumos.map((i) => [i.c, i]));
  for (const [codigo, f] of faixas) {
    const ins = porCodigo.get(codigo);
    if (!ins) continue;
    ins.evidencias = f.evidencias.size;
    if (f.divergente) {
      ins.status = "DIVERGENTE";
      ins.faixa = Number.isFinite(f.hi) ? [arred4(f.lo), arred4(f.hi)] : null;
      ins.p = null;
      continue;
    }
    if (!Number.isFinite(f.hi)) {
      ins.status = "NAO_DETERMINADO";
      ins.faixa = null;
      ins.p = null;
      continue;
    }

    const largura = Math.max(0, f.hi - f.lo);
    const meio = (f.lo + f.hi) / 2;
    ins.faixa = [arred4(f.lo), arred4(f.hi)];

    // CONFIRMADO: múltiplas equações e faixa de até meio centavo.
    if (f.evidencias.size >= 2 && largura <= 0.005 + EPS) {
      ins.status = "CONFIRMADO";
      ins.p = arred4(meio);
    // DERIVADO: intervalo ainda matematicamente estreito (até 2 centavos),
    // porém sem evidência suficiente para chamar de confirmado.
    } else if (f.evidencias.size >= 1 && largura <= 0.02 + EPS) {
      ins.status = "DERIVADO";
      ins.p = arred4(meio);
    } else {
      ins.status = "NAO_DETERMINADO";
      ins.p = null;
    }
  }

  return faixas;
}

function validar(insumos, composicoes, estrutura) {
  const preco = new Map(insumos.filter((i) => i.p !== null).map((i) => [i.c, i.p]));
  const itensPor = new Map();
  for (const e of estrutura) {
    if (!itensPor.has(e.c)) itensPor.set(e.c, []);
    itensPor.get(e.c).push(e);
  }

  const linhas = [];
  let ok = 0;
  let incompletas = 0;
  let divergentes = 0;

  for (const c of composicoes) {
    const itens = itensPor.get(c.c) ?? [];
    const faltantes = [...new Set(itens.filter((e) => !preco.has(e.i)).map((e) => e.i))];
    if (faltantes.length) {
      incompletas++;
      linhas.push({
        c: c.c,
        oficial: c.p,
        recalculado: null,
        diferenca: null,
        situacao: "INCOMPLETA",
        insumos_sem_preco: faltantes,
      });
      continue;
    }

    const calc = itens.reduce((s, e) => s + preco.get(e.i) * e.k, 0);
    const diff = calc - c.p;
    const bate = arred2(calc) === arred2(c.p) || Math.abs(diff) <= 0.011;
    if (bate) ok++;
    else divergentes++;
    linhas.push({
      c: c.c,
      oficial: c.p,
      recalculado: arred4(calc),
      diferenca: arred4(diff),
      situacao: bate ? "OK" : "DIVERGENTE",
      insumos_sem_preco: [],
    });
  }

  return {
    resumo: {
      composicoes: composicoes.length,
      ok,
      incompletas,
      divergentes,
      percentual_ok_total: composicoes.length ? arred4(ok / composicoes.length * 100) : 0,
      percentual_ok_das_completas: ok + divergentes ? arred4(ok / (ok + divergentes) * 100) : 0,
    },
    composicoes: linhas,
  };
}

const { registros, hash, paginas } = await lerPdf(arquivo);
const { insumos, composicoes, estrutura } = montarBase(registros);
derivarPrecos(insumos, composicoes, estrutura);
const validacao = validar(insumos, composicoes, estrutura);

const contagemStatus = insumos.reduce((acc, i) => {
  acc[i.status] = (acc[i.status] ?? 0) + 1;
  return acc;
}, {});

const meta = {
  fonte: FONTE,
  fonte_publica: FONTE_PUBLICA,
  competencia: COMPETENCIA,
  referencia: "abril/2022",
  leis_sociais: LEIS_SOCIAIS,
  bdi: BDI,
  paginas,
  sha256_pdf: hash,
  observacoes: [
    "Custo das composições e coeficientes extraídos da cópia pública integral da tabela FDE.",
    "Preços de insumos são reconstruídos somente quando o conjunto de equações restringe o valor a uma faixa matemática estreita.",
    "Insumos sem determinação suficiente permanecem com p=null e status NAO_DETERMINADO.",
  ],
  contagens: {
    insumos: insumos.length,
    composicoes: composicoes.length,
    estrutura: estrutura.length,
    status_precos: contagemStatus,
    validacao: validacao.resumo,
  },
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
const indice = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, "utf8"))
  : { versoes: [] };
indice.versoes = [
  ...indice.versoes.filter((v) => v.competencia !== COMPETENCIA),
  {
    competencia: COMPETENCIA,
    referencia: "abril/2022",
    leis_sociais: LEIS_SOCIAIS,
    bdi: BDI,
    pasta: COMPETENCIA,
  },
].sort((a, b) => b.competencia.localeCompare(a.competencia));
writeFileSync(indexPath, JSON.stringify(indice, null, 2));

console.log(JSON.stringify(meta, null, 2));
