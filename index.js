require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { google } = require("googleapis");

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

console.log("Bot running with Google Sheets");

// ===== GOOGLE SHEETS AUTH =====
function getGoogleAuth() {
  if (process.env.GOOGLE_CREDENTIALS) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(
        Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf-8")
      ),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
  }

  return new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const auth = getGoogleAuth();

async function appendToSheet(row) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: [row]
    }
  });
}

// ===== BOT =====
bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;

  console.log("MSG:", text);

  try {
    const amountMatch = text.match(/\$?\d+(\.\d{1,2})?/);

    if (amountMatch) {
      const amount = Number(amountMatch[0].replace("$", ""));

      const date = new Date().toISOString();
      const category = "other";
      const description = text;

      await appendToSheet([date, category, amount, description]);

      return bot.sendMessage(
        msg.chat.id,
        `Logged to sheet:\n${category} — $${amount.toFixed(2)} — ${description}`
      );
    }

    const aiReply = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a friendly personal finance assistant.
Guide the user to log expenses clearly.

Examples:
- "coffee $2"
- "lunch $8"
Keep it short.
`
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    return bot.sendMessage(
      msg.chat.id,
      aiReply.choices[0].message.content
    );

  } catch (err) {
    console.error(err);
    return bot.sendMessage(msg.chat.id, "Error occurred while saving.");
  }
});

