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

## CDHU — Boletim Referencial de Custos (SP)

A CDHU publica o boletim em PDF. `cdhu/extrair.mjs` lê os PDFs pela posição do texto na página e grava
`cdhu/<versão>/{insumos,composicoes,estrutura,meta}.json` e `cdhu/index.json`:

```bash
node cdhu/extrair.mjs <pasta com insumos.NNN.pdf, servicos.NNN-sd.pdf e composicao.NNN.pdf>
```

- Versão, data-base e Leis Sociais são lidas do próprio PDF.
- Mão de obra horária (B.01, unidade H) é gravada já com Leis Sociais (`p`); `p0` guarda o preço do relatório de insumos.
- O script aborta se Σ coeficiente × preço não reproduzir o custo oficial de pelo menos 99% dos serviços.
