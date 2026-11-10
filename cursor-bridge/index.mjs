// Cursor bridge: an OpenAI chat-completions server on 127.0.0.1 backed by the official @cursor/sdk.
// The cursor executor starts it as a child process; `node index.mjs login` runs the Cursor browser login.
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Agent, Cursor, tempFs } from "@cursor/sdk";

const PORT = Number(process.env.CURSOR_BRIDGE_PORT || 18318);
const TOOL_BATCH_MS = 150;
const PARKED_TTL_MS = 15 * 60_000;
const CONVERSATION_TTL_MS = 2 * 60 * 60_000;
const MODEL_PREFIX = "cursor/";
const EFFORT_PARAMS = ["reasoning_effort", "effort", "reasoning"];

const conversations = new Map();
const parkedCalls = new Map();
const catalogs = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" || part.type === "input_text")
    .map((part) => part.text)
    .join("");
}

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part) => part.type === "image_url")
    .map((part) => {
      const url = part.image_url.url;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (!match) return { url };
      return { data: match[2], mimeType: match[1] };
    });
}

function fingerprint(message) {
  if (message.role === "assistant" && message.tool_calls?.length) {
    return "a:" + message.tool_calls.map((call) => call.id).join(",");
  }
  if (message.role === "tool") return "t:" + message.tool_call_id;
  return message.role[0] + ":" + textOf(message.content).trim();
}

function chainHashes(scope, messages) {
  const hashes = [];
  let previous = scope;
  for (const message of messages) {
    previous = sha(previous + "\n" + fingerprint(message));
    hashes.push(previous);
  }
  return hashes;
}

function renderToolCall(call) {
  return `[assistant called tool ${call.function.name} with id ${call.id} and arguments ${call.function.arguments}]`;
}

function renderMessage(message) {
  if (message.role === "assistant") {
    const calls = (message.tool_calls ?? []).map(renderToolCall);
    return [`[assistant]: ${textOf(message.content)}`, ...calls].join("\n");
  }
  if (message.role === "tool") return `[tool result for ${message.tool_call_id}]: ${textOf(message.content)}`;
  return `[${message.role}]: ${textOf(message.content)}`;
}

function renderFreshPrompt(messages) {
  const system = messages.filter((m) => m.role === "system" || m.role === "developer");
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  let tail = rest.length;
  while (tail > 0 && rest[tail - 1].role === "user") tail--;
  const history = rest.slice(0, tail);
  const latest = rest.slice(tail);
  const parts = [];
  if (system.length) {
    parts.push(`<system_instructions>\n${system.map((m) => textOf(m.content)).join("\n\n")}\n</system_instructions>`);
  }
  if (history.length) {
    parts.push(`<conversation_history>\n${history.map(renderMessage).join("\n")}\n</conversation_history>`);
  }
  if (latest.length) parts.push(latest.map((m) => textOf(m.content)).join("\n\n"));
  if (!latest.length) parts.push("Continue the conversation from the last message above.");
  return { text: parts.join("\n\n"), images: latest.flatMap((m) => imagesOf(m.content)) };
}

async function catalogFor(apiKey) {
  const cached = catalogs.get(apiKey);
  if (cached) return cached;
  const models = await Cursor.models.list({ apiKey });
  catalogs.set(apiKey, models);
  return models;
}

async function modelSelection(apiKey, modelId, effort) {
  if (!effort) return { id: modelId };
  const model = (await catalogFor(apiKey)).find((m) => m.id === modelId);
  const param = model?.parameters?.find((p) => EFFORT_PARAMS.includes(p.id));
  if (!param) return { id: modelId };
  const wanted = effort === "xhigh" ? ["xhigh", "extra-high"] : [effort];
  const value = param.values.find((v) => wanted.includes(v.value));
  if (!value) throw new HttpError(400, `reasoning_effort ${effort} is not supported by ${modelId}`);
  return { id: modelId, params: [{ id: param.id, value: value.value }] };
}

function customToolsFor(tools, conversation) {
  const entries = (tools ?? [])
    .filter((tool) => tool.type === "function")
    .map((tool) => [
      tool.function.name,
      {
        description: tool.function.description,
        inputSchema: tool.function.parameters ?? { type: "object", properties: {} },
        execute: (args, context) => conversation.turn.parkCall(tool.function.name, args, context.toolCallId),
      },
    ]);
  return Object.fromEntries(entries);
}

