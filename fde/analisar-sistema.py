import json
import sys
from collections import defaultdict, Counter
from pathlib import Path

base = Path(sys.argv[1] if len(sys.argv) > 1 else "fde/2022-04")
insumos = json.loads((base / "insumos.json").read_text())
composicoes = json.loads((base / "composicoes.json").read_text())
estrutura = json.loads((base / "estrutura.json").read_text())

preco = {i["c"]: i.get("p") for i in insumos}
status = {i["c"]: i.get("status") for i in insumos}
desconhecidos = {c for c, p in preco.items() if p is None}

itens_por_comp = defaultdict(list)
for e in estrutura:
    itens_por_comp[e["c"]].append(e["i"])

# Union-find: duas incógnitas pertencem ao mesmo componente se aparecem
# juntas em pelo menos uma composição. Valores já determinados não conectam
# componentes, pois sua contribuição pode ser subtraída da equação.
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

for cod_comp, itens in itens_por_comp.items():
    u = sorted({i for i in itens if i in desconhecidos})
    if len(u) > 1:
        raiz = u[0]
        for x in u[1:]:
            union(raiz, x)

grupos = defaultdict(set)
for c in desconhecidos:
    grupos[find(c)].add(c)

# Cada equação só pode tocar um componente de incógnitas após o union acima.
eq_por_grupo = defaultdict(set)
grau = Counter()
for cod_comp, itens in itens_por_comp.items():
    u = {i for i in itens if i in desconhecidos}
    for i in u:
        grau[i] += 1
    if u:
        roots = {find(i) for i in u}
        if len(roots) != 1:
            raise RuntimeError(f"Equação {cod_comp} toca {len(roots)} componentes")
        eq_por_grupo[next(iter(roots))].add(cod_comp)

componentes = []
for root, vars_ in grupos.items():
    eqs = eq_por_grupo[root]
    componentes.append({
        "variaveis": len(vars_),
        "equacoes": len(eqs),
        "superdeterminado_estrutural": len(eqs) >= len(vars_),
        "codigos": sorted(vars_) if len(vars_) <= 20 else sorted(vars_)[:20],
    })
componentes.sort(key=lambda x: (-x["variaveis"], -x["equacoes"]))

potencial = sum(c["variaveis"] for c in componentes if c["superdeterminado_estrutural"])
isolados = sum(1 for c in componentes if c["variaveis"] == 1)
sem_equacao = sum(1 for c in desconhecidos if grau[c] == 0)

resumo = {
    "insumos_total": len(insumos),
    "precos_ja_utilizaveis": len(insumos) - len(desconhecidos),
    "desconhecidos": len(desconhecidos),
    "status_desconhecidos": dict(Counter(status[c] for c in desconhecidos)),
    "componentes": len(componentes),
    "componentes_isolados": isolados,
    "maior_componente_variaveis": max((c["variaveis"] for c in componentes), default=0),
    "maior_componente_equacoes": max((c["equacoes"] for c in componentes), default=0),
    "variaveis_em_componentes_com_equacoes_suficientes": potencial,
    "desconhecidos_sem_equacao": sem_equacao,
    "distribuicao_ocorrencias": dict(sorted(Counter(grau.values()).items())),
    "top_componentes": componentes[:50],
}

(base / "sistema.json").write_text(json.dumps(resumo, ensure_ascii=False, indent=2))
print(json.dumps(resumo, ensure_ascii=False, indent=2))
