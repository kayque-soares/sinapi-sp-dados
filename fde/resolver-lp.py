import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import lil_matrix, vstack, hstack, csr_matrix

base = Path(sys.argv[1] if len(sys.argv) > 1 else "fde/2022-04")
FATOR_BDI = 1.23
MAX_COMPONENTE_PARA_INTERVALOS = 60
PRECISAO_INTERNA = 12

insumos = json.loads((base / "insumos.json").read_text())
composicoes = json.loads((base / "composicoes.json").read_text())
estrutura = json.loads((base / "estrutura.json").read_text())

codigos = [i["c"] for i in insumos]
idx = {c: j for j, c in enumerate(codigos)}
n = len(codigos)

coef_por = defaultdict(lambda: defaultdict(float))
for e in estrutura:
    coef_por[e["c"]][e["i"]] += float(e["k"])

# Restrições oficiais de truncamento:
#   C/1.23 <= sum(k*p) < (C+0.01)/1.23
rows = []
ubs = []
comps_com_linha = []
for c in composicoes:
    itens = coef_por.get(c["c"], {})
    if not itens:
        continue
    row = lil_matrix((1, n), dtype=float)
    for cod_i, k in itens.items():
        row[0, idx[cod_i]] = k
    lo = float(c["p"]) / FATOR_BDI
    hi = (float(c["p"]) + 0.01) / FATOR_BDI - 1e-10
    rows.append(row.tocsr())
    ubs.append(hi)
    rows.append((-row).tocsr())
    ubs.append(-lo)
    comps_com_linha.append(c["c"])

A_ub = vstack(rows, format="csr")
b_ub = np.asarray(ubs, dtype=float)

# Para preços já classificados, preservamos a faixa matemática derivada pelo
# reconstrutor. Para desconhecidos, impomos apenas não-negatividade.
bounds = []
for i in insumos:
    faixa = i.get("faixa")
    if i.get("status") in {"CONFIRMADO", "DERIVADO"} and faixa and len(faixa) == 2:
        lo, hi = float(faixa[0]), float(faixa[1])
        if hi > lo:
            bounds.append((max(0.0, lo), hi))
            continue
    bounds.append((0.0, None))

zero = np.zeros(n, dtype=float)
viavel = linprog(zero, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")
if not viavel.success:
    raise RuntimeError(f"Sistema FDE inviável com as faixas atuais: {viavel.message}")
x_viavel = viavel.x

for j, i in enumerate(insumos):
    if i.get("status") in {"CONFIRMADO", "DERIVADO"}:
        i["p"] = round(float(x_viavel[j]), PRECISAO_INTERNA)
        i["p_sem_bdi"] = i["p"]
        i["solucao_global"] = True

# Componentes de incógnitas atuais. Calculamos intervalos LP exatos apenas nos
# componentes pequenos/médios; o grande bloco permanece pendente.
desconhecidos = {i["c"] for i in insumos if i.get("status") == "NAO_DETERMINADO"}
parent = {c: c for c in desconhecidos}
tam = {c: 1 for c in desconhecidos}

def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]
        a = parent[a]
    return a

def union(a, b):
    ra, rb = find(a), find(b)
    if ra == rb:
        return
    if tam[ra] < tam[rb]:
        ra, rb = rb, ra
    parent[rb] = ra
    tam[ra] += tam[rb]

for itens in coef_por.values():
    u = [c for c in itens if c in desconhecidos]
    if len(u) > 1:
        for c in u[1:]:
            union(u[0], c)

grupos = defaultdict(list)
for c in desconhecidos:
    grupos[find(c)].append(c)

promovidos = []
intervalos_lp = 0
falhas_lp = 0

