const fs = require("fs");
const axios = require("axios");
const chokidar = require("chokidar");
require("dotenv").config(); // Load environment variables from .env file

// Configuration from .env
const API_KEY = process.env.TELEGRAM_BOT_API_KEY;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // or channel ID
const WATCH_DIR = process.env.WATCH_DIR || "./links"; // Directory to watch for changes
const CAPTION_MAX_LENGTH = parseInt(process.env.CAPTION_MAX_LENGTH) || 1024; // Telegram's caption limit
const BASE_DELAY = parseInt(process.env.BASE_DELAY) || 500; // Base delay between messages in ms
const MAX_RETRIES = 3; // Maximum number of retries for failed requests

// Helpers
const isImage = (url) => /\.(png|jpg|jpeg)$/i.test(url);
const isVideo = (url) => /\.(mkv|mp4)$/i.test(url);

// Extract file name from URL
const extractFileName = (url) => {
  const parts = url.split("/");
  const fileName = parts[parts.length - 1]; // Get the last part of the URL
  // splite by . and remove the last part
  const nameParts = fileName.split(".").slice(0, -1);
  return nameParts.join().replace(/-/g, " "); // Replace dots and dashes with spaces
};

// Extract season and episode from URL
const extractSeasonAndEpisode = (url) => {
  // Match S01.E01 or S01.01 format
  const seasonEpisodeMatch = url.match(/\.(S\d+\.(?:E\d+|\d{2}))\./i);
  if (seasonEpisodeMatch) {
    const [season, episode] = seasonEpisodeMatch[1].split(".");
    const episodeNumber = episode.startsWith("E") ? episode.slice(1) : episode; // Handle E01 or 01
    return `Season ${season.slice(1)}, Episode ${episodeNumber}`;
  }

  // Match episode-only format (e.g., 51)
  const episodeOnlyMatch = url.match(/\.(\d{2})\./i);
  if (episodeOnlyMatch) {
    return `Episode ${episodeOnlyMatch[1]}`;
  }

  return "Unknown Season and Episode";
};

// Extract resolution from video URL
const extractResolution = (url) => {
  const match = url.match(/\.(480p|720p|1080p)\./i);
  return match ? match[1].toUpperCase() : "Unknown Resolution";
};

// Send photo with caption to Telegram (with retry logic)
async function sendPhotoToTelegram(imageUrl, caption, retryCount = 0) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${API_KEY}/sendPhoto`,
      {
        chat_id: CHAT_ID,
        photo: imageUrl,
        caption: caption,
        parse_mode: "HTML",
        disable_notification: true,
      }
    );
    console.log(`Sent: ${caption}`);
    return response.data;
  } catch (error) {
    if (error.response?.data?.error_code === 429 && retryCount < MAX_RETRIES) {
      // Rate limit exceeded, retry after the specified delay
      const retryAfter = error.response.data.parameters?.retry_after || 10; // Default to 10 seconds
      console.log(
        `Rate limit exceeded. Retrying after ${retryAfter} seconds...`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return sendPhotoToTelegram(imageUrl, caption, retryCount + 1);
    } else {
      console.error(
        `Error sending ${caption}:`,
        error.response?.data?.description || error.message
      );
      throw error;
    }
  }
}

// Process links from a file
async function processFile(filePath) {
  try {
    // Read and parse links
    const data = fs.readFileSync(filePath, "utf8");
    const urls = data.split("\n").filter((link) => link.trim() !== "");

    // Group images with their videos
    const groups = [];
    let currentGroup = null;

    for (const url of urls) {
      if (isImage(url)) {
        if (currentGroup) groups.push(currentGroup);
        currentGroup = { image: url, videos: [] };
      } else if (isVideo(url) && currentGroup) {
        currentGroup.videos.push(url);
      }
    }
    if (currentGroup) groups.push(currentGroup);

    // Process each group
    for (const group of groups) {
      // Organize videos by resolution
      const videosByResolution = group.videos.reduce((acc, video) => {
        const resolution = extractResolution(video);
        if (!acc[resolution]) acc[resolution] = [];
        acc[resolution].push(video);
        return acc;
      }, {});

      // Send a separate message for each resolution
      for (const [resolution, videos] of Object.entries(videosByResolution)) {
        const title = extractFileName(filePath);
        const header = `<b>${title}</b>\n<b>${resolution}</b>\n\n`;
        let caption = header;

        // Add video links to the caption
        for (const video of videos) {
          const seasonEpisode = extractSeasonAndEpisode(video);
          const filename = video.split("/").pop();
          const link = `${seasonEpisode}: <a href="${video}">${filename}</a>`;
          const newCaption = caption + link + "\n";

          // If the new caption exceeds the limit, send the current caption and start a new one
          if (newCaption.length > CAPTION_MAX_LENGTH) {
            await sendPhotoToTelegram(group.image, caption.trim());
            caption = header + link + "\n"; // Start new caption with the header and current link
          } else {
            caption = newCaption;
          }
        }

        // Send the remaining caption
        if (caption.trim() !== header.trim()) {
          await sendPhotoToTelegram(group.image, caption.trim());
        }

        // Add delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY));
      }
    }

    console.log(`Processed file: ${filePath}`);
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
  }
}

// Watch directory for changes
function watchDirectory() {
  const watcher = chokidar.watch(WATCH_DIR, {
    persistent: true,
    ignoreInitial: true, // Ignore initial scan
  });

  watcher
    .on("add", (filePath) => {
      console.log(`File added: ${filePath}`);
      processFile(filePath);
    })
    .on("change", (filePath) => {
      console.log(`File changed: ${filePath}`);
      processFile(filePath);
    })
    .on("error", (error) => {
      console.error(`Watcher error: ${error}`);
    });

  console.log(`Watching directory: ${WATCH_DIR}`);
}

// Start watching the directory
watchDirectory();
