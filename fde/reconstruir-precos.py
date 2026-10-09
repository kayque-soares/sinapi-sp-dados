import json
import math
import sys
from collections import defaultdict
from pathlib import Path

base = Path(sys.argv[1] if len(sys.argv) > 1 else "fde/2022-04")
BDI = 0.23
FATOR_BDI = 1.23
TOL = 1e-10

insumos = json.loads((base / "insumos.json").read_text())
composicoes = json.loads((base / "composicoes.json").read_text())
estrutura = json.loads((base / "estrutura.json").read_text())

# O PDF FDE abril/2022 publica Custo Total com BDI=23%.
# Evidência empírica sobre todas as composições de um único insumo mostra
# truncamento do custo final a centavos. Logo, para custo publicado C:
#   C <= custo_sem_bdi * 1,23 < C + 0,01
# e portanto:
#   C/1,23 <= custo_sem_bdi < (C+0,01)/1,23
#
# O p reconstruído abaixo é o preço unitário equivalente SEM BDI.
# Para mão de obra, ele representa o custo de mão de obra compatível com a
# composição FDE (encargos sociais já refletidos no custo efetivo da MO), e
# não deve ser confundido com salário-hora nominal sem encargos.

coef_por = defaultdict(lambda: defaultdict(float))
for e in estrutura:
    coef_por[e["c"]][e["i"]] += float(e["k"])

comp_por = {c["c"]: c for c in composicoes}
faixas = {
    i["c"]: {"lo": 0.0, "hi": math.inf, "evidencias": set(), "divergente": False}
    for i in insumos
}

def intervalo_comp(custo_publicado):
    c = float(custo_publicado)
    return c / FATOR_BDI, (c + 0.01) / FATOR_BDI

def aplicar(codigo, lo, hi, evidencia):
    f = faixas[codigo]
    lo = max(0.0, lo)
    if not (math.isfinite(lo) and math.isfinite(hi)) or hi <= 0:
        return False
    novo_lo = max(f["lo"], lo)
    novo_hi = min(f["hi"], hi)
    if novo_hi <= novo_lo + TOL:
        # Só marca divergência se a interseção for realmente vazia, não se for
        # um artefato numérico de ponto flutuante.
        if novo_hi < novo_lo - 1e-8:
            f["divergente"] = True
        return False
    mudou = novo_lo > f["lo"] + 1e-9 or novo_hi < f["hi"] - 1e-9
    f["lo"] = novo_lo
    f["hi"] = novo_hi
    f["evidencias"].add(evidencia)
    return mudou

# Propagação intervalar conservadora. Uma variável só recebe limite quando as
# demais da mesma equação já têm limites superiores finitos, ou quando é a
# única variável ainda ilimitada.
for _rodada in range(500):
    alteracoes = 0
    for cod_comp, itens in coef_por.items():
        c = comp_por.get(cod_comp)
        if not c or c.get("p") is None or not itens:
            continue
        custo_lo, custo_hi = intervalo_comp(c["p"])
        infinitos = [i for i in itens if not math.isfinite(faixas[i]["hi"])]
        if len(infinitos) == 1:
            alvos = infinitos
        elif len(infinitos) == 0:
            alvos = list(itens)
        else:
            continue

        for alvo in alvos:
            k_alvo = itens[alvo]
            if k_alvo <= 0:
                continue
            outros_lo = 0.0
            outros_hi = 0.0
            valido = True
            for cod_i, k in itens.items():
                if cod_i == alvo:
                    continue
                f = faixas[cod_i]
                if not math.isfinite(f["hi"]):
                    valido = False
                    break
                outros_lo += k * f["lo"]
                outros_hi += k * f["hi"]
            if not valido:
                continue
            lo = (custo_lo - outros_hi) / k_alvo
            hi = (custo_hi - outros_lo) / k_alvo
            if aplicar(alvo, lo, hi, cod_comp):
                alteracoes += 1
    if alteracoes == 0:
        break

