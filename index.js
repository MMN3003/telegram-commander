const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database(process.env.DB_PATH || "./crawler.db");

// Telegram API configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Set up webhook
axios
  .post(`${API_URL}/setWebhook`, { url: WEBHOOK_URL })
  .then(() => console.log("Webhook set successfully"))
  .catch((err) => console.error("Error setting webhook:", err));

// Log every update received at webhook for debugging
app.post("/webhook", async (req, res) => {
  const update = req.body;
  console.log("Update received:", JSON.stringify(update, null, 2));
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  } else {
    console.log("Received unknown update type");
  }
  res.sendStatus(200);
});

// Command handlers
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";
  console.log("Received message:", text);
  if (text.startsWith("/start")) {
    sendMainMenu(chatId);
  } else if (text.startsWith("/search")) {
    const query = text.replace("/search", "").trim();
    if (query) {
      searchPages(chatId, query);
    } else {
      sendMessage(chatId, "Please enter your search query after /search");
    }
  } else {
    sendMessage(chatId, "Use /search <query> to find content");
  }
}

async function sendMainMenu(chatId) {
  const text = "Welcome to the bot! Choose an option:";
  const buttons = [
    [
      {
        text: "🔍 Search Content",
        callback_data: "search_init",
      },
    ],
    [
      {
        text: "ℹ️ Help",
        callback_data: "help",
      },
    ],
  ];
  await sendMessage(chatId, text, buttons);
}

