require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { google } = require("googleapis");
const fs = require("fs");
const https = require("https");
const Tesseract = require("tesseract.js");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    params: { offset: -1 }
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SPREADSHEET_ID = "1qrtNcxJOYulLpK_5XnMNIMSKVq-uFnYSWB-J5yR6QhM";
const SHEET_RANGE = "Sheet1!A:D";

console.log("Bot running with hard receipt extraction");

// ===== GOOGLE SHEETS =====
function getGoogleAuth() {
  if (process.env.GOOGLE_CREDENTIALS) {
    console.log("Using GOOGLE_CREDENTIALS from Railway");

    return new google.auth.GoogleAuth({
      credentials: JSON.parse(
        Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf-8")
      ),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
  }

  console.log("Using local credentials.json");

  return new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const auth = getGoogleAuth();

async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

async function appendToSheet(row) {
  console.log("TRYING TO WRITE TO SHEET");

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [row]
    }
  });

  console.log("SUCCESSFULLY WROTE TO SHEET");
}

async function readSheetRows() {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE
  });

  return response.data.values || [];
}

function rowsToData(rows) {
  return rows.slice(1).map(row => ({
    date: row[0],
    category: row[1],
    amount: Number(row[2]),
    description: row[3]
  })).filter(item => !isNaN(item.amount));
}

// ===== EXPENSE PARSER =====
async function parseExpense(text) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract expense details.

Return JSON only:
{
  "amount": number,
  "category": "food | transport | groceries | shopping | lifestyle | entertainment | other",
  "description": "short description"
}

Rules:
- If quantity is mentioned, calculate total.
- "5 hotdogs for $1 each" means amount is 5.
- Food includes meals, drinks, coffee, tea, snacks, bread, restaurants, cafes.
`
      },
      { role: "user", content: text }
    ]
  });

  try {
    return JSON.parse(result.choices[0].message.content);
  } catch {
    return null;
  }
}

// ===== HARD RECEIPT EXTRACTION =====
function extractTotalFromReceiptText(text) {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  console.log("OCR TEXT:", text);

  const totalKeywords = [
    "TOTAL",
    "GRAND TOTAL",
    "NET TOTAL",
    "AMOUNT PAID",
    "AMT PAID",
    "TOTAL PAID"
  ];

  const ignoreKeywords = [
    "SUBTOTAL",
    "SUB TOTAL",
    "SERVICE",
    "SVC",
    "GST",
    "TAX",
    "CHANGE",
    "CHRG",
    "ROUND"
  ];

  // 1. Prefer lines that contain TOTAL but not SUBTOTAL
  for (const line of lines) {
    const upper = line.toUpperCase();

    const hasTotalKeyword = totalKeywords.some(keyword => upper.includes(keyword));
    const shouldIgnore = ignoreKeywords.some(keyword => upper.includes(keyword));

    if (hasTotalKeyword && !shouldIgnore) {
      const amounts = line.match(/\$?\s*\d+[.,]\d{2}/g);

      if (amounts && amounts.length > 0) {
        const lastAmount = amounts[amounts.length - 1]
          .replace("$", "")
          .replace(/\s/g, "")
          .replace(",", ".");

        const amount = Number(lastAmount);

        if (!isNaN(amount)) {
          return amount;
        }
      }
    }
  }

  // 2. If OCR splits TOTAL and amount across nearby lines, find TOTAL then scan next 2 lines
  for (let i = 0; i < lines.length; i++) {
    const upper = lines[i].toUpperCase();

    const isTotalLine =
      upper.includes("TOTAL") &&
      !upper.includes("SUBTOTAL") &&
      !upper.includes("SUB TOTAL");

    if (isTotalLine) {
      const nearby = [lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join(" ");
      const amounts = nearby.match(/\$?\s*\d+[.,]\d{2}/g);

      if (amounts && amounts.length > 0) {
        const lastAmount = amounts[amounts.length - 1]
          .replace("$", "")
          .replace(/\s/g, "")
          .replace(",", ".");

        const amount = Number(lastAmount);

        if (!isNaN(amount)) {
          return amount;
        }
      }
    }
  }

  // 3. Fallback: choose largest money amount from bottom half of receipt
  const bottomHalf = lines.slice(Math.floor(lines.length / 2)).join(" ");
  const allAmounts = bottomHalf.match(/\$?\s*\d+[.,]\d{2}/g);

  if (allAmounts && allAmounts.length > 0) {
    const numbers = allAmounts
      .map(a => Number(a.replace("$", "").replace(/\s/g, "").replace(",", ".")))
      .filter(n => !isNaN(n));

    if (numbers.length > 0) {
      return Math.max(...numbers);
    }
  }

  return null;
}

// ===== AI RECEIPT FALLBACK =====
async function parseReceiptTotalWithAI(receiptText) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract only the FINAL TOTAL PAID from this receipt.

Return JSON only:
{
  "amount": number,
  "description": "merchant or short description"
}

Rules:
- Prioritise the line labelled TOTAL, GRAND TOTAL, NET TOTAL, or AMOUNT PAID.
- Ignore subtotal, service charge, GST, tax, change, rounding.
- Do not return GST or service charge.
`
      },
      { role: "user", content: receiptText }
    ]
  });

  try {
    return JSON.parse(result.choices[0].message.content);
  } catch {
    return null;
  }
}

