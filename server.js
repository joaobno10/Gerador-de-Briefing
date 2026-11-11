// Gerador de Briefing — servidor MCP (Streamable HTTP)
// Sem dependências externas e SEM API paga: quem revisa o texto é o próprio ChatGPT.
// Basta Node 18+ e rodar `node server.js`.
//
// Fluxo:
//   1. ChatGPT chama abrir_formulario_briefing  -> abre o formulário
//   2. Formulário chama preparar_briefing        -> servidor guarda os dados e devolve um código
//   3. Formulário manda no chat "Gerar briefing … (#código)"
//   4. ChatGPT chama obter_dados_briefing         -> recebe os dados + as regras de diretor de arte
//   5. ChatGPT revisa e chama exibir_briefing     -> o briefing final aparece num cartão com Copiar
//
// Endpoints:
//   POST /mcp        -> protocolo MCP (JSON-RPC)
//   POST /api/gerar  -> usado só pelo modo teste (/preview)
//   GET  /           -> página de status
//   GET  /preview    -> abre o formulário direto no navegador (modo teste)

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const SERVER_INFO = { name: "gerador-briefing", title: "Gerador de Briefing", version: "2.0.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const UI_URI = "ui://gerador-briefing/formulario.html";
const UI_MIME = "text/html;profile=mcp-app";
const FORM_PATH = join(__dirname, "public", "formulario.html");
const formHtml = () => readFileSync(FORM_PATH, "utf8");

// ------------------------------------------------------------------ dados guardados (2 horas)
const GUARDADOS = new Map();
const TTL = 2 * 60 * 60 * 1000;
function guardar(texto) {
  const agora = Date.now();
  for (const [k, v] of GUARDADOS) if (agora - v.t > TTL) GUARDADOS.delete(k);
  const id = randomBytes(3).toString("hex");
  GUARDADOS.set(id, { texto, t: agora });
  return id;
}

// ------------------------------------------------------------------ regras do diretor de arte
const REGRAS_DA = `Você agora age como DIRETOR DE ARTE SÊNIOR de uma agência de publicidade (varejo automotivo e marcas do grupo).
Abaixo está o briefing montado pelo formulário. Reescreva SOMENTE as seções DIRECIONAMENTO e INFORMAÇÕES ADICIONAIS, para que o designer entenda, sem precisar perguntar nada, o que criar e o que deve ter destaque.

Regras da reescrita:
- Traduza a intenção do atendimento em orientações claras e acionáveis: objetivo da peça, mensagem principal, hierarquia (o que vem primeiro, o que tem mais destaque), tom e chamada/CTA, quando estiverem nos dados.
- Use SOMENTE o que está nos dados. Não invente preços, condições, datas, modelos, slogans, cores, fotos ou elementos. Não suponha o que estiver ambíguo.
- Mantenha valores, condições, nomes e datas exatamente como vieram.
- Tópicos curtos ("- "), sem introdução, sem elogio, sem frases genéricas ("peça impactante", "chamar a atenção"), sem repetir ideias.
- Não copie para o direcionamento o que já está em Peças, Obrigatoriedades, O que não fazer ou Recusado pelo cliente: considere, mas não repita.
- Se INFORMAÇÕES ADICIONAIS não existir no briefing, não crie a seção.

Todas as outras seções e linhas ficam EXATAMENTE iguais (mesmos títulos, mesma ordem, mesmos links).

Depois, chame a ferramenta exibir_briefing com o briefing COMPLETO final em texto puro (mesmo formato, sem markdown).
NÃO escreva o briefing no chat e não comente nada: depois de chamar exibir_briefing, no máximo uma frase curta.`;

// ------------------------------------------------------------------ montagem do briefing (texto)
function montarBriefing(d = {}) {
  const j = d.job || {}; const c = d.complementos || {};
  const L = [];
  const secao = (titulo, corpo) => { if (corpo && String(corpo).trim()) L.push("", titulo, String(corpo).trim()); };

  L.push(`BRIEFING — ${j.nome || "(sem nome)"}`);
  L.push(`Tipo: ${j.tipo || "—"}`);
  if (d.status === "PENDENTE") {
    L.push("", "⚠ PENDENTE — briefing não validado");
    if (d.pendencias && d.pendencias.length) L.push("Pendências: " + d.pendencias.join("; "));
  }
  if (j.link_anterior || j.o_que_mudar || j.recusado) {
    const r = [];
    if (j.link_anterior) r.push(`Peça anterior: ${j.link_anterior}`);
    if (j.o_que_mudar) r.push(`O que mudar e por quê: ${j.o_que_mudar}`);
    if (j.recusado) r.push(`Recusado pelo cliente (não repetir): ${j.recusado}`);
    secao((j.tipo || "AJUSTE").toUpperCase(), r.join("\n"));
  }
  secao("DIRECIONAMENTO", j.direcionamento);
  secao("INFORMAÇÕES ADICIONAIS", j.info_adicionais);
  if (d.obrigatoriedades && d.obrigatoriedades.length) {
    secao("OBRIGATORIEDADES", d.obrigatoriedades
      .map(o => `• ${o.item}: ${o.descricao || "—"}${o.link ? ` — ${o.link}` : ""}`).join("\n"));
  }
  const pecas = d.pecas || [];
  const total = pecas.reduce((a, p) => a + (Number(p.quantidade) || 0), 0);
  secao(`PEÇAS (total: ${total})`, pecas.length ? pecas.map(p =>
    `• ${p.peca} — ${p.largura || "?"} × ${p.altura || "?"} ${p.unidade}${p.observacao ? ` (${p.observacao})` : ""} — ${p.quantidade || "?"} un.`
  ).join("\n") : "Nenhuma peça selecionada.");
  secao("CASOS ANTERIORES", c.casos_anteriores);
  secao("REFERÊNCIAS", c.referencias);
  secao("O QUE NÃO FAZER", c.nao_fazer);
  const arq = [];
  if (c.link_arquivos) arq.push(`Onde encontrar: ${c.link_arquivos}`);
  if (c.link_salvamento) arq.push(`Onde salvar: ${c.link_salvamento}`);
  secao("ARQUIVOS", arq.join("\n"));
  return L.join("\n");
}

// ------------------------------------------------------------------ ferramentas
const UI_META = {
  ui: { resourceUri: UI_URI },
  "openai/outputTemplate": UI_URI,
  "openai/widgetAccessible": true
};

const TOOLS = [
  {
    name: "abrir_formulario_briefing",
    title: "Abrir formulário de briefing",
    description:
      "Abre o formulário interativo do Gerador de Briefing. Use SEMPRE que a pessoa invocar o Gerador " +
      "de Briefing ou pedir para criar/montar um briefing de criação. Chame imediatamente, sem pedir " +
      "os dados em texto antes. Se a pessoa já citou nome do job, tipo ou direcionamento, envie esses " +
      "valores para pré-preencher.",
    inputSchema: {
      type: "object",
      properties: {
        nome_job: { type: "string", description: "Nome do job, se a pessoa já informou." },
        tipo: { type: "string", enum: ["Criação", "Ajuste", "Refação", "Desdobramento", "Outro"], description: "Tipo do job, se a pessoa já informou." },
        direcionamento: { type: "string", description: "Direcionamento, se a pessoa já informou." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ...UI_META, "openai/toolInvocation/invoking": "Abrindo o formulário…", "openai/toolInvocation/invoked": "Formulário aberto" }
  },
  {
    name: "preparar_briefing",
    title: "Preparar briefing",
    description: "Uso interno do formulário: guarda os dados preenchidos e devolve um código.",
    inputSchema: { type: "object", properties: { dados: { type: "object" } }, required: ["dados"] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: UI_URI, visibility: ["app"] }, "openai/widgetAccessible": true, "openai/visibility": "private" }
  },
  {
    name: "obter_dados_briefing",
    title: "Obter dados do briefing",
    description:
      "Quando chegar uma mensagem no formato \"Gerar briefing … (#código)\", chame esta ferramenta IMEDIATAMENTE " +
      "com esse código (sem o #). Ela devolve o briefing preenchido no formulário e as regras para revisá-lo.",
    inputSchema: {
      type: "object",
      properties: { codigo: { type: "string", description: "Código que vem entre parênteses na mensagem, sem o #." } },
      required: ["codigo"], additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { "openai/toolInvocation/invoking": "Lendo o briefing…", "openai/toolInvocation/invoked": "Briefing lido" }
  },
  {
    name: "exibir_briefing",
    title: "Exibir briefing",
    description:
      "Mostra o briefing final revisado num cartão com botão Copiar, a mensagem de sucesso e o botão Gerar novo briefing. " +
      "Use depois de revisar o briefing obtido com obter_dados_briefing. Envie o briefing COMPLETO em texto puro.",
    inputSchema: {
      type: "object",
      properties: { briefing: { type: "string", description: "Briefing final completo, em texto puro." } },
      required: ["briefing"], additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ...UI_META, "openai/toolInvocation/invoking": "Finalizando o briefing…", "openai/toolInvocation/invoked": "Briefing pronto" }
  }
];

const RESOURCE = {
  uri: UI_URI, name: "formulario-briefing", title: "Formulário do Gerador de Briefing",
  description: "Formulário interativo para montar briefings de criação.", mimeType: UI_MIME
};

function chamarFerramenta(name, a) {
  const texto = (t) => ({ content: [{ type: "text", text: t }] });
  switch (name) {
    case "abrir_formulario_briefing": {
      const prefill = {};
      for (const k of ["nome_job", "tipo", "direcionamento"]) if (typeof a[k] === "string" && a[k].trim()) prefill[k] = a[k].trim();
      return { ...texto("Formulário aberto. Não peça dados em texto e não escreva briefing. Aguarde a pessoa clicar em Gerar briefing."),
        structuredContent: { prefill }, _meta: { "openai/outputTemplate": UI_URI } };
    }
    case "preparar_briefing": {
      const id = guardar(montarBriefing(a.dados || {}));
      return { ...texto(`Dados guardados com o código ${id}.`), structuredContent: { codigo: id } };
    }
    case "obter_dados_briefing": {
      const id = String(a.codigo || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
      const g = GUARDADOS.get(id);
      if (!g) return { ...texto("Código não encontrado ou expirado. Diga em uma frase que é preciso clicar em Gerar briefing de novo no formulário."), isError: true };
      return texto(`${REGRAS_DA}\n\n===== BRIEFING DO FORMULÁRIO =====\n${g.texto}\n===== FIM =====`);
    }
    case "exibir_briefing": {
      const b = String(a.briefing || "").trim();
      return { ...texto("Briefing exibido para a pessoa no cartão. Não repita o briefing no chat."),
        structuredContent: { briefing: b }, _meta: { "openai/outputTemplate": UI_URI } };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ MCP
function handleRpc(msg) {
  const { id, method, params = {} } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Ao pedido de criar um briefing, chame abrir_formulario_briefing imediatamente. " +
          "Quando chegar \"Gerar briefing … (#código)\", chame obter_dados_briefing com o código, revise como diretor de arte " +
          "sênior seguindo as regras devolvidas e chame exibir_briefing com o briefing final. Não escreva o briefing no chat."
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const r = chamarFerramenta(params.name, params.arguments || {});
      return r ? ok(r) : fail(-32602, `Ferramenta desconhecida: ${params.name}`);
    }
    case "resources/list": return ok({ resources: [RESOURCE] });
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "resources/read": {
      if (params.uri !== UI_URI) return fail(-32602, `Recurso desconhecido: ${params.uri}`);
      return ok({
        contents: [{
          uri: UI_URI, mimeType: UI_MIME, text: formHtml(),
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] }, permissions: { clipboardWrite: {} } },
            "openai/widgetDescription": "Formulário de briefing de criação e cartão do briefing final.",
            "openai/widgetPrefersBorder": true
          }
        }]
      });
    }
    default:
      if (id === undefined || id === null) return null;
      return fail(-32601, `Método não suportado: ${method}`);
  }
}

// ------------------------------------------------------------------ HTTP
function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  if (path === "/" && req.method === "POST") path = "/mcp";
  console.log(new Date().toISOString(), req.method, url.pathname);

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (path === "/" && req.method === "GET") {
    return send(res, 200,
      "<!doctype html><meta charset=utf-8><title>Gerador de Briefing</title>" +
      "<body style='font-family:system-ui;padding:40px;line-height:1.7'>✅ Servidor do Gerador de Briefing no ar (v2, sem API paga).<br>" +
      "Endereço para conectar no ChatGPT: <b>" + (req.headers["x-forwarded-proto"] || "http") + "://" +
      req.headers.host + "/mcp</b><br><a href='/preview'>Ver formulário (modo teste)</a></body>",
      "text/html; charset=utf-8");
  }

  if (path === "/preview" && req.method === "GET") return send(res, 200, formHtml(), "text/html; charset=utf-8");

  if (path === "/api/gerar" && req.method === "POST") {
    try { const body = await readJson(req); return send(res, 200, { briefing: montarBriefing(body.dados || {}) }); }
    catch { return send(res, 400, { error: "Pedido inválido" }); }
  }

  if (path === "/mcp") {
    if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST." } });
    let msg;
    try { msg = await readJson(req); } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
    }
    const batch = Array.isArray(msg);
    const replies = (batch ? msg : [msg]).map(handleRpc).filter(Boolean);
    if (replies.length === 0) { res.writeHead(202, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
    return send(res, 200, batch ? replies : replies[0]);
  }

  send(res, 404, { error: "Não encontrado" });
});

server.listen(PORT, () => console.log(`Gerador de Briefing v2 em http://localhost:${PORT}  (MCP em /mcp, teste em /preview)`));