async function handleCallbackQuery(callbackQuery) {
  console.log(
    "Received callback query:",
    JSON.stringify(callbackQuery, null, 2)
  );
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data.split(":");
  console.log("Parsed callback data:", data);

  try {
    // Acknowledge the callback query to remove the loading spinner
    await axios.post(`${API_URL}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id,
    });
  } catch (err) {
    console.error("Error in answerCallbackQuery:", err.response?.data || err);
  }

  try {
    switch (data[0]) {
      case "search_init":
        await sendMessage(chatId, "Please use /search <query> to find content");
        break;
      case "help":
        await sendMessage(
          chatId,
          "🤖 <b>Bot Commands</b>\n\n" +
            "/start - Show main menu\n" +
            "/search <query> - Find content\n\n" +
            "Navigate using the inline buttons!"
        );
        break;
      case "page":
        await showSeasons(chatId, data[1]);
        break;
      case "season":
        await showEpisodes(chatId, data[1], data[2]);
        break;
      case "episode":
        await sendMedia(chatId, data[1], data[2], data[3]);
        break;
      case "back":
        await handleBackNavigation(chatId, data);
        break;
      default:
        await sendMessage(chatId, "❌ Unknown command");
    }
  } catch (error) {
    console.error("Error handling callback command:", error);
    await sendMessage(chatId, "⚠️ An error occurred. Please try again.");
  }
}

async function searchPages(chatId, query) {
  db.all(
    `SELECT id, name FROM pages 
       WHERE name LIKE ? 
       ORDER BY name LIMIT 10`,
    [`%${query}%`],
    (err, pages) => {
      if (err) {
        console.error("Search error:", err);
        return sendMessage(chatId, "❌ Search failed. Please try again.");
      }
      if (pages.length === 0) {
        return sendMessage(chatId, "🔍 No results found");
      }
      const buttons = pages.map((page) => [
        {
          text: page.name,
          callback_data: `page:${page.id}`,
        },
      ]);
      sendMessage(chatId, "🔎 Search results:", buttons);
    }
  );
}

async function showSeasons(chatId, pageId) {
  let loadingMessageId;
  try {
    // Send loading message
    const loadingMessage = await sendMessage(chatId, "⏳ Loading seasons...");
    loadingMessageId = loadingMessage.message_id;

    db.all(
      `SELECT season FROM media 
         WHERE page_id = ? 
         GROUP BY season 
         ORDER BY season`,
      [pageId],
      async (err, seasons) => {
        try {
          if (err) throw err;
          // Delete loading message
          await axios.post(`${API_URL}/deleteMessage`, {
            chat_id: chatId,
            message_id: loadingMessageId,
          });
          const buttons = seasons.map((season) => [
            {
              text: `Season ${season.season}`,
              callback_data: `season:${pageId}:${season.season}`,
            },
          ]);
          buttons.push([{ text: "← Back", callback_data: "back:search" }]);
          await sendMessage(chatId, "📺 Select season:", buttons);
        } catch (error) {
          console.error("Season load error:", error);
          await sendMessage(chatId, "❌ Failed to load seasons");
        }
      }
    );
  } catch (error) {
    console.error("Error in showSeasons:", error);
    await sendMessage(chatId, "⚠️ Failed to display seasons");
  }
}

async function showEpisodes(chatId, pageId, season) {
  db.all(
    `SELECT episode FROM media 
     WHERE page_id = ? AND season = ? 
     GROUP BY episode 
     ORDER BY episode`,
    [pageId, season],
    (err, episodes) => {
      if (err) {
        console.error("Episodes load error:", err);
        return sendMessage(chatId, "❌ Failed to load episodes");
      }
      const buttons = episodes.map((episode) => [
        {
          text: `Episode ${episode.episode}`,
          callback_data: `episode:${pageId}:${season}:${episode.episode}`,
        },
      ]);
      buttons.push([{ text: "← Back", callback_data: `back:page:${pageId}` }]);
      sendMessage(chatId, "Select episode:", buttons);
    }
  );
}

async function sendMedia(chatId, pageId, season, episode) {
  db.all(
    `SELECT * FROM media 
     WHERE page_id = ? AND season = ? AND episode = ? 
     ORDER BY type DESC`,
    [pageId, season, episode],
    async (err, mediaItems) => {
      if (err) {
        console.error("Media load error:", err);
        return sendMessage(chatId, "❌ Failed to load media");
      }
      const mediaGroups = {
        image: [],
        video: [],
      };
      mediaItems.forEach((item) => {
        mediaGroups[item.type].push(item.url);
      });
      if (mediaGroups.image.length > 0) {
        await sendPhotoGroup(chatId, mediaGroups.image);
      }
      mediaGroups.video.forEach(async (videoUrl, index) => {
        const caption =
          index === 0
            ? `Season ${escapeHtml(season)} Episode ${escapeHtml(episode)}`
            : "";
        await sendVideo(chatId, videoUrl, caption);
        await delay(500);
      });
    }
  );
}

// Simple HTML escape (used for media captions)
const escapeHtml = (text) => {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&/g, "&amp;");
};

async function sendMessage(chatId, text, buttons = []) {
  try {
    const response = await axios.post(`${API_URL}/sendMessage`, {
      chat_id: chatId,
      text, // Send text as-is so HTML formatting works
      parse_mode: "HTML",
      reply_markup:
        buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
    });
    console.log("Message sent:", response.data);
    return response.data;
  } catch (error) {
    console.error("Message send error:", error.response?.data || error);
    throw error;
  }
}

async function sendPhotoGroup(chatId, photoUrls) {
  await axios.post(`${API_URL}/sendMediaGroup`, {
    chat_id: chatId,
    media: photoUrls.map((url) => ({
      type: "photo",
      media: url,
    })),
  });
}

async function sendVideo(chatId, videoUrl, caption = "") {
  await axios.post(`${API_URL}/sendVideo`, {
    chat_id: chatId,
    video: videoUrl,
    caption,
    parse_mode: "HTML",
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleBackNavigation(chatId, data) {
  if (data[1] === "search") {
    await sendMainMenu(chatId);
  } else if (data[1] === "page" && data[2]) {
    await showSeasons(chatId, data[2]);
  } else {
    await sendMainMenu(chatId);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup on shutdown
process.on("SIGINT", () => {
  db.close();
  process.exit();
});
