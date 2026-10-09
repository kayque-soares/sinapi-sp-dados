import json
import sys
from collections import defaultdict
from pathlib import Path

base = Path(sys.argv[1] if len(sys.argv) > 1 else "fde/2022-04")
BDI = 0.23
FATOR_BDI = 1 + BDI

composicoes = json.loads((base / "composicoes.json").read_text())
estrutura = json.loads((base / "estrutura.json").read_text())

por_comp = defaultdict(lambda: defaultdict(float))
for e in estrutura:
    por_comp[e["c"]][e["i"]] += float(e["k"])

# Para composição com um único insumo, o custo oficial publicado permite
# construir diretamente uma faixa para o preço unitário do insumo.
# Testamos duas hipóteses para o Custo Total (já com BDI de 23%):
# 1) arredondamento convencional a centavos: valor real em [C-0,005, C+0,005)
# 2) truncamento a centavos: valor real em [C, C+0,01)

def faixa(custo_publicado, coef, modo):
    if modo == "arredondamento":
        lo = max(0.0, custo_publicado - 0.005) / FATOR_BDI / coef
        hi = (custo_publicado + 0.005) / FATOR_BDI / coef
    elif modo == "truncamento":
        lo = custo_publicado / FATOR_BDI / coef
        hi = (custo_publicado + 0.01) / FATOR_BDI / coef
    else:
        raise ValueError(modo)
    return lo, hi

singles = []
for c in composicoes:
    itens = por_comp.get(c["c"], {})
    if len(itens) == 1:
        codigo, coef = next(iter(itens.items()))
        singles.append((c["c"], codigo, coef, float(c["p"])))

por_insumo = defaultdict(list)
for cod_comp, cod_i, k, custo in singles:
    por_insumo[cod_i].append((cod_comp, k, custo))

resultado = {
    "bdi": BDI,
    "fator_bdi": FATOR_BDI,
    "composicoes_um_insumo": len(singles),
    "insumos_com_equacao_isolada": len(por_insumo),
    "hipoteses": {},
    "amostras": {},
}

for modo in ["arredondamento", "truncamento"]:
    coerentes = 0
    incoerentes = 0
    multiplas = 0
    larguras = []
    detalhes = []
    for cod_i, eqs in sorted(por_insumo.items()):
        lo = 0.0
        hi = float("inf")
        for cod_comp, k, custo in eqs:
            a, b = faixa(custo, k, modo)
            lo = max(lo, a)
            hi = min(hi, b)
        ok = hi > lo
        if len(eqs) >= 2:
            multiplas += 1
        if ok:
            coerentes += 1
            larguras.append(hi-lo)
        else:
            incoerentes += 1
        if len(eqs) >= 2 or cod_i in {"1.01.46", "1.01.39"}:
            detalhes.append({
                "insumo": cod_i,
                "equacoes": len(eqs),
                "coerente": ok,
                "faixa_intersecao": [round(lo, 8), round(hi, 8)] if ok else None,
                "preco_central": round((lo+hi)/2, 8) if ok else None,
                "composicoes": [x[0] for x in eqs[:30]],
            })
    resultado["hipoteses"][modo] = {
        "insumos_coerentes": coerentes,
        "insumos_incoerentes": incoerentes,
        "insumos_com_multiplas_equacoes": multiplas,
        "largura_max_intersecao": max(larguras) if larguras else None,
        "largura_mediana_intersecao": sorted(larguras)[len(larguras)//2] if larguras else None,
    }
    resultado["amostras"][modo] = detalhes[:100]

# Evidência conhecida/publicável para conferência manual:
# serviço 13.50.002 oficial FDE abril/2022 e seus coeficientes.
for modo in ["arredondamento", "truncamento"]:
    eqs_serv = por_insumo.get("1.01.46", [])
    lo = 0.0
    hi = float("inf")
    for cod_comp, k, custo in eqs_serv:
        a, b = faixa(custo, k, modo)
        lo = max(lo, a); hi = min(hi, b)
    resultado[f"servente_{modo}"] = {
        "faixa": [round(lo, 8), round(hi, 8)] if hi > lo else None,
        "equacoes": len(eqs_serv),
    }

(base / "diagnostico-centavos.json").write_text(json.dumps(resultado, ensure_ascii=False, indent=2))
print(json.dumps(resultado, ensure_ascii=False, indent=2))
