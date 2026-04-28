require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {
  polling: {
    params: { offset: -1 }
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

console.log("Bot running (stable version)");

bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text) return;

  console.log("MSG:", text);

  try {
    // ===== SIMPLE EXPENSE DETECTION =====
    const expenseMatch = text.match(/\$?\d+(\.\d{1,2})?/);

    if (expenseMatch) {
      return bot.sendMessage(
        msg.chat.id,
        `Logged: ${text} 💰`
      );
    }

    // ===== AI FALLBACK =====
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
    return bot.sendMessage(msg.chat.id, "Error occurred.");
  }
});
