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

console.log("Bot running with logging, sheet queries, and receipts");

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

// ===== AI EXPENSE PARSER =====
async function parseExpense(text) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract expense details from the user's message.

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
- Transport includes Grab, taxi, MRT, bus, petrol, parking.
- Groceries includes supermarkets, NTUC, FairPrice, Donki, household food supplies.
- Shopping includes clothes, shoes, online shopping, accessories.
- Lifestyle includes grooming, subscriptions, self-care.
- Entertainment includes movies, games, activities.
`
      },
      {
        role: "user",
        content: text
      }
    ]
  });

  try {
    return JSON.parse(result.choices[0].message.content);
  } catch {
    return null;
  }
}

// ===== RECEIPT PARSER =====
async function parseReceiptTotal(receiptText) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
Extract only the final total amount from this receipt.

Return JSON only:
{
  "amount": number,
  "description": "short receipt description"
}

Rules:
- Ignore line items.
- Ignore service charge, GST, change, receipt number, table number.
- Use the final total paid.
`
      },
      {
        role: "user",
        content: receiptText
      }
    ]
  });

  try {
    return JSON.parse(result.choices[0].message.content);
  } catch {
    return null;
  }
}

// ===== SUMMARY / QUESTIONS =====
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

  return {
    total,
    breakdown
  };
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
      {
        role: "user",
        content: text
      }
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

          const parsed = await parseReceiptTotal(receiptText);

          if (!parsed || !parsed.amount) {
            fs.unlinkSync(filePath);
            return bot.sendMessage(chatId, "Could not read receipt total.");
          }

          const amount = Number(parsed.amount);
          const description = parsed.description || "receipt";
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
