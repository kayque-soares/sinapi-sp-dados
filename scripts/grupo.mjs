// Normaliza o nome do grupo da composição para casar com o nome do PDF do Caderno Técnico:
// sem acento, maiúsculas, tudo que não for letra/número vira hífen.
// "Fundações Rasas (Blocos, Sapatas, Vigas Baldrame)" -> "FUNDACOES-RASAS-BLOCOS-SAPATAS-VIGAS-BALDRAME"
export function slugGrupo(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
