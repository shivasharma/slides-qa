import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import path from "path";
import { fileURLToPath } from "url";
import ollama from "ollama";

const app = express();
const PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// Robust CORS & Ngrok Support
// =========================
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // Mandatory for ngrok and custom frontend headers
  res.setHeader("Access-Control-Allow-Headers", "ngrok-skip-browser-warning, Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Serve chat UI
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "chap11-chat.html")));

// =========================
// Slide chunk caching
// =========================
const chunkCache = new Map();

async function getChunks(slideUrl) {
  if (chunkCache.has(slideUrl)) return chunkCache.get(slideUrl);

  try {
    console.log("📘 Fetching slides:", slideUrl);
    const response = await fetch(slideUrl);
    if (!response.ok) throw new Error(`Failed to fetch slides (${response.status})`);

    const html = await response.text();
    const dom = new JSDOM(html);

    // Improved text extraction
    const text = dom.window.document.body.textContent.replace(/\s+/g, " ").trim();
    const words = text.split(" ");
    const chunkSize = 250;
    const chunks = [];

    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(" "));
    }

    console.log(`✅ ${chunks.length} chunks created`);
    chunkCache.set(slideUrl, chunks);
    return chunks;
  } catch (error) {
    console.error("❌ Slide Fetch Error:", error);
    return [];
  }
}

// =========================
// Relevance scoring
// =========================
function scoreChunk(chunk, query) {
  const qWords = query.toLowerCase().split(/\W+/);
  const c = chunk.toLowerCase();
  return qWords.reduce((s, w) => (w.length > 2 && c.includes(w) ? s + 1 : s), 0);
}

function pickBestChunks(chunks, query, topN = 2) {
  const scored = chunks
    .map(c => ({ text: c, score: scoreChunk(c, query) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return chunks.slice(0, topN).join("\n\n"); // Fallback to first chunks
  return scored.slice(0, topN).map(c => c.text).join("\n\n");
}

// =========================
// Optimized Answer Route
// =========================
app.get("/answer", async (req, res) => {
  const { q: question, url: slideUrl, topic = "java", context: clientContext } = req.query;

  if (!question || !slideUrl) {
    return res.status(400).send("Missing required parameters (q, url)");
  }

  try {
    const chunks = await getChunks(slideUrl);

    // Improved Filter: Only block if it's definitely NOT Java
    const javaKeywords = /java|class|object|method|inheritance|constructor|interface|variable|loop|array|string|static|void/i;
    if (topic.toLowerCase() === "java" && !javaKeywords.test(question)) {
      return res.send("I am your Java assistant. Please ask a question related to Java programming.");
    }

    const selectedChunks = pickBestChunks(chunks, question);
    const context = clientContext && clientContext.length > 100 ? clientContext : selectedChunks;

    // Streaming Headers for Browsers
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Transfer-Encoding", "chunked");

    const prompt = `
You are a Java programming instructor for the slides provided.
CONTEXT FROM SLIDES:
${context}

STRICT RULES:
1. Answer ONLY Java-related questions.
2. Use the slide content above.
3. If the answer is NOT in the context, say: "That specific detail is not covered in Chapter 11."
4. Be brief (1-2 sentences).

QUESTION: ${question}
ANSWER:`;

    const stream = await ollama.generate({
      model: "qwen2.5-coder:1.5b-base",
      prompt,
      stream: true
    });

    for await (const part of stream) {
      res.write(part.response);
    }

    res.end();

  } catch (err) {
    console.error("❌ /answer error:", err);
    if (!res.headersSent) {
      res.status(500).send("Error generating answer.");
    } else {
      res.end("\n[Error during generation]");
    }
  }
});

app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
