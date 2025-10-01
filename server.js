import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// CRITICAL: CORS must come BEFORE express.json()
app.use(
  cors({
    origin: "chrome-extension://dcjoknhdcfdpodgkpmekmmddcloinhak", // For production
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: false,
  })
);

// Handle preflight requests
app.options(/.*/, cors());

app.use(express.json());

// Initialize GoogleGenAI client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

console.log("API Key loaded: ", process.env.GEMINI_API_KEY ? "YES" : "NO");

app.post("/group-tabs", async (req, res) => {
  console.log("\n=== NEW REQUEST ===");
  console.log("Headers:", req.headers);
  console.log("Origin:", req.headers.origin);

  try {
    const { tabs } = req.body;

    if (!tabs || tabs.length === 0) {
      console.log("❌ No tabs provided");
      return res.status(400).json({ error: "No tabs provided" });
    }

    console.log(`✓ Received ${tabs.length} tabs to group`);

    // Prepare message content
    const tabText = tabs
      .map((tab) => `ID:${tab.id} | ${tab.title} (${tab.url})`)
      .join("\n");

    const prompt = `You are an AI assistant that groups browser tabs into relevant categories. Analyze these browser tabs and group them by topic/purpose.

Return ONLY a valid JSON object with NO markdown, NO code blocks, NO explanations. Just the raw JSON.

The JSON should have category names as keys (strings) and arrays of tab IDs (integers) as values.

Example format:
{"Shopping": [1, 5], "News": [2, 3], "Development": [4, 6]}

Here are the tabs to group:
${tabText}`;

    // Call Gemini API with retry logic
    console.log("Calling Gemini API...");
    let response;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        response = await ai.models.generateContent({
          model: "gemini-2.0-flash-001",
          contents: prompt,
        });
        console.log("Got response from Gemini");
        break; // Success, exit loop
      } catch (apiError) {
        attempts++;
        console.log(`⚠️  Attempt ${attempts} failed:`, apiError.message);

        if (attempts >= maxAttempts) {
          throw apiError; // Give up after max attempts
        }

        // Wait before retrying (exponential backoff)
        const waitTime = 1000 * attempts;
        console.log(`⏳ Waiting ${waitTime}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    console.log("Response type:", typeof response);
    console.log("Response keys:", Object.keys(response));

    // Extract text from response
    let resultText;
    if (response.text) {
      resultText = response.text;
    } else if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
      resultText = response.candidates[0].content.parts[0].text;
    } else if (typeof response === "string") {
      resultText = response;
    } else {
      console.error(
        "Unexpected response structure:",
        JSON.stringify(response, null, 2)
      );
      return res.status(500).json({
        error: "Unexpected API response structure",
        responseKeys: Object.keys(response),
      });
    }

    console.log("Extracted text:", resultText.substring(0, 200) + "...");

    // Parse JSON from extracted text
    let groups;
    try {
      // Try direct parse first
      groups = JSON.parse(resultText);
      console.log("✓ Direct JSON parse successful");
    } catch (err) {
      // If that fails, try to extract JSON from markdown code blocks or extra text
      console.log("⚠️  Direct parse failed, trying to extract JSON...");

      const jsonMatch =
        resultText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
        resultText.match(/(\{[\s\S]*\})/);

      if (jsonMatch) {
        try {
          groups = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          console.log("✓ Extracted JSON parse successful");
        } catch (parseErr) {
          console.error("❌ Failed to parse extracted JSON:", parseErr);
          return res.status(500).json({
            error: "Failed to parse AI response as JSON",
            rawResponse: resultText.substring(0, 500),
          });
        }
      } else {
        console.error("❌ No JSON found in response");
        return res.status(500).json({
          error: "No valid JSON found in AI response",
          rawResponse: resultText.substring(0, 500),
        });
      }
    }

    // Validate the response structure
    if (typeof groups !== "object" || groups === null) {
      console.error("❌ Invalid response structure");
      return res.status(500).json({
        error: "Invalid response structure from AI",
        received: groups,
      });
    }

    console.log("✓ Successfully parsed groups:", Object.keys(groups));
    console.log("=== REQUEST COMPLETE ===\n");

    res.json(groups);
  } catch (error) {
    console.error("❌ Error in /group-tabs:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({
      error: "Something went wrong",
      details: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.listen(port, () => {
  console.log(`\n🚀 Server running at http://localhost:${port}`);
  console.log(
    `🔑 API Key: ${process.env.GEMINI_API_KEY ? "Loaded ✓" : "Missing ✗"}\n`
  );
});
