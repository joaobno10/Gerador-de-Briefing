// Gerador de Briefing — servidor MCP (Streamable HTTP, sem estado)
// Sem dependências externas: basta Node 18+ e rodar `node server.js`.
//
// Variáveis de ambiente (configure no Render → Environment):
//   OPENAI_API_KEY  -> chave da API da OpenAI (para a IA revisar direcionamento e infos adicionais)
//   OPENAI_MODEL    -> opcional. Padrão: gpt-5.4-mini
//
// Endpoints:
//   POST /mcp        -> protocolo MCP (JSON-RPC)
//   POST /api/gerar  -> gera o briefing (usado pelo modo teste /preview)
//   GET  /           -> página de status
//   GET  /preview    -> abre o formulário direto no navegador (modo teste)

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim().replace(/^["']|["']$/g, "");
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-5.4-mini").trim();
// Se o modelo escolhido não existir na conta, tenta estes em ordem.
const MODELOS = [...new Set([OPENAI_MODEL, "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini"])];
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");

const SERVER_INFO = { name: "gerador-briefing", title: "Gerador de Briefing", version: "1.1.1" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const UI_URI = "ui://gerador-briefing/formulario.html";
const UI_MIME = "text/html;profile=mcp-app";
const FORM_PATH = join(__dirname, "public", "formulario.html");
const formHtml = () => readFileSync(FORM_PATH, "utf8");

// ------------------------------------------------------------------ ferramentas
const TOOL_ABRIR = {
  name: "abrir_formulario_briefing",
  title: "Abrir formulário de briefing",
  description:
    "Abre o formulário interativo do Gerador de Briefing. Use SEMPRE que a pessoa invocar o Gerador " +
    "de Briefing ou pedir para criar/montar um briefing de criação. Chame imediatamente, sem pedir " +
    "os dados em texto antes. Se a pessoa já citou nome do job, tipo ou direcionamento, envie esses " +
    "valores para pré-preencher. O próprio formulário gera e exibe o briefing final; você não precisa " +
    "escrever nada depois.",
  inputSchema: {
    type: "object",
    properties: {
      nome_job: { type: "string", description: "Nome do job, se a pessoa já informou." },
      tipo: {
        type: "string",
        enum: ["Criação", "Ajuste", "Refação", "Desdobramento", "Outro"],
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
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Abrindo o formulário…",
    "openai/toolInvocation/invoked": "Formulário aberto"
  }
};

// Chamada só pelo formulário (fica escondida do modelo).
const TOOL_GERAR = {
  name: "gerar_briefing",
  title: "Gerar briefing",
  description: "Uso interno do formulário do Gerador de Briefing: recebe os dados preenchidos e devolve o briefing final.",
  inputSchema: {
    type: "object",
    properties: { dados: { type: "object", description: "Dados do formulário." } },
    required: ["dados"]
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: UI_URI, visibility: ["app"] },
    "openai/widgetAccessible": true,
    "openai/visibility": "private"
  }
};

const RESOURCE = {
  uri: UI_URI,
  name: "formulario-briefing",
  title: "Formulário do Gerador de Briefing",
  description: "Formulário interativo para montar briefings de criação.",
  mimeType: UI_MIME
};

// ------------------------------------------------------------------ IA (diretor de arte sênior)
const PROMPT_DA = `Você é um diretor de arte sênior de uma agência de publicidade (varejo automotivo e marcas do grupo).
Recebe um briefing preenchido pelo atendimento e reescreve DOIS campos para o designer: "direcionamento" e "informacoes_adicionais".

Objetivo: o designer deve entender, sem precisar perguntar nada, o que criar e o que deve ter destaque.

Regras:
- Traduza a intenção do atendimento em orientações claras e acionáveis: objetivo da peça, mensagem principal, hierarquia (o que vem primeiro, o que tem mais destaque), tom e chamada/CTA, quando estiverem nos dados.
- Use SOMENTE o que está nos dados. Não invente preços, condições, datas, modelos, slogans, cores, fotos ou elementos que não foram citados. Não suponha o que estiver ambíguo.
- Mantenha valores, condições, nomes e datas exatamente como vieram.
- Seja direto: tópicos curtos ("- "), sem introdução, sem elogio, sem frases genéricas ("criar uma peça impactante", "chamar a atenção do público"), sem repetir a mesma ideia.
- Não repita no direcionamento o que já está em Peças, Obrigatoriedades, O que não fazer ou O que foi recusado: considere essas informações, mas não as copie.
- "informacoes_adicionais": organize e deixe claro o que o atendimento escreveu. Se veio vazio, devolva "".
- Português do Brasil.`;

// Traduz os erros mais comuns da OpenAI para algo que dê para agir.
function explicarErro(status, data) {
  const e = (data && data.error) || {};
  const msg = String(e.message || "");
  if (status === 401) return "chave da OpenAI inválida ou revogada: confira a OPENAI_API_KEY no Render";
  if (e.code === "insufficient_quota" || /quota|billing/i.test(msg)) return "a conta da OpenAI está sem créditos: adicione em platform.openai.com → Billing";
  if (status === 429) return "limite de uso da OpenAI atingido, tente de novo em instantes";
  if (status === 403) return "a chave não tem permissão para este modelo/projeto";
  return msg || `erro ${status} da OpenAI`;
}
const modeloInexistente = (status, data) => {
  const e = (data && data.error) || {};
  return status === 404 || e.code === "model_not_found" || /model.*(not exist|not found|does not have access)/i.test(String(e.message || ""));
};

async function chamarOpenAI(payload) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    let data = {}; try { data = await r.json(); } catch (_) {}
    return { status: r.status, ok: r.ok, data };
  } finally { clearTimeout(t); }
}

async function revisarComIA(d) {
  if (!OPENAI_API_KEY) return { ok: false, motivo: "falta a OPENAI_API_KEY no Render (Environment)" };
  const j = d.job || {};
  const contexto = {
    tipo: j.tipo, nome_do_job: j.nome,
    direcionamento: j.direcionamento, informacoes_adicionais: j.info_adicionais,
    o_que_precisa_mudar: j.o_que_mudar || undefined, o_que_o_cliente_recusou: j.recusado || undefined,
    pecas: (d.pecas || []).map(p => `${p.peca} ${p.largura}x${p.altura}${p.unidade}`),
    obrigatoriedades: (d.obrigatoriedades || []).map(o => `${o.item}: ${o.descricao}`),
    o_que_nao_fazer: d.complementos && d.complementos.nao_fazer || undefined
  };
  const schema = {
    type: "object", additionalProperties: false,
    properties: { direcionamento: { type: "string" }, informacoes_adicionais: { type: "string" } },
    required: ["direcionamento", "informacoes_adicionais"]
  };
  const base = {
    instructions: PROMPT_DA,
    input: "Dados do briefing (JSON):\n" + JSON.stringify(contexto, null, 2) +
      '\n\nResponda só com JSON: {"direcionamento": "...", "informacoes_adicionais": "..."}'
  };
  // Tenta do jeito mais completo para o mais simples, e troca de modelo se o atual não existir.
  const variantes = [
    { reasoning: { effort: "low" }, text: { format: { type: "json_schema", name: "briefing_revisado", strict: true, schema } } },
    { text: { format: { type: "json_schema", name: "briefing_revisado", strict: true, schema } } },
    { text: { format: { type: "json_object" } } }
  ];
  let ultimoMotivo = "";
  try {
    for (const model of MODELOS) {
      for (const v of variantes) {
        const r = await chamarOpenAI({ model, ...base, ...v });
        if (r.ok) {
          let txt = "";
          for (const item of r.data.output || []) for (const c of item.content || []) if (c.type === "output_text") txt += c.text;
          const m = txt.match(/\{[\s\S]*\}/);
          const out = JSON.parse(m ? m[0] : txt);
          if (model !== OPENAI_MODEL) console.warn(`IA: usei ${model} porque ${OPENAI_MODEL} não está disponível`);
          return { ok: true, modelo: model, direcionamento: String(out.direcionamento || "").trim(), info: String(out.informacoes_adicionais || "").trim() };
        }
        console.error(`IA falhou (${model}, ${r.status}):`, JSON.stringify(r.data.error || r.data).slice(0, 300));
        if (modeloInexistente(r.status, r.data)) { ultimoMotivo = `modelo ${model} indisponível`; break; } // próximo modelo
        if (r.status === 400) { ultimoMotivo = explicarErro(r.status, r.data); continue; }    // próxima variante
        return { ok: false, motivo: explicarErro(r.status, r.data) };                          // 401, 429… não adianta insistir
      }
    }
    return { ok: false, motivo: ultimoMotivo || "a OpenAI recusou o pedido" };
  } catch (e) {
    console.error("IA falhou:", e.message);
    return { ok: false, motivo: e.name === "AbortError" ? "a IA demorou demais para responder" : `sem conexão com a OpenAI (${e.message})` };
  }
}

// ------------------------------------------------------------------ montagem do briefing
async function gerarBriefing(d = {}) {
  const j = d.job || {}; const c = d.complementos || {};
  const ia = await revisarComIA(d);
  const direc = ia.ok && ia.direcionamento ? ia.direcionamento : (j.direcionamento || "");
  const info = ia.ok ? (ia.info || "") : (j.info_adicionais || "");

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
  secao("DIRECIONAMENTO", direc);
  secao("INFORMAÇÕES ADICIONAIS", info);
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

  return {
    briefing: L.join("\n"),
    ia: ia.ok,
    aviso: ia.ok ? "" : `Direcionamento sem revisão da IA (${ia.motivo}).`
  };
}

// ------------------------------------------------------------------ MCP
function publicOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${proto}://${req.headers.host}`;
}
const formHtmlFor = (origin) => formHtml().replace("__SERVER_ORIGIN__", origin);

async function handleRpc(msg, ctx = {}) {
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
          "Nunca peça os dados do job em texto no lugar do formulário. O formulário gera e mostra o briefing sozinho."
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL_ABRIR, TOOL_GERAR] });
    case "tools/call": {
      const a = params.arguments || {};
      if (params.name === TOOL_ABRIR.name) {
        const prefill = {};
        for (const k of ["nome_job", "tipo", "direcionamento"]) {
          if (typeof a[k] === "string" && a[k].trim()) prefill[k] = a[k].trim();
        }
        return ok({
          content: [{
            type: "text",
            text:
              "Formulário do Gerador de Briefing aberto. Ele mesmo gera e exibe o briefing final. " +
              "Não peça dados em texto e não escreva briefing. Responda no máximo com uma frase curta."
          }],
          structuredContent: { prefill },
          _meta: { "openai/outputTemplate": UI_URI }
        });
      }
      if (params.name === TOOL_GERAR.name) {
        const out = await gerarBriefing(a.dados || {});
        return ok({ content: [{ type: "text", text: out.briefing }], structuredContent: out });
      }
      return fail(-32602, `Ferramenta desconhecida: ${params.name}`);
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
          text: formHtmlFor(ctx.origin || ""),
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: ctx.origin ? [ctx.origin] : [], resourceDomains: [] }, permissions: { clipboardWrite: {} } },
            "openai/widgetCSP": { connect_domains: ctx.origin ? [ctx.origin] : [], resource_domains: [] },
            "openai/widgetDescription": "Formulário de briefing de criação. Gera e exibe o briefing final dentro do próprio formulário.",
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
  // Aceita /mcp, /mcp/, /MCP e também POST direto na raiz.
  let path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  if (path === "/" && req.method === "POST") path = "/mcp";
  console.log(new Date().toISOString(), req.method, url.pathname);

  if (req.method === "OPTIONS") return send(res, 204, "");

  if (path === "/" && req.method === "GET") {
    return send(res, 200,
      "<!doctype html><meta charset=utf-8><title>Gerador de Briefing</title>" +
      "<body style='font-family:system-ui;padding:40px;line-height:1.7'>✅ Servidor do Gerador de Briefing no ar.<br>" +
      "Endereço para conectar no ChatGPT: <b>" + (req.headers["x-forwarded-proto"] || "http") + "://" +
      req.headers.host + "/mcp</b><br>" +
      "IA de revisão: " + (OPENAI_API_KEY ? `✅ ativa (${OPENAI_MODEL})` : "⚠ desativada (falta OPENAI_API_KEY)") + "<br>" +
      "<a href='/testar-ia'>Testar a IA agora</a> · <a href='/preview'>Ver formulário (modo teste)</a></body>",
      "text/html; charset=utf-8");
  }

  if (path === "/testar-ia" && req.method === "GET") {
    const t0 = Date.now();
    const r = await revisarComIA({ job: { tipo: "Criação", nome: "Teste", direcionamento: "compass com taxa zero, destacar a taxa", info_adicionais: "valido ate dia 30" } });
    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    return send(res, 200,
      "<!doctype html><meta charset=utf-8><title>Teste da IA</title><body style='font-family:system-ui;padding:40px;line-height:1.6;max-width:720px'>" +
      (r.ok
        ? `<h2>✅ IA funcionando</h2>Modelo: <b>${esc(r.modelo)}</b> · ${seg}s<h3>Direcionamento revisado</h3><pre style='white-space:pre-wrap'>${esc(r.direcionamento)}</pre><h3>Informações adicionais</h3><pre style='white-space:pre-wrap'>${esc(r.info)}</pre>`
        : `<h2>❌ IA não está funcionando</h2>Motivo: <b>${esc(r.motivo)}</b><p>Chave configurada: ${OPENAI_API_KEY ? "sim (termina em …" + esc(OPENAI_API_KEY.slice(-4)) + ")" : "não"}</p>`) +
      "</body>", "text/html; charset=utf-8");
  }

  if (path === "/preview" && req.method === "GET") {
    return send(res, 200, formHtmlFor(publicOrigin(req)), "text/html; charset=utf-8");
  }

  if (path === "/api/gerar" && req.method === "POST") {
    try {
      const body = await readJson(req);
      return send(res, 200, await gerarBriefing(body.dados || {}));
    } catch (e) {
      return send(res, 400, { error: "Pedido inválido" });
    }
  }

  if (path === "/mcp") {
    if (req.method !== "POST") {
      return send(res, 405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST." } });
    }
    let msg;
    try { msg = await readJson(req); } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } });
    }
    const batch = Array.isArray(msg);
    const replies = (await Promise.all((batch ? msg : [msg]).map(m => handleRpc(m, { origin: publicOrigin(req) })))).filter(Boolean);
    if (replies.length === 0) { res.writeHead(202, { "Access-Control-Allow-Origin": "*" }); return res.end(); }
    return send(res, 200, batch ? replies : replies[0]);
  }

  send(res, 404, { error: "Não encontrado" });
});

server.listen(PORT, () => {
  console.log(`Gerador de Briefing rodando em http://localhost:${PORT}  (MCP em /mcp, teste em /preview)`);
  console.log(OPENAI_API_KEY ? `IA ativa: ${OPENAI_MODEL}` : "IA desativada: defina OPENAI_API_KEY");
});
