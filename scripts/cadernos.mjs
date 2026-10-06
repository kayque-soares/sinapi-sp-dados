// Lista os Cadernos Técnicos do SINAPI publicados pela Caixa (pasta Downloads/sinapi-cadernos-tecnicos)
// e grava cadernos.json: { "<GRUPO-NORMALIZADO>": "https://www.caixa.gov.br/Downloads/...pdf" }.
// O nome do PDF segue o grupo da composição: "Paredes de Concreto - Armação" ->
// SINAPI-CT-PAREDES-DE-CONCRETO-ARMACAO.pdf. Se a consulta falhar, mantém o cadernos.json anterior.
import { existsSync, writeFileSync } from "node:fs";
import { slugGrupo } from "./grupo.mjs";

const BASE = "https://www.caixa.gov.br";
const PASTA = "/Downloads/sinapi-cadernos-tecnicos";
const UA = { "User-Agent": "Mozilla/5.0 (sinapi-sp-dados)" };
let cookie = "";

async function get(url, extra = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, {
      headers: { ...UA, ...extra, ...(cookie ? { cookie } : {}) },
      redirect: "manual",
    });
    const sc = r.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    if (r.status >= 300 && r.status < 400) {
      url = new URL(r.headers.get("location"), url).toString();
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} em ${url}`);
    return r;
  }
  throw new Error(`Muitos redirecionamentos em ${url}`);
}

try {
  await get(`${BASE}/poder-publico/modernizacao-gestao/sinapi/Paginas/default.aspx`);
  const api = `${BASE}/_api/web/GetFolderByServerRelativeUrl('${PASTA}')/Files?$select=Name&$top=5000`;
  const lista = await (await get(api, { Accept: "application/json;odata=nometadata" })).json();
  const nomes = (lista.value ?? []).map((f) => f.Name).filter((n) => /^SINAPI-CT-.+\.pdf$/i.test(n));
  if (nomes.length < 50) throw new Error(`poucos cadernos (${nomes.length})`);
  const mapa = {};
  for (const nome of nomes.sort()) {
    mapa[slugGrupo(nome.replace(/^SINAPI-CT-/i, "").replace(/\.pdf$/i, ""))] =
      `${BASE}${PASTA}/${encodeURIComponent(nome)}`;
  }
  writeFileSync("cadernos.json", JSON.stringify(mapa, null, 1));
  console.log(`cadernos: ${nomes.length}`);
} catch (error) {
  if (!existsSync("cadernos.json")) throw error;
  console.warn(`Cadernos não atualizados (${error.message}); mantendo cadernos.json anterior.`);
}
