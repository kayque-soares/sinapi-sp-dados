import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

base = Path(sys.argv[1] if len(sys.argv) > 1 else "fde/2022-04")
insumos = json.loads((base / "insumos.json").read_text())
composicoes = json.loads((base / "composicoes.json").read_text())
estrutura = json.loads((base / "estrutura.json").read_text())

preco = {i["c"]: i.get("p") for i in insumos}
desconhecidos = {c for c, p in preco.items() if p is None}
custo = {c["c"]: float(c["p"]) for c in composicoes}

coef_por_comp = defaultdict(lambda: defaultdict(float))
for e in estrutura:
    coef_por_comp[e["c"]][e["i"]] += float(e["k"])

parent = {c: c for c in desconhecidos}
size = {c: 1 for c in desconhecidos}

def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x

def union(a, b):
    ra, rb = find(a), find(b)
    if ra == rb:
        return
    if size[ra] < size[rb]:
        ra, rb = rb, ra
    parent[rb] = ra
    size[ra] += size[rb]

for itens in coef_por_comp.values():
    u = [i for i in itens if i in desconhecidos]
    if len(u) > 1:
        for x in u[1:]:
            union(u[0], x)

grupos = defaultdict(set)
for c in desconhecidos:
    grupos[find(c)].add(c)

eqs_por_grupo = defaultdict(set)
for cod_comp, itens in coef_por_comp.items():
    u = [i for i in itens if i in desconhecidos]
    if u:
        eqs_por_grupo[find(u[0])].add(cod_comp)

resultados = []
for root, vars_set in sorted(grupos.items(), key=lambda kv: -len(kv[1])):
    vars_ = sorted(vars_set)
    eqs = sorted(eqs_por_grupo[root])
    n, m = len(vars_), len(eqs)
    item_idx = {c: j for j, c in enumerate(vars_)}
    A = np.zeros((m, n), dtype=np.float64)
    b = np.zeros(m, dtype=np.float64)

    for r, cod_comp in enumerate(eqs):
        alvo = custo[cod_comp]
        for cod_i, k in coef_por_comp[cod_comp].items():
            if cod_i in item_idx:
                A[r, item_idx[cod_i]] += k
            else:
                p = preco.get(cod_i)
                if p is None:
                    raise RuntimeError(f"{cod_comp}: preço ausente fora do componente: {cod_i}")
                alvo -= k * float(p)
        b[r] = alvo

    reg = {
        "variaveis": n,
        "equacoes": m,
        "codigos_amostra": vars_[:20],
    }
    if m < n:
        reg.update({"rank": None, "rank_completo": False, "motivo": "menos_equacoes_que_variaveis"})
        resultados.append(reg)
        continue

    x, residuals, rank, s = np.linalg.lstsq(A, b, rcond=None)
    erro = A @ x - b
    abs_erro = np.abs(erro)
    cond = float(s[0] / s[-1]) if len(s) and s[-1] > 0 else None
    negativos = int(np.sum(x < -1e-7))
    reg.update({
        "rank": int(rank),
        "rank_completo": int(rank) == n,
        "condicao": cond,
        "preco_min": float(np.min(x)) if len(x) else None,
        "preco_max": float(np.max(x)) if len(x) else None,
        "precos_negativos": negativos,
        "residuo_max_abs": float(np.max(abs_erro)) if len(abs_erro) else 0.0,
        "residuo_p95_abs": float(np.percentile(abs_erro, 95)) if len(abs_erro) else 0.0,
        "residuo_mediano_abs": float(np.median(abs_erro)) if len(abs_erro) else 0.0,
        "residuo_rms": float(np.sqrt(np.mean(erro ** 2))) if len(erro) else 0.0,
        "equacoes_ate_0_005": int(np.sum(abs_erro <= 0.0050001)),
        "equacoes_ate_0_01": int(np.sum(abs_erro <= 0.0100001)),
        "equacoes_ate_0_02": int(np.sum(abs_erro <= 0.0200001)),
    })
    resultados.append(reg)

resumo = {
    "componentes": resultados,
    "variaveis_rank_completo": sum(r["variaveis"] for r in resultados if r.get("rank_completo")),
    "variaveis_sem_rank_completo": sum(r["variaveis"] for r in resultados if not r.get("rank_completo")),
}
(base / "solucao-global.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=2))
print(json.dumps(resumo, ensure_ascii=False, indent=2))