mapa = {i["c"]: i for i in insumos}
for codigo, f in faixas.items():
    i = mapa[codigo]
    # Remove os resultados do algoritmo antigo para não misturar semânticas.
    i["p"] = None
    i["p_sem_bdi"] = None
    i["status"] = "NAO_DETERMINADO"
    i["faixa"] = None
    i["evidencias"] = len(f["evidencias"])
    i["preco_natureza"] = "FDE_EQUIVALENTE_SEM_BDI"

    if f["divergente"]:
        i["status"] = "DIVERGENTE"
        if math.isfinite(f["hi"]):
            i["faixa"] = [round(f["lo"], 6), round(f["hi"], 6)]
        continue
    if not math.isfinite(f["hi"]):
        continue

    largura = f["hi"] - f["lo"]
    meio = (f["lo"] + f["hi"]) / 2
    i["faixa"] = [round(f["lo"], 6), round(f["hi"], 6)]

    # Critérios conservadores. CONFIRMADO exige múltiplas composições e faixa
    # máxima de meio centavo. DERIVADO aceita faixa até 2 centavos.
    if len(f["evidencias"]) >= 2 and largura <= 0.0050001:
        i["status"] = "CONFIRMADO"
        i["p"] = round(meio, 4)
        i["p_sem_bdi"] = i["p"]
    elif len(f["evidencias"]) >= 1 and largura <= 0.0200001:
        i["status"] = "DERIVADO"
        i["p"] = round(meio, 4)
        i["p_sem_bdi"] = i["p"]

# Validação: recalcula custo sem BDI, aplica 23% e trunca a centavos.
def trunc2(x):
    return math.floor((x + 1e-9) * 100) / 100

preco = {i["c"]: i["p"] for i in insumos if i.get("p") is not None}
validacoes = []
ok = incompletas = divergentes = 0

for c in composicoes:
    itens = coef_por.get(c["c"], {})
    faltantes = sorted({cod_i for cod_i in itens if cod_i not in preco})
    if faltantes:
        incompletas += 1
        validacoes.append({
            "c": c["c"], "oficial": c["p"], "custo_sem_bdi": None,
            "recalculado_com_bdi": None, "publicado_recalculado": None,
            "diferenca": None, "situacao": "INCOMPLETA",
            "insumos_sem_preco": faltantes,
        })
        continue

    sem_bdi = sum(itens[cod_i] * preco[cod_i] for cod_i in itens)
    com_bdi = sem_bdi * FATOR_BDI
    publicado = trunc2(com_bdi)
    bate = abs(publicado - float(c["p"])) < 0.005
    if bate:
        ok += 1
    else:
        divergentes += 1
    validacoes.append({
        "c": c["c"],
        "oficial": c["p"],
        "custo_sem_bdi": round(sem_bdi, 4),
        "recalculado_com_bdi": round(com_bdi, 4),
        "publicado_recalculado": round(publicado, 2),
        "diferenca": round(publicado - float(c["p"]), 4),
        "situacao": "OK" if bate else "DIVERGENTE",
        "insumos_sem_preco": [],
    })

status = defaultdict(int)
for i in insumos:
    status[i["status"]] += 1

resumo = {
    "composicoes": len(composicoes),
    "ok": ok,
    "incompletas": incompletas,
    "divergentes": divergentes,
    "percentual_ok_total": round(ok / len(composicoes) * 100, 4) if composicoes else 0,
    "percentual_ok_das_completas": round(ok / (ok + divergentes) * 100, 4) if ok + divergentes else 0,
    "regra": "custo_oficial = truncar_centavos(custo_sem_bdi * 1.23)",
}

(base / "insumos.json").write_text(json.dumps(insumos, ensure_ascii=False, separators=(",", ":")))
(base / "validacao.json").write_text(json.dumps({"resumo": resumo, "composicoes": validacoes}, ensure_ascii=False, separators=(",", ":")))

meta_path = base / "meta.json"
meta = json.loads(meta_path.read_text())
meta["modelo_precos"] = {
    "bdi": BDI,
    "fator_bdi": FATOR_BDI,
    "regra_centavos": "TRUNCAMENTO",
    "preco_insumo": "equivalente sem BDI; mão de obra com encargos refletidos no custo efetivo",
}
meta["contagens"]["status_precos"] = dict(status)
meta["contagens"]["validacao"] = resumo
meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))

print(json.dumps({
    "status_precos": dict(status),
    "validacao": resumo,
    "servente": next((i for i in insumos if i["c"] == "1.01.46"), None),
    "pedreiro": next((i for i in insumos if i["c"] == "1.01.39"), None),
}, ensure_ascii=False, indent=2))