for vars_ in sorted(grupos.values(), key=len):
    if len(vars_) > MAX_COMPONENTE_PARA_INTERVALOS:
        continue
    for codigo in vars_:
        j = idx[codigo]
        obj = np.zeros(n, dtype=float)
        obj[j] = 1.0
        rmin = linprog(obj, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")
        rmax = linprog(-obj, A_ub=A_ub, b_ub=b_ub, bounds=bounds, method="highs")
        if not (rmin.success and rmax.success):
            falhas_lp += 1
            continue
        lo = float(rmin.fun)
        hi = float(-rmax.fun)
        if not (math.isfinite(lo) and math.isfinite(hi) and hi >= lo):
            falhas_lp += 1
            continue
        intervalos_lp += 1
        largura = hi - lo
        i = insumos[j]
        i["faixa_lp"] = [round(lo, PRECISAO_INTERNA), round(hi, PRECISAO_INTERNA)]
        i["largura_lp"] = round(largura, PRECISAO_INTERNA)
        evid = sum(1 for itens in coef_por.values() if codigo in itens)
        if evid >= 2 and largura <= 0.0050001:
            i["status"] = "CONFIRMADO"
        elif evid >= 1 and largura <= 0.0200001:
            i["status"] = "DERIVADO"
        else:
            continue
        i["p"] = round((lo + hi) / 2, PRECISAO_INTERNA)
        i["p_sem_bdi"] = i["p"]
        i["faixa"] = [round(lo, PRECISAO_INTERNA), round(hi, PRECISAO_INTERNA)]
        i["evidencias"] = evid
        i["metodo"] = "LP_GLOBAL_TRUNCAMENTO_FDE"
        promovidos.append(codigo)

# Novos bounds após as promoções.
bounds2 = []
for i in insumos:
    faixa = i.get("faixa")
    if i.get("status") in {"CONFIRMADO", "DERIVADO"} and faixa and len(faixa) == 2:
        bounds2.append((max(0.0, float(faixa[0])), float(faixa[1])))
    else:
        bounds2.append((0.0, None))

# Em vez de aceitar um ponto que encoste na fronteira, maximizamos uma margem t
# para TODAS as composições cujos insumos já têm preço classificado. Com isso o
# JSON publicado permanece estável mesmo após serialização em ponto flutuante.
utilizaveis = {i["c"] for i in insumos if i.get("status") in {"CONFIRMADO", "DERIVADO"}}
tcol = np.zeros(A_ub.shape[0], dtype=float)
completas_para_margem = 0
for pos, cod_comp in enumerate(comps_com_linha):
    itens = coef_por[cod_comp]
    completa = all(cod_i in utilizaveis for cod_i in itens)
    if completa:
        tcol[2 * pos] = 1.0
        tcol[2 * pos + 1] = 1.0
        completas_para_margem += 1

A_interior = hstack([A_ub, csr_matrix(tcol).T], format="csr")
obj_interior = np.zeros(n + 1, dtype=float)
obj_interior[-1] = -1.0
largura_meia = 0.01 / FATOR_BDI / 2.0
bounds_interior = bounds2 + [(0.0, largura_meia - 1e-10)]
interior = linprog(obj_interior, A_ub=A_interior, b_ub=b_ub, bounds=bounds_interior, method="highs")
if not interior.success:
    raise RuntimeError(f"Não foi possível construir ponto interior FDE: {interior.message}")
x2 = interior.x[:n]
margem_interior = float(interior.x[-1])

for j, i in enumerate(insumos):
    if i.get("status") in {"CONFIRMADO", "DERIVADO"}:
        i["p"] = round(float(x2[j]), PRECISAO_INTERNA)
        i["p_sem_bdi"] = i["p"]
        i["solucao_global"] = True

# Valida com os mesmos valores de alta precisão publicados no JSON.
def trunc2(v):
    return math.floor((v + 1e-10) * 100.0) / 100.0

precos = {i["c"]: i.get("p") for i in insumos if i.get("p") is not None}
linhas = []
ok = incompletas = divergentes = 0
amostra_divergentes = []
for c in composicoes:
    itens = coef_por.get(c["c"], {})
    faltantes = sorted(cod_i for cod_i in itens if cod_i not in precos)
    if faltantes:
        incompletas += 1
        linhas.append({"c": c["c"], "oficial": c["p"], "situacao": "INCOMPLETA", "insumos_sem_preco": faltantes})
        continue
    sem_bdi = sum(k * float(precos[cod_i]) for cod_i, k in itens.items())
    com_bdi = sem_bdi * FATOR_BDI
    publicado = trunc2(com_bdi)
    bate = abs(publicado - float(c["p"])) < 0.005
    if bate:
        ok += 1
    else:
        divergentes += 1
        if len(amostra_divergentes) < 50:
            amostra_divergentes.append({"c": c["c"], "oficial": c["p"], "recalculado": publicado, "bruto": com_bdi})
    linhas.append({
        "c": c["c"], "oficial": c["p"], "custo_sem_bdi": round(sem_bdi, PRECISAO_INTERNA),
        "recalculado_com_bdi": round(com_bdi, PRECISAO_INTERNA), "publicado_recalculado": round(publicado, 2),
        "diferenca": round(publicado - float(c["p"]), 4),
        "situacao": "OK" if bate else "DIVERGENTE", "insumos_sem_preco": []
    })

status = defaultdict(int)
for i in insumos:
    status[i["status"]] += 1
resumo_validacao = {
    "composicoes": len(composicoes), "ok": ok, "incompletas": incompletas,
    "divergentes": divergentes,
    "percentual_ok_total": round(ok / len(composicoes) * 100, 4),
    "percentual_ok_das_completas": round(ok / (ok + divergentes) * 100, 4) if ok + divergentes else 0,
    "regra": "custo_oficial = truncar_centavos(custo_sem_bdi * 1.23)",
}

(base / "insumos.json").write_text(json.dumps(insumos, ensure_ascii=False, separators=(",", ":")))
(base / "validacao.json").write_text(json.dumps({"resumo": resumo_validacao, "composicoes": linhas}, ensure_ascii=False, separators=(",", ":")))

meta_path = base / "meta.json"
meta = json.loads(meta_path.read_text())
meta["contagens"]["status_precos"] = dict(status)
meta["contagens"]["validacao"] = resumo_validacao
meta["lp_global"] = {
    "viavel": True,
    "precisao_interna_casas": PRECISAO_INTERNA,
    "componentes_analisados_ate": MAX_COMPONENTE_PARA_INTERVALOS,
    "intervalos_calculados": intervalos_lp,
    "falhas": falhas_lp,
    "precos_promovidos": len(promovidos),
    "composicoes_com_margem": completas_para_margem,
    "margem_interior_sem_bdi": margem_interior,
    "divergentes_amostra": amostra_divergentes,
    "promovidos_amostra": promovidos[:100],
}
meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))

print(json.dumps({
    "viavel": True,
    "intervalos_lp": intervalos_lp,
    "falhas_lp": falhas_lp,
    "promovidos": len(promovidos),
    "margem_interior_sem_bdi": margem_interior,
    "status_precos": dict(status),
    "validacao": resumo_validacao,
}, ensure_ascii=False, indent=2))
