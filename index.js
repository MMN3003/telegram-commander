const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();
require("dotenv").config();

// Telegram Bot configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
let bot;
let db;
async function init() {
  // Create bot in webhook mode or polling mode based on DEBUG env
  const option =
    process.env.DEBUG?.toLocaleLowerCase() === "true"
      ? { polling: true }
      : { webHook: { port: PORT } };
  bot = new TelegramBot(BOT_TOKEN, option);
  if (!option.webHook) {
    await bot.setWebHook(WEBHOOK_URL);
  }
  console.log("Bot is running and listening for updates...");

  // Database setup
  db = new sqlite3.Database(process.env.DB_PATH || "./crawler.db");
}

init();
// ----------------------
// Helper Functions
// ----------------------

// Sends the main menu with inline buttons.
function sendMainMenu(chatId) {
  const text = "Welcome to the bot! Choose an option:";
  const buttons = [
    [{ text: "🔍 Search Content", callback_data: "search_init" }],
    [{ text: "ℹ️ Help", callback_data: "help" }],
  ];
  return bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

// Searches pages based on the provided query.
function searchPages(chatId, query) {
  db.all(
    `SELECT id, name FROM pages 
       WHERE name LIKE ? 
       ORDER BY name LIMIT 10`,
    [`%${query}%`],
    (err, pages) => {
      if (err) {
        console.error("Search error:", err);
        return bot.sendMessage(chatId, "❌ Search failed. Please try again.");
      }
      if (pages.length === 0) {
        return bot.sendMessage(chatId, "🔍 No results found");
      }
      const buttons = pages.map((page) => [
        { text: page.name, callback_data: `page:${page.id}` },
      ]);
      bot.sendMessage(chatId, "🔎 Search results:", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
    }
  );
}

// Loads seasons for a given page.
function showSeasons(chatId, pageId) {
  bot
    .sendMessage(chatId, "⏳ Loading seasons...")
    .then((loadingMessage) => {
      const loadingMessageId = loadingMessage.message_id;
      db.all(
        `SELECT season FROM media 
           WHERE page_id = ? 
           GROUP BY season 
           ORDER BY season`,
        [pageId],
        (err, seasons) => {
          if (err) {
            console.error("Season load error:", err);
            return bot.sendMessage(chatId, "❌ Failed to load seasons");
          }
          // Delete the loading message.
          bot.deleteMessage(chatId, loadingMessageId);
          const buttons = seasons.map((season) => [
            {
              text: `Season ${season.season}`,
              callback_data: `season:${pageId}:${season.season}`,
            },
          ]);
          buttons.push([{ text: "← Back", callback_data: "back:search" }]);
          bot.sendMessage(chatId, "📺 Select season:", {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: buttons },
          });
        }
      );
    })
    .catch((err) => {
      console.error("Error in showSeasons:", err);
      bot.sendMessage(chatId, "⚠️ Failed to display seasons");
    });
}

// Loads episodes for a given page and season.
function showEpisodes(chatId, pageId, season) {
  db.all(
    `SELECT episode FROM media 
     WHERE page_id = ? AND season = ? 
     GROUP BY episode 
     ORDER BY episode`,
    [pageId, season],
    (err, episodes) => {
      if (err) {
        console.error("Episodes load error:", err);
        return bot.sendMessage(chatId, "❌ Failed to load episodes");
      }
      const buttons = episodes.map((episode) => [
        {
          text: `Episode ${episode.episode}`,
          callback_data: `episode:${pageId}:${season}:${episode.episode}`,
        },
      ]);
      buttons.push([{ text: "← Back", callback_data: `back:page:${pageId}` }]);
      bot.sendMessage(chatId, "Select episode:", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: buttons },
      });
    }
  );
}

