require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const cron = require("node-cron");
const fs = require("fs");
const https = require("https");
const Tesseract = require("tesseract.js");
const OpenAI = require("openai");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_ID = 205351461;
const SPREADSHEET_ID = "1qrtNcxJOYulLpK_5XnMNIMSKVq-uFnYSWB-J5yR6QhM";

console.log("Bot running (no alerts)");

// ===== GOOGLE SHEETS =====
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

async function sheets() {
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function appendRows(rows) {
  const s = await sheets();
  await s.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    resource: { values: rows }
  });
}

async function readRows() {
  const s = await sheets();
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D"
  });
  return res.data.values || [];
}

// ===== HELPERS =====
function toData(rows) {
  return rows.slice(1).map(r => ({
    date: r[0],
    category: r[1],
    amount: Number(r[2]),
    description: r[3]
  })).filter(i => !isNaN(i.amount));
}

function filterToday(data) {
  const now = new Date();
  return data.filter(i => new Date(i.date).toDateString() === now.toDateString());
}

function computeSummary(data) {
  let total = 0;
  const categories = {};

  data.forEach(i => {
    total += i.amount;
    categories[i.category] = (categories[i.category] || 0) + i.amount;
  });

  return { total, categories };
}

// ===== AI =====
async function parseExpense(text) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract expenses into JSON array:
[
  {"amount": number, "category": "food | transport | groceries | lifestyle | entertainment | shopping | other", "description": "short description"}
]

Rules:
- Calculate totals if quantity is mentioned
- Example: "5 hotdogs for $1 each" = amount 5
- Food includes bread, drinks, meals, snacks
`
      },
      { role: "user", content: text }
    ]
  });

  try {
    const parsed = JSON.parse(res.choices[0].message.content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function parseReceiptTotal(text) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Extract total as JSON {amount:number}" },
      { role: "user", content: text }
    ]
  });

  try {
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return null;
  }
}

// ===== SUMMARY =====
async function dailySummary() {
  const rows = await readRows();
  const today = filterToday(toData(rows));

  if (!today.length) return "No spending today.";

  const summary = computeSummary(today);

  const breakdown = Object.entries(summary.categories)
    .map(([cat, amt]) => `${cat}: $${amt.toFixed(2)}`)
    .join("\n");

  return `Today: $${summary.total.toFixed(2)}\n\n${breakdown}`;
}

// ===== SCHEDULE =====
cron.schedule("30 21 * * *", async () => {
  bot.sendMessage(CHAT_ID, await dailySummary());
});

// ===== MAIN =====
const pending = {};

bot.on("message", async msg => {
  const text = msg.text;
  if (!text) return;

  const lower = text.toLowerCase();

  // confirm large
  if (text.toUpperCase() === "YES") {
    const data = pending[msg.chat.id];
    if (!data) return;

    await appendRows(data);
    delete pending[msg.chat.id];
    return bot.sendMessage(msg.chat.id, "Saved 👍");
  }

  // question
  const isQuery =
    lower.endsWith("?") ||
    lower.startsWith("how") ||
    lower.startsWith("what") ||
    lower.startsWith("summarize");

  if (isQuery) {
    bot.sendMessage(msg.chat.id, "Thinking...");
    return bot.sendMessage(msg.chat.id, await dailySummary());
  }

  // expense
  const items = await parseExpense(text);
  if (!items.length)const aiReply = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    {
      role: "system",
      content: `
You are a friendly personal finance assistant.
If the user message is unclear, guide them to log expenses.

Examples:
- "5 coffee $2 each"
- "lunch $8"
- "grab $12"
Keep it short and helpful.
`
    },
    { role: "user", content: text }
  ]
});
  // ===== SAFE AI FALLBACK (only if nothing returned above) =====
  const aiReply = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a friendly personal finance assistant.
If the user message is unclear, guide them to log expenses.

Examples:
- "5 coffee $2 each"
- "lunch $8"
- "grab $12"
Keep it short and helpful.
`
      },
      { role: "user", content: text }
    ]
  });

  return bot.sendMessage(
    msg.chat.id,
    aiReply.choices[0].message.content
  );

return bot.sendMessage(msg.chat.id, aiReply.choices[0].message.content); return bot.sendMessage(msg.chat.id, "Not sure 🤔");

  const small = items.filter(i => i.amount < 10);
  const large = items.filter(i => i.amount >= 10);

  if (small.length) {
    const rows = small.map(i => [
      new Date().toISOString(),
      i.category || "other",
      i.amount,
      i.description || ""
    ]);

    await appendRows(rows);

    const reply = small
      .map(i => `${i.category} — $${i.amount.toFixed(2)} — ${i.description}`)
      .join("\n");

    bot.sendMessage(msg.chat.id, `Auto-saved:\n${reply}`);
  }

  if (large.length) {
    pending[msg.chat.id] = large.map(i => [
      new Date().toISOString(),
      i.category || "other",
      i.amount,
      i.description || ""
    ]);

    bot.sendMessage(msg.chat.id, "Confirm large expenses? Reply YES");
  }
});

// ===== RECEIPT =====
bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const photo = msg.photo[msg.photo.length - 1];

  const link = await bot.getFileLink(photo.file_id);
  const path = `r_${Date.now()}.jpg`;
  const file = fs.createWriteStream(path);

  https.get(link, res => {
    res.pipe(file);

    file.on("finish", async () => {
      file.close();

      const result = await Tesseract.recognize(path, "eng");
      const parsed = await parseReceiptTotal(result.data.text);

      if (!parsed) return bot.sendMessage(chatId, "Couldn't read receipt");

      pending[chatId] = [[
        new Date().toISOString(),
        "food",
        parsed.amount,
        "receipt"
      ]];

      bot.sendMessage(chatId, `Receipt $${parsed.amount}\nReply YES`);
      fs.unlinkSync(path);
    });
  });
});
