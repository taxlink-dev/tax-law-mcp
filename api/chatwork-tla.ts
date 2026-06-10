const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const CHATWORK_API_BASE = "https://api.chatwork.com/v2";

type ChatworkWebhookPayload = {
  webhook_event_type?: string;
  webhook_event?: {
    message_id?: string;
    room_id?: number;
    account_id?: number;
    body?: string;
    send_time?: number;
    update_time?: number;
  };
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function extractQuestion(payload: ChatworkWebhookPayload | any): {
  roomId: string;
  messageBody: string;
  question: string;
} {
  const fallbackRoomId = env("TLA_LOG_ROOM_ID");

  const roomId =
    payload?.webhook_event?.room_id?.toString() ||
    payload?.room_id?.toString() ||
    fallbackRoomId;

  const messageBody =
    payload?.webhook_event?.body ||
    payload?.body ||
    payload?.text ||
    payload?.message ||
    "";

  const normalized = String(messageBody).trim();

  if (!normalized.startsWith("TLA実行")) {
    return { roomId, messageBody: normalized, question: "" };
  }

  const question = normalized.replace(/^TLA実行\s*/u, "").trim();

  return { roomId, messageBody: normalized, question };
}

async function postChatwork(roomId: string, body: string) {
  const token = env("CHATWORK_API_TOKEN");

  const form = new URLSearchParams();
  form.append("body", body);

  const res = await fetch(`${CHATWORK_API_BASE}/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "x-chatworktoken": token,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chatwork post failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function callTaxLawApi(path: string, params: Record<string, string | number | undefined>) {
  const baseUrl =
    process.env.TAX_LAW_API_BASE_URL ||
    "https://tax-law-mcp-vert.vercel.app";

  const url = new URL(path, baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const res = await fetch(url.toString());

  if (!res.ok) {
    const text = await res.text();
    return { error: `Tax law API failed: ${res.status}`, detail: text };
  }

  return res.json();
}

async function executeToolCall(toolCall: ToolCall) {
  let args: any = {};
  try {
    args = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    args = {};
  }

  switch (toolCall.function.name) {
    case "get_law":
      return callTaxLawApi("/api/get-law", {
        law_name: args.law_name,
        article: args.article,
        paragraph: args.paragraph,
        item: args.item,
        format: args.format || "markdown",
      });

    case "search_law":
      return callTaxLawApi("/api/search-law", {
        keyword: args.keyword,
        law_type: args.law_type,
        limit: args.limit || 10,
      });

    case "get_tsutatsu":
      return callTaxLawApi("/api/get-tsutatsu", {
        tsutatsu_name: args.tsutatsu_name,
        number: args.number,
      });

    case "list_tsutatsu":
      return callTaxLawApi("/api/list-tsutatsu", {
        tsutatsu_name: args.tsutatsu_name,
        section: args.section,
      });

    case "search_saiketsu":
      return callTaxLawApi("/api/search-saiketsu", {
        keyword: args.keyword,
        tax_type: args.tax_type,
        latest: args.latest || 10,
        limit: args.limit || 10,
      });

    case "get_saiketsu":
      return callTaxLawApi("/api/get-saiketsu", {
        url: args.url,
        collection_no: args.collection_no,
        case_no: args.case_no,
      });

    default:
      return { error: `Unknown tool: ${toolCall.function.name}` };
  }
}

async function generateTlaAnswer(question: string): Promise<string> {
  const apiKey = env("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-5.4-mini";

  const systemPrompt = `
あなたは、タクスリンク税理士事務所の内部利用専用の税務相談補助AI「TLA｜TaxLink Legal Assist」です。

目的：
顧客からの税務相談について、税理士・スタッフが確認するための、根拠付きの結論整理と返信ドラフトを作成すること。

重要ルール：
1. 税法・通達・裁決事例に関する回答では、必要に応じて必ずツールを使って条文・通達・裁決事例の原文を確認してから回答すること。
2. ツールで原文を取得できない場合は、断定せず「追加確認が必要」と明示すること。
3. 顧客へそのまま自動送信する前提ではなく、必ず税理士またはスタッフが確認・修正する前提でドラフトを作成すること。
4. 不足している事実関係がある場合は、必ず「不足している確認事項」に列挙すること。
5. 高リスク論点では、必ず「所長確認必須」と表示すること。
6. 条文・通達・裁決事例の内容と矛盾する回答をしてはならない。
7. 根拠条文・通達を広げすぎず、中心根拠を優先すること。
8. 顧客向け返信ドラフトはChatworkで送る前提で簡潔にすること。

出力形式：
【論点分類】
税目：
論点：
リスク分類：

【結論】

【前提事実】

【不足している確認事項】

【根拠条文】

【関連通達】

【裁決事例】

【実務上の注意】

【顧客向け返信ドラフト】

【所長確認ポイント】
`.trim();

  const tools = [
    {
      type: "function",
      function: {
        name: "get_law",
        description: "日本の法令から特定の条文を取得する。",
        parameters: {
          type: "object",
          properties: {
            law_name: { type: "string", description: "法令名または略称。例：所得税法、所法、法人税法、消費税法" },
            article: { type: "string", description: "条文番号。例：33、36、33の2" },
            paragraph: { type: "integer" },
            item: { type: "integer" },
            format: { type: "string", enum: ["markdown", "toc"] },
          },
          required: ["law_name", "article"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_law",
        description: "法令をキーワード検索する。",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            law_type: { type: "string", enum: ["Act", "CabinetOrder", "MinisterialOrdinance"] },
            limit: { type: "integer" },
          },
          required: ["keyword"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_tsutatsu",
        description: "国税庁サイトから基本通達・措置法通達の原文を取得する。",
        parameters: {
          type: "object",
          properties: {
            tsutatsu_name: { type: "string", description: "通達名または略称。例：所基通、法基通、消基通、措通（譲渡）" },
            number: { type: "string", description: "通達番号。例：36-40、2-1-1" },
          },
          required: ["tsutatsu_name", "number"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_tsutatsu",
        description: "通達の目次を表示する。",
        parameters: {
          type: "object",
          properties: {
            tsutatsu_name: { type: "string" },
            section: { type: "string" },
          },
          required: ["tsutatsu_name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_saiketsu",
        description: "国税不服審判所の公表裁決事例をキーワード検索する。",
        parameters: {
          type: "object",
          properties: {
            keyword: { type: "string" },
            tax_type: { type: "string" },
            latest: { type: "integer" },
            limit: { type: "integer" },
          },
          required: ["keyword"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_saiketsu",
        description: "裁決事例の全文を取得する。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            collection_no: { type: "integer" },
            case_no: { type: "integer" },
          },
        },
      },
    },
  ];

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ];

  for (let i = 0; i < 6; i++) {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error("OpenAI response did not include a message.");
    }

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || "TLA回答を生成できませんでした。";
    }

    messages.push({
      role: "assistant",
      content: message.content || "",
      ...(message.tool_calls ? ({ tool_calls: message.tool_calls } as any) : {}),
    } as any);

    for (const toolCall of message.tool_calls as ToolCall[]) {
      const toolResult = await executeToolCall(toolCall);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult),
      });
    }
  }

  return "ツール確認が規定回数内に収束しませんでした。所長確認必須です。";
}

export default async function handler(req: Request): Promise<Response> {
  try {
    if (req.method === "GET") {
      return jsonResponse(200, {
        ok: true,
        message: "TLA Chatwork endpoint is running.",
        usage: "POST a Chatwork webhook payload or JSON { text: 'TLA実行 ...' }",
      });
    }

    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "Method not allowed" });
    }

    const raw = await req.text();

    let payload: any;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      payload = { text: raw };
    }

    const { roomId, question } = extractQuestion(payload);

    if (!question) {
      return jsonResponse(200, {
        ok: true,
        skipped: true,
        reason: "Message does not start with TLA実行.",
      });
    }

    await postChatwork(roomId, "[info][title]TLA受付[/title]税務相談の根拠確認を開始します。[/info]");

    const answer = await generateTlaAnswer(question);

    const chatworkMessage = `[info][title]TLA｜TaxLink Legal Assist 出力結果[/title]${answer}[/info]`;

    await postChatwork(roomId, chatworkMessage.slice(0, 65000));

    return jsonResponse(200, { ok: true });
  } catch (error: any) {
    const message = error?.message || String(error);

    try {
      const roomId = process.env.TLA_LOG_ROOM_ID;
      if (roomId && process.env.CHATWORK_API_TOKEN) {
        await postChatwork(
          roomId,
          `[info][title]TLAエラー[/title]${message}[/info]`
        );
      }
    } catch {
      // ignore secondary error
    }

    return jsonResponse(500, { ok: false, error: message });
  }
}
