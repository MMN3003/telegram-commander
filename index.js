const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const axios = require("axios");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

// Database setup
const db = new sqlite3.Database(process.env.DB_PATH || "./crawler.db");

// Initialize database tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      type TEXT CHECK(type IN ('image', 'video')),
      season TEXT,
      episode TEXT,
      resolution TEXT,
      processed BOOLEAN DEFAULT 0,
      FOREIGN KEY (page_id) REFERENCES pages(id)
    )
  `);
});

// Telegram configuration
const BOT_TOKEN = process.env.TELEGRAM_BOT_API_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Utility functions
const escapeHtml = (text) => {
  return text
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&/g, "&amp;");
};

// Puppeteer browser instance
let browser;

// Initialize Puppeteer
(async () => {
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
})();

// Telegram interaction handlers
app.post("/webhook", async (req, res) => {
  const update = req.body;
  try {
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query)
      await handleCallbackQuery(update.callback_query);
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    res.sendStatus(500);
  }
});

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";

  try {
    if (text.startsWith("/start")) {
      await sendMainMenu(chatId);
    } else if (text.startsWith("/search")) {
      const query = text.slice(7).trim();
      query ? await searchPages(chatId, query) : await sendSearchPrompt(chatId);
    } else {
      await sendMessage(chatId, "🔍 Use /search to find content");
    }
  } catch (error) {
    console.error("Message handling error:", error);
    await sendMessage(chatId, "⚠️ Error processing request");
  }
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data.split(":");

  try {
    await axios.post(`${API_URL}/answerCallbackQuery`, {
      callback_query_id: callbackQuery.id,
    });

    switch (data[0]) {
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
      case "help":
        await showHelp(chatId);
        break;
      default:
        await sendMessage(chatId, "❌ Unknown command");
    }
  } catch (error) {
    console.error("Callback error:", error);
    await sendMessage(chatId, "⚠️ Error processing request");
  }
}

// Database operations
async function searchPages(chatId, query) {
  db.all(
    `SELECT id, name FROM pages 
     WHERE name LIKE ? 
     ORDER BY name LIMIT 10`,
    [`%${escapeHtml(query)}%`],
    async (err, pages) => {
      if (err) {
        console.error("Search error:", err);
        return await sendMessage(chatId, "❌ Search failed");
      }

      if (!pages.length) {
        return await sendMessage(chatId, "🔍 No results found");
      }

      const buttons = pages.map((page) => [
        {
          text: page.name,
          callback_data: `page:${page.id}`,
        },
      ]);

      await sendMessage(chatId, "🔎 Search results:", buttons);
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
    async (err, seasons) => {
      if (err) {
        console.error("Season error:", err);
        return await sendMessage(chatId, "❌ Failed to load seasons");
      }

      const buttons = seasons.map((season) => [
        {
          text: `Season ${season.season}`,
          callback_data: `season:${pageId}:${season.season}`,
        },
      ]);

      buttons.push([{ text: "← Back", callback_data: "back:search" }]);
      await sendMessage(chatId, "📺 Select season:", buttons);
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
    async (err, episodes) => {
      if (err) {
        console.error("Episode error:", err);
        return await sendMessage(chatId, "❌ Failed to load episodes");
      }

      const buttons = episodes.map((episode) => [
        {
          text: `Episode ${episode.episode}`,
          callback_data: `episode:${pageId}:${season}:${episode.episode}`,
        },
      ]);

      buttons.push([{ text: "← Back", callback_data: `back:page:${pageId}` }]);
      await sendMessage(chatId, "🎬 Select episode:", buttons);
    }
  );
}

// Media handling
async function sendMedia(chatId, pageId, season, episode) {
  db.all(
    `SELECT * FROM media 
     WHERE page_id = ? AND season = ? AND episode = ? 
     ORDER BY type DESC`,
    [pageId, season, episode],
    async (err, mediaItems) => {
      if (err) {
        console.error("Media error:", err);
        return await sendMessage(chatId, "❌ Failed to load media");
      }

      try {
        // Send images
        const images = mediaItems.filter((item) => item.type === "image");
        if (images.length) {
          await sendPhotoGroup(
            chatId,
            images.map((img) => img.url)
          );
        }

        // Send videos
        const videos = mediaItems.filter((item) => item.type === "video");
        for (const [index, video] of videos.entries()) {
          const caption =
            index === 0 ? `📼 Season ${season} Episode ${episode}` : "";
          await sendVideo(chatId, video.url, caption);
          await delay(500);
        }

        // Mark as processed
        db.run(
          `UPDATE media SET processed = 1 WHERE id IN (${videos
            .map((v) => v.id)
            .join(",")})`
        );
      } catch (error) {
        console.error("Media send error:", error);
        await sendMessage(chatId, "⚠️ Error sending media");
      }
    }
  );
}

// Telegram API helpers
async function sendMainMenu(chatId) {
  const buttons = [
    [{ text: "🔍 Search Content", callback_data: "search_init" }],
    [{ text: "ℹ️ Help", callback_data: "help" }],
  ];
  await sendMessage(chatId, "🎬 Welcome to MediaBot!", buttons);
}

async function showHelp(chatId) {
  const helpText = `
🤖 <b>MediaBot Commands</b>

🔍 /search &lt;query&gt; - Find media content
🏠 /start - Return to main menu

📌 Use the inline buttons to navigate through seasons and episodes
  `;
  await sendMessage(chatId, helpText);
}

async function sendMessage(chatId, text, buttons = []) {
  try {
    await axios.post(`${API_URL}/sendMessage`, {
      chat_id: chatId,
      text: escapeHtml(text),
      parse_mode: "HTML",
      reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
    });
  } catch (error) {
    console.error("Send message error:", error.response?.data);
  }
}

async function sendPhotoGroup(chatId, urls) {
  try {
    await axios.post(`${API_URL}/sendMediaGroup`, {
      chat_id: chatId,
      media: urls.map((url) => ({ type: "photo", media: url })),
    });
  } catch (error) {
    console.error("Photo group error:", error.response?.data);
  }
}

async function sendVideo(chatId, url, caption = "") {
  try {
    await axios.post(`${API_URL}/sendVideo`, {
      chat_id: chatId,
      video: url,
      caption: escapeHtml(caption),
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Video send error:", error.response?.data);
  }
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
process.on("SIGINT", async () => {
  db.close();
  if (browser) await browser.close();
  process.exit();
});