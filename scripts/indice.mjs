// Gera index.json com todas as competências disponíveis em data/ (mais recente primeiro).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const competencias = readdirSync("data")
  .filter((d) => /^\d{4}-\d{2}$/.test(d) && existsSync(`data/${d}/meta.json`))
  .sort()
  .reverse()
  .map((d) => {
    const m = JSON.parse(readFileSync(`data/${d}/meta.json`, "utf8"));
    return { competencia: d, emissao: m.emissao, contagens: m.contagens, sha256: m.sha256, arquivos: m.arquivos };
  });
writeFileSync("index.json", JSON.stringify({ uf: "SP", atualizado_em: new Date().toISOString(), competencias }, null, 2));
console.log(competencias.map((c) => c.competencia).join(", "));