class Turn {
  constructor(conversation) {
    this.conversation = conversation;
    this.events = [];
    this.wake = null;
    this.batch = [];
    this.batchTimer = null;
    this.expectedCalls = 0;
    this.resolvers = new Map();
    this.finalText = "";
  }

  push(event) {
    this.events.push(event);
    this.wake?.();
  }

  async *drain() {
    for (;;) {
      while (this.events.length) {
        const event = this.events.shift();
        yield event;
        if (event.type !== "text" && event.type !== "reasoning") return;
      }
      await new Promise((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }

  parkCall(name, args, id) {
    this.batch.push({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    if (this.expectedCalls && this.batch.length >= this.expectedCalls) this.flushCalls();
    if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flushCalls(), TOOL_BATCH_MS);
    return new Promise((resolve) => this.resolvers.set(id, resolve));
  }

  flushCalls() {
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.batch.length) return;
    const calls = this.batch;
    this.batch = [];
    this.expectedCalls = 0;
    const expiresAt = Date.now() + PARKED_TTL_MS;
    for (const call of calls) parkedCalls.set(call.id, { turn: this, expiresAt });
    this.push({ type: "tool_calls", calls });
  }

  resolveCall(id, content) {
    parkedCalls.delete(id);
    this.resolvers.get(id)?.({ content: [{ type: "text", text: content }] });
    this.resolvers.delete(id);
  }

  onDelta(update) {
    if (update.type === "text-delta") {
      this.finalText += update.text;
      this.push({ type: "text", text: update.text });
    } else if (update.type === "thinking-delta") {
      this.push({ type: "reasoning", text: update.text });
    } else if (update.type === "tool-requests-listed" && !this.expectedCalls) {
      this.expectedCalls = update.callCount;
    }
  }
}

function errorStatus(error) {
  if (error instanceof HttpError) return error.status;
  const byName = { AuthenticationError: 401, RateLimitError: 429, ConfigurationError: 400, AgentBusyError: 409 };
  return byName[error?.name] ?? 502;
}

function openAIUsage(usage) {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens, cache_write_tokens: usage.cacheWriteTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  };
}

function lastToolResults(messages) {
  const results = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i--) results.unshift(messages[i]);
  return results;
}

async function startTurn(apiKey, body, messages) {
  const modelId = body.model.startsWith(MODEL_PREFIX) ? body.model.slice(MODEL_PREFIX.length) : body.model;
  const scope = sha(apiKey + "\n" + modelId + "\n" + JSON.stringify(body.tools ?? []));
  const hashes = chainHashes(scope, messages);

  const results = lastToolResults(messages);
  const parkedTurn = results.length ? parkedCalls.get(results[0].tool_call_id)?.turn : undefined;
  if (parkedTurn) {
    parkedTurn.requestHashes = hashes;
    parkedTurn.finalText = "";
    for (const result of results) parkedTurn.resolveCall(result.tool_call_id, textOf(result.content));
    for (const id of parkedTurn.resolvers.keys()) parkedTurn.resolveCall(id, "Error: the client sent no result for this tool call.");
    return parkedTurn;
  }

  let conversation;
  let newMessages = messages;
  for (let i = hashes.length - 2; i >= 0; i--) {
    const found = conversations.get(hashes[i]);
    const tail = messages.slice(i + 1);
    if (found && !found.busy && tail.every((m) => m.role === "user")) {
      conversations.delete(hashes[i]);
      conversation = found;
      newMessages = tail;
      break;
    }
  }

  const fresh = !conversation;
  if (fresh) {
    const model = await modelSelection(apiKey, modelId, body.reasoning_effort);
    conversation = { scope };
    const local = { fs: tempFs(), settingSources: [], customTools: customToolsFor(body.tools, conversation) };
    conversation.agent = await Agent.create({ apiKey, model, tools: ["mcp"], local });
  }
  const prompt = fresh
    ? renderFreshPrompt(messages)
    : { text: newMessages.map((m) => textOf(m.content)).join("\n\n"), images: newMessages.flatMap((m) => imagesOf(m.content)) };

  const turn = new Turn(conversation);
  conversation.turn = turn;
  turn.requestHashes = hashes;
  conversation.busy = true;
  conversation.lastUsed = Date.now();
  const message = prompt.images.length ? { text: prompt.text, images: prompt.images } : prompt.text;
  const run = await conversation.agent.send(message, {
    onDelta: ({ update }) => turn.onDelta(update),
  });
  run
    .wait()
    .then((result) => {
      conversation.busy = false;
      if (result.status !== "finished") {
        turn.push({ type: "error", error: new HttpError(502, `cursor run ended with status ${result.status}`) });
        return;
      }
      const lastHash = turn.requestHashes[turn.requestHashes.length - 1];
      const replyHash = sha(lastHash + "\n" + fingerprint({ role: "assistant", content: turn.finalText }));
      conversation.lastUsed = Date.now();
      conversations.set(replyHash, conversation);
      turn.push({ type: "done", usage: result.usage });
    })
    .catch((error) => {
      conversation.busy = false;
      turn.push({ type: "error", error });
    });
  return turn;
}

function chunk(base, delta, finishReason) {
  return { ...base, choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
}

async function handleChat(req, res, apiKey, body) {
  const messages = body.messages ?? [];
  const turn = await startTurn(apiKey, body, messages);
  const base = { id: "chatcmpl-" + randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
  const stream = body.stream === true;
  let text = "";
  let reasoning = "";
  let toolCalls = null;
  let usage = null;

  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(chunk(base, { role: "assistant", content: "" }))}\n\n`);
  }
  const send = (payload) => stream && res.write(`data: ${JSON.stringify(payload)}\n\n`);

  for await (const event of turn.drain()) {
    if (event.type === "text") {
      text += event.text;
      send(chunk(base, { content: event.text }));
    } else if (event.type === "reasoning") {
      reasoning += event.text;
      send(chunk(base, { reasoning_content: event.text }));
    } else if (event.type === "tool_calls") {
      toolCalls = event.calls;
      send(chunk(base, { tool_calls: event.calls.map((call, index) => ({ index, ...call })) }));
      send(chunk(base, {}, "tool_calls"));
    } else if (event.type === "done") {
      usage = openAIUsage(event.usage);
      send(chunk(base, {}, "stop"));
      send({ ...base, choices: [], usage });
    } else {
      throw event.error;
    }
  }

  if (stream) {
    res.end("data: [DONE]\n\n");
    return;
  }
  const message = { role: "assistant", content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls) message.tool_calls = toolCalls;
  const completion = {
    id: base.id,
    object: "chat.completion",
    created: base.created,
    model: body.model,
    choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
  };
  if (usage) completion.usage = usage;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(completion));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on("data", (part) => parts.push(part));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

function sendError(res, error) {
  const status = errorStatus(error);
  const payload = { error: { message: String(error?.message ?? error), type: error?.name ?? "cursor_error", code: status } };
  if (res.headersSent) {
    res.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function evictExpired() {
  const now = Date.now();
  for (const [hash, conversation] of conversations) {
    if (now - conversation.lastUsed > CONVERSATION_TTL_MS) conversations.delete(hash);
  }
  for (const [id, parked] of parkedCalls) {
    if (now > parked.expiresAt) parked.turn.resolveCall(id, "Error: the tool result did not arrive in time.");
  }
}

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200).end("ok");
        return;
      }
      if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) throw new HttpError(404, "not found");
      const apiKey = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!apiKey) throw new HttpError(401, "missing Cursor API key");
      await handleChat(req, res, apiKey, JSON.parse(await readBody(req)));
    } catch (error) {
      console.error(`cursor bridge: ${error?.name ?? "Error"}: ${error?.message ?? error}`);
      sendError(res, error);
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`cursor bridge listening on 127.0.0.1:${PORT}`));
  setInterval(evictExpired, 60_000).unref();
}

async function login() {
  const result = await Cursor.auth.login({
    openBrowser: false,
    store: null,
    apiKeyName: "CLIProxyAPI",
    onLoginUrl: (url) => console.log(JSON.stringify({ login_url: url })),
  });
  console.log(JSON.stringify({ api_key: result.apiKey, email: result.email ?? "", expires_at_ms: result.apiKeyExpiresAtMs }));
}

if (process.argv[2] === "login") {
  await login();
  process.exit(0);
}
serve();