// Sends media (images and videos) for a given page, season, and episode.
function sendMedia(chatId, pageId, season, episode) {
  console.log(
    "Sending media for page:",
    pageId,
    "season:",
    season,
    "episode:",
    episode
  );
  
  db.all(
    `SELECT * FROM media 
     WHERE page_id = ? AND season = ? AND episode = ? 
     ORDER BY type DESC`,
    [pageId, season, episode],
    (err, mediaItems) => {
      if (err) {
        console.error("Media load error:", err);
        return bot.sendMessage(chatId, "❌ Failed to load media");
      }

      const mediaGroups = { image: [], video: [] };
      mediaItems.forEach((item) => {
        if (item.type === "video") {
          mediaGroups.video.push({
            url: item.url,
            resolution: item.resolution || "HD", // Default to 'HD' if no resolution
          });
        } else {
          mediaGroups.image.push(item.url);
        }
      });

      // Send images first
      if (mediaGroups.image.length > 0) {
        const mediaArray = mediaGroups.image.map((url) => ({
          type: "photo",
          media: url,
        }));
        bot.sendMediaGroup(chatId, mediaArray);
      }

      // Create resolution buttons
      if (mediaGroups.video.length > 0) {
        const buttons = mediaGroups.video.map((video) => ({
          text: `${video.resolution}`,
          url: video.url,
        }));

        // Arrange buttons in rows of 2
        const keyboardRows = [];
        while (buttons.length > 0) {
          keyboardRows.push(buttons.splice(0, 2));
        }

        const caption =
          `📺 *Season ${escapeHtml(season)} Episode ${escapeHtml(episode)}*\n` +
          `Select resolution:`;

        bot.sendMessage(chatId, caption, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: keyboardRows,
          },
        });
      }
    }
  );
}

// Escapes HTML characters in a string.
function escapeHtml(text) {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&/g, "&amp;");
}

// Handles the "back" button navigation.
function handleBackNavigation(chatId, data) {
  if (data[1] === "search") {
    sendMainMenu(chatId);
  } else if (data[1] === "page" && data[2]) {
    showSeasons(chatId, data[2]);
  } else {
    sendMainMenu(chatId);
  }
}

// ----------------------
// Command & Callback Handlers
// ----------------------

// /start command.
bot.onText(/\/start/, (msg) => {
  console.log("Received /start command:", msg);
  const chatId = msg.chat.id;
  sendMainMenu(chatId);
});

// /search command.
bot.onText(/\/search (.+)/, (msg, match) => {
  console.log("Received /search command with query:", msg);
  const chatId = msg.chat.id;
  const query = match[1];
  if (query) {
    searchPages(chatId, query);
  } else {
    bot.sendMessage(chatId, "Please enter your search query after /search");
  }
});

// /help command.
bot.onText(/\/help/, (msg) => {
  console.log("Received /help command");
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "🤖 <b>Bot Commands</b>\n\n" +
      "/start - Show main menu\n" +
      "/search <query> - Find content\n\n" +
      "Navigate using the inline buttons!",
    { parse_mode: "HTML" }
  );
});

// Callback query handler for inline buttons.
bot.on("callback_query", (callbackQuery) => {
  const data = callbackQuery.data.split(":");
  const chatId = callbackQuery.message.chat.id;

  // Acknowledge the callback query.
  bot
    .answerCallbackQuery(callbackQuery.id)
    .catch((err) => console.error("Error in answerCallbackQuery:", err));

  switch (data[0]) {
    case "search_init":
      bot.sendMessage(chatId, "Please use /search <query> to find content");
      break;
    case "help":
      bot.sendMessage(
        chatId,
        "🤖 <b>Bot Commands</b>\n\n" +
          "/start - Show main menu\n" +
          "/search <query> - Find content\n\n" +
          "Navigate using the inline buttons!",
        { parse_mode: "HTML" }
      );
      break;
    case "page":
      showSeasons(chatId, data[1]);
      break;
    case "season":
      showEpisodes(chatId, data[1], data[2]);
      break;
    case "episode":
      sendMedia(chatId, data[1], data[2], data[3]);
      break;
    case "back":
      handleBackNavigation(chatId, data);
      break;
    default:
      bot.sendMessage(chatId, "❌ Unknown command");
  }
});

// Fallback for unrecognized text (non-command messages).
bot.on("message", (msg) => {
  console.log("Received message:", msg);
  const chatId = msg.chat.id;
  // Avoid handling callback queries here.
  if (!msg.text.startsWith("/")) {
    bot.sendMessage(chatId, "Use /search <query> to find content");
  }
});

process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down gracefully...");
  db.close((err) => {
    if (err) {
      console.error("Error closing the database:", err);
    } else {
      console.log("Database connection closed.");
    }
    process.exit(0);
  });
});
