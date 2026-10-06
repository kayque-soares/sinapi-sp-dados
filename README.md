# SINAPI SP — dados normalizados

Dados **públicos** do SINAPI (Sistema Nacional de Pesquisa de Custos e Índices da Construção Civil,
Caixa Econômica Federal), extraídos do pacote mensal oficial e filtrados para **São Paulo**, com e sem
desoneração.

- `data/AAAA-MM/insumos.json` — `c` código, `d` descrição, `u` unidade, `cl` classificação, `sd`/`cd` preço SP sem/com desoneração
- `data/AAAA-MM/composicoes.json` — `c`, `d`, `u`, `g` grupo, `sd`/`cd` custo SP sem/com desoneração
- `data/AAAA-MM/estrutura.json` — analítico: `c` composição, `t` I (insumo) ou C (composição), `i` item, `k` coeficiente
- `index.json` — competências disponíveis; `latest.json` — a mais recente

Uma GitHub Action consulta diariamente (dias 3 a 25) a API de downloads da Caixa e publica a nova
competência assim que sai. Fonte: <https://www.caixa.gov.br/sinapi>.
