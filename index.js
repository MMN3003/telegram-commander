const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database(process.env.DB_PATH || "./crawler.db");

// Session management
const userSessions = new Map();

// Telegram API configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Set up webhook
axios
  .post(`${API_URL}/setWebhook`, { url: WEBHOOK_URL })
  .then(() => console.log("Webhook set successfully"))
  .catch((err) => console.error("Error setting webhook:", err));

// Handle incoming updates
app.post("/webhook", async (req, res) => {
  const update = req.body;
  if (update.message) {
    await handleMessage(update.message);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  }
  res.sendStatus(200);
});

// Command handlers
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";

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
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data.split(":");

  switch (data[0]) {
    case "search_init":
      sendMessage(chatId, "Please use /search <query> to find content");
      break;
    case "help":
      sendMessage(
        chatId,
        "🤖 Bot Commands:\n\n" +
          "/start - Show main menu\n" +
          "/search <query> - Find content\n\n" +
          "Navigate using the inline buttons!"
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
  }
}

// Database query functions
async function searchPages(chatId, query) {
  db.all(
    `SELECT id, name FROM pages 
     WHERE name LIKE ? 
     ORDER BY name LIMIT 10`,
    [`%${query}%`],
    (err, pages) => {
      if (err) return console.error(err);

      const buttons = pages.map((page) => [
        {
          text: page.name,
          callback_data: `page:${page.id}`,
        },
      ]);

      sendMessage(chatId, "Search results:", buttons);
    }
  );
}

async function showSeasons(chatId, pageId) {
  db.all(
    `SELECT season FROM media 
     WHERE page_id = ? 
     GROUP BY season 
     ORDER BY season`,
    [pageId],
    (err, seasons) => {
      if (err) return console.error(err);

      const buttons = seasons.map((season) => [
        {
          text: `Season ${season.season}`,
          callback_data: `season:${pageId}:${season.season}`,
        },
      ]);

      buttons.push([{ text: "← Back", callback_data: "back:search" }]);
      sendMessage(chatId, "Select season:", buttons);
    }
  );
}

async function showEpisodes(chatId, pageId, season) {
  db.all(
    `SELECT episode FROM media 
     WHERE page_id = ? AND season = ? 
     GROUP BY episode 
     ORDER BY episode`,
    [pageId, season],
    (err, episodes) => {
      if (err) return console.error(err);

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

// Media sending function
async function sendMedia(chatId, pageId, season, episode) {
  db.all(
    `SELECT * FROM media 
     WHERE page_id = ? AND season = ? AND episode = ? 
     ORDER BY type DESC`,
    [pageId, season, episode],
    async (err, mediaItems) => {
      if (err) return console.error(err);

      // Group media by type
      const mediaGroups = {
        image: [],
        video: [],
      };

      mediaItems.forEach((item) => {
        mediaGroups[item.type].push(item.url);
      });

      // Send image first
      if (mediaGroups.image.length > 0) {
        await sendPhotoGroup(chatId, mediaGroups.image);
      }

      // Send videos with captions
      mediaGroups.video.forEach(async (videoUrl, index) => {
        const caption =
          index === 0 ? `Season ${season} Episode ${episode}` : "";

        await sendVideo(chatId, videoUrl, caption);
        await delay(500); // Rate limiting
      });
    }
  );
}

// Telegram API helpers
async function sendMessage(chatId, text, buttons = []) {
  const replyMarkup =
    buttons.length > 0
      ? {
          inline_keyboard: buttons,
        }
      : undefined;

  await axios.post(`${API_URL}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup
process.on("SIGINT", () => {
  db.close();
  process.exit();
});
