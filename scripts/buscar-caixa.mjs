// Consulta a API pública de downloads da Caixa e baixa o pacote xlsx mais recente do SINAPI
// (categoria "SINAPI - Relatórios mensais - a partir de 2025"). Imprime a competência baixada
// ou "nada" se ela já existe em data/.
import { existsSync, writeFileSync } from "node:fs";
const BASE = "https://www.caixa.gov.br";
const CATEGORIA = 888;
const UA = { "User-Agent": "Mozilla/5.0 (sinapi-sp-dados)" };
let cookie = "";
async function get(url, extra = {}) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: { ...UA, ...extra, ...(cookie ? { cookie } : {}) }, redirect: "manual" });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get("location"), url).toString(); continue; }
    if (!r.ok) throw new Error(`${r.status} em ${url}`);
    return r;
  }
  throw new Error(`Muitos redirecionamentos em ${url}`);
}
await get(`${BASE}/poder-publico/modernizacao-gestao/sinapi/Paginas/default.aspx`);
const api = `${BASE}/_api/web/lists/getbytitle('Downloads')/Items?$select=Title,FileLeafRef,EncodedAbsUrl,Modified,Categoria/ID&$expand=Categoria&$filter=Categoria/ID%20eq%20${CATEGORIA}&$top=50&$orderby=Modified%20desc`;
const lista = await (await get(api, { Accept: "application/json;odata=nometadata" })).json();
const xlsx = (lista.value ?? [])
  .map((i) => ({ ...i, m: /SINAPI-(\d{4})-(\d{2})-formato-xlsx\.zip$/i.exec(i.FileLeafRef) }))
  .filter((i) => i.m)
  .sort((a, b) => (a.m[1] + a.m[2] < b.m[1] + b.m[2] ? 1 : -1))[0];
if (!xlsx) throw new Error("Nenhum pacote xlsx do SINAPI encontrado na API da Caixa.");
const competencia = `${xlsx.m[1]}-${xlsx.m[2]}`;
if (existsSync(`data/${competencia}/meta.json`)) { console.log("nada"); process.exit(0); }
const zip = Buffer.from(await (await get(xlsx.EncodedAbsUrl.replace("http:", "https:"))).arrayBuffer());
if (zip.length < 1_000_000) throw new Error(`Pacote suspeito (${zip.length} bytes).`);
writeFileSync("sinapi.zip", zip);
console.log(competencia);
