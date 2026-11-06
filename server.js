// Gerador de Briefing — servidor MCP (Streamable HTTP, sem estado)
// Sem dependências externas: basta Node 18+ e rodar `node server.js`.
//
// Endpoints:
//   POST /mcp     -> protocolo MCP (JSON-RPC)
//   GET  /        -> página de status (para conferir se o servidor está no ar)
//   GET  /preview -> abre o formulário direto no navegador (modo teste)

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const SERVER_INFO = { name: "gerador-briefing", title: "Gerador de Briefing", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const UI_URI = "ui://gerador-briefing/formulario.html";
const UI_MIME = "text/html;profile=mcp-app";
const FORM_PATH = join(__dirname, "public", "formulario.html");

// Lê o HTML a cada pedido: se você editar o arquivo, não precisa reiniciar.
const formHtml = () => readFileSync(FORM_PATH, "utf8");

const TOOL = {
  name: "abrir_formulario_briefing",
  title: "Abrir formulário de briefing",
  description:
    "Abre o formulário interativo do Gerador de Briefing. Use SEMPRE que a pessoa invocar o Gerador " +
    "de Briefing ou pedir para criar/montar um briefing de criação. Chame imediatamente, sem pedir " +
    "os dados em texto antes. Se a pessoa já citou nome do job, tipo ou direcionamento, envie esses " +
    "valores para pré-preencher. Depois de abrir, aguarde: o próprio formulário envia os dados à " +
    "conversa quando a pessoa clica em Gerar briefing.",
  inputSchema: {
    type: "object",
    properties: {
      nome_job: { type: "string", description: "Nome do job, se a pessoa já informou." },
      tipo: {
        type: "string",
        enum: ["Peça nova", "Campanha", "Desdobramento", "Refação", "Ajuste"],
        description: "Tipo do job, se a pessoa já informou."
      },
      direcionamento: { type: "string", description: "Direcionamento, se a pessoa já informou." }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: UI_URI },
    "openai/outputTemplate": UI_URI,
    "openai/toolInvocation/invoking": "Abrindo o formulário…",
    "openai/toolInvocation/invoked": "Formulário aberto"
  }
};

const RESOURCE = {
  uri: UI_URI,
  name: "formulario-briefing",
  title: "Formulário do Gerador de Briefing",
  description: "Formulário interativo para montar briefings de criação.",
  mimeType: UI_MIME
};

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
          "Nunca peça os dados do job em texto no lugar do formulário."
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      if (params.name !== TOOL.name) return fail(-32602, `Ferramenta desconhecida: ${params.name}`);
      const a = params.arguments || {};
      const prefill = {};
      for (const k of ["nome_job", "tipo", "direcionamento"]) {
        if (typeof a[k] === "string" && a[k].trim()) prefill[k] = a[k].trim();
      }
      return ok({
        content: [{
          type: "text",
          text:
            "Formulário do Gerador de Briefing aberto para a pessoa. Não peça os dados em texto e " +
            "não escreva o briefing agora: aguarde a mensagem que o formulário envia ao clicar em " +
            "Gerar briefing. Responda só com uma frase curta, se precisar."
        }],
        structuredContent: { prefill },
        _meta: { "openai/outputTemplate": UI_URI }
      });
    }
    case "resources/list":
      return ok({ resources: [RESOURCE] });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "resources/read": {
      if (params.uri !== UI_URI) return fail(-32602, `Recurso desconhecido: ${params.uri}`);
      return ok({
        contents: [{
          uri: UI_URI,
          mimeType: UI_MIME,
          text: formHtml(),
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
            "openai/widgetDescription": "Formulário de briefing de criação. A pessoa preenche e clica em Gerar briefing.",
            "openai/widgetPrefersBorder": true
          }
        }]
      });
    }
    default:
      if (id === undefined || id === null) return null; // notificação: sem resposta
      return fail(-32601, `Método não suportado: ${method}`);
  }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (url.pathname === "/" && req.method === "GET") {
    return send(res, 200,
      "<!doctype html><meta charset=utf-8><title>Gerador de Briefing</title>" +
      "<body style='font-family:system-ui;padding:40px'>✅ Servidor do Gerador de Briefing no ar.<br>" +
      "Endereço para conectar no ChatGPT: <b>" + (req.headers["x-forwarded-proto"] || "http") + "://" +
      req.headers.host + "/mcp</b><br><a href='/preview'>Ver formulário (modo teste)</a></body>",
      "text/html; charset=utf-8");
  }

  if (url.pathname === "/preview" && req.method === "GET") {
    return send(res, 200, formHtml(), "text/html; charset=utf-8");
  }

  if (url.pathname === "/mcp") {
    if (req.method !== "POST") {
      return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST." } });
    }
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(raw); } catch {
        return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
      }
      const batch = Array.isArray(msg);
      const replies = (batch ? msg : [msg]).map(handleRpc).filter(Boolean);
      if (replies.length === 0) { res.writeHead(202, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
      return send(res, 200, batch ? replies : replies[0]);
    });
    return;
  }

  send(res, 404, { error: "Não encontrado" });
});

server.listen(PORT, () => {
  console.log(`Gerador de Briefing rodando em http://localhost:${PORT}  (MCP em /mcp, teste em /preview)`);
});