// ===== SUMMARY =====
function getSummary(data) {
  let total = 0;
  const categories = {};

  data.forEach(item => {
    total += item.amount;
    categories[item.category] = (categories[item.category] || 0) + item.amount;
  });

  const breakdown = Object.entries(categories)
    .map(([category, amount]) => `${category}: $${amount.toFixed(2)}`)
    .join("\n");

  return { total, breakdown };
}

function filterDataByQuestion(data, question) {
  const lower = question.toLowerCase();
  const now = new Date();

  if (lower.includes("today")) {
    return data.filter(item => {
      const date = new Date(item.date);
      return date.toDateString() === now.toDateString();
    });
  }

  if (lower.includes("this week")) {
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
    return data.filter(item => new Date(item.date) >= start);
  }

  if (lower.includes("this month")) {
    return data.filter(item => {
      const date = new Date(item.date);
      return date.getMonth() === now.getMonth() &&
             date.getFullYear() === now.getFullYear();
    });
  }

  return data;
}

async function answerFromSheet(question) {
  const rows = await readSheetRows();
  const data = rowsToData(rows);
  const filtered = filterDataByQuestion(data, question);

  if (filtered.length === 0) {
    return "No expenses found.";
  }

  const summary = getSummary(filtered);

  return `Total: $${summary.total.toFixed(2)}\n\n${summary.breakdown}`;
}

function isQuestion(text) {
  const lower = text.toLowerCase();

  return (
    lower.includes("how much") ||
    lower.includes("spent") ||
    lower.includes("spend") ||
    lower.includes("summary") ||
    lower.includes("summarize") ||
    lower.includes("check from the sheet") ||
    lower.endsWith("?")
  );
}

// ===== AI CHAT FALLBACK =====
async function getAIReply(text) {
  const aiReply = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a friendly personal finance assistant.
Keep replies short.
If the user wants to log expenses, ask them to include an item and amount.

Examples:
- coffee $2
- lunch $8
- 5 hotdogs for $1 each
`
      },
      { role: "user", content: text }
    ]
  });

  return aiReply.choices[0].message.content;
}

// ===== TEXT HANDLER =====
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;

  console.log("MSG:", text);

  try {
    if (isQuestion(text)) {
      const answer = await answerFromSheet(text);
      return bot.sendMessage(msg.chat.id, answer);
    }

    const amountMatch = text.match(/\$?\d+(\.\d{1,2})?/);

    if (amountMatch) {
      const parsed = await parseExpense(text);

      if (!parsed || !parsed.amount) {
        return bot.sendMessage(msg.chat.id, "I found an amount, but could not understand the expense clearly.");
      }

      const date = new Date().toISOString();
      const category = parsed.category || "other";
      const amount = Number(parsed.amount);
      const description = parsed.description || text;

      await appendToSheet([date, category, amount, description]);

      return bot.sendMessage(
        msg.chat.id,
        `Logged to sheet:\n${category} — $${amount.toFixed(2)} — ${description}`
      );
    }

    const reply = await getAIReply(text);
    return bot.sendMessage(msg.chat.id, reply);

  } catch (err) {
    console.error("ERROR:", err);
    return bot.sendMessage(msg.chat.id, "Error occurred while processing.");
  }
});

// ===== RECEIPT PHOTO HANDLER =====
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;

  try {
    bot.sendMessage(chatId, "Reading receipt...");

    const photo = msg.photo[msg.photo.length - 1];
    const fileLink = await bot.getFileLink(photo.file_id);
    const filePath = `receipt_${Date.now()}.jpg`;

    const file = fs.createWriteStream(filePath);

    https.get(fileLink, (response) => {
      response.pipe(file);

      file.on("finish", async () => {
        file.close();

        try {
          const result = await Tesseract.recognize(filePath, "eng");
          const receiptText = result.data.text;

          let amount = extractTotalFromReceiptText(receiptText);
          let description = "receipt";

          if (!amount) {
            const aiParsed = await parseReceiptTotalWithAI(receiptText);

            if (aiParsed && aiParsed.amount) {
              amount = Number(aiParsed.amount);
              description = aiParsed.description || "receipt";
            }
          }

          if (!amount || isNaN(amount)) {
            fs.unlinkSync(filePath);
            return bot.sendMessage(chatId, "Could not read receipt total.");
          }

          const date = new Date().toISOString();

          await appendToSheet([date, "food", amount, description]);

          fs.unlinkSync(filePath);

          return bot.sendMessage(
            chatId,
            `Receipt logged:\nfood — $${amount.toFixed(2)} — ${description}`
          );

        } catch (err) {
          console.error("RECEIPT ERROR:", err);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          return bot.sendMessage(chatId, "Error processing receipt.");
        }
      });
    });

  } catch (err) {
    console.error("PHOTO ERROR:", err);
    return bot.sendMessage(chatId, "Error reading receipt.");
  }
});
