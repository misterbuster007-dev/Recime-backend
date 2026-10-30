const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { getSubtitles } = require('youtube-caption-extractor');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Helper function to extract 11-character Video ID (handles regular URLs, Shorts, and shortlinks)
function extractVideoId(url) {
    if (!url) return null;
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

app.get('/parse-recipe', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).json({ error: "Missing video URL parameter" });
    }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) {
        return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    try {
        let transcriptText = "";
        let videoTitle = "";
        let videoAuthor = "";

        // 1. Fetch metadata (Title & Creator) via YouTube oEmbed
        try {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
            if (oembedRes.ok) {
                const oembedData = await oembedRes.json();
                videoTitle = oembedData.title || "";
                videoAuthor = oembedData.author_name || "";
            }
        } catch (e) {
            console.log("oEmbed fetch failed:", e.message);
        }

        // 2. Extract Full Subtitles / Captions (Word-for-Word Audio)
        try {
            const subtitles = await getSubtitles({ videoID: videoId, lang: 'en' });
            if (subtitles && subtitles.length > 0) {
                transcriptText = subtitles.map(item => item.text).join(' ');
                console.log(`Successfully fetched ${transcriptText.length} characters of transcript.`);
            }
        } catch (subErr) {
            console.log("Primary caption extraction failed, attempting page fallback...", subErr.message);
        }

        // 3. Fallback: Page Description Scraping (If captions/subtitles are completely missing)
        if (!transcriptText || transcriptText.length < 50) {
            try {
                const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                const html = await pageRes.text();
                const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
                if (descMatch) {
                    transcriptText = "Description Content: " + descMatch[1];
                }
            } catch (pageErr) {
                console.log("Page description fallback failed:", pageErr.message);
            }
        }

        // Strict Enforcement: If NO transcript/description exists, fail cleanly rather than guessing
        if (!transcriptText || transcriptText.length < 30) {
            return res.status(422).json({ 
                error: "This video does not contain audio captions or written recipe text. Please try a video with spoken instructions or a detailed description." 
            });
        }

        // 4. Construct Precision Gemini Prompt
        const prompt = `You are an expert culinary data extractor. A user shared a YouTube cooking video.
        Video Title: ${videoTitle}
        Creator: ${videoAuthor}
        Audio Transcript / Text Data: ${transcriptText.slice(0, 20000)}

        Strict Instructions:
        1. Extract the EXACT recipe details explained in the transcript.
        2. Pay special attention to fermentation stages, poolish/preferments, temperature rests, and specific flour types (e.g., Tipo 00, Manitoba) if spoken in the video.
        3. Ingredients MUST contain exact gram/cup/tsp measurements directly cited from the audio.
        4. Normalize clickbait titles: Clean up the dish title (e.g., convert "One Guy Changed My Pizza Game Forever" to "Authentic Neapolitan Pizza Masterclass").
        5. Group multi-stage instructions clearly (e.g., Poolish Prep, Dough Mixing, Assembly, Baking).

        Return strictly valid JSON with no markdown syntax wrapping around it:
        {
          "title": "Clean Professional Recipe Title", 
          "author": "${videoAuthor || 'YouTube Creator'}", 
          "category": "Main Course", 
          "prepTime": "30 mins", 
          "cookTime": "2 mins", 
          "defaultServings": 4, 
          "ingredients": [
            {"name": "Tipo 00 Flour (Poolish)", "amount": 200, "unit": "g", "category": "Pantry & Grains"},
            {"name": "Honey", "amount": 5, "unit": "g", "category": "Pantry & Grains"}
          ], 
          "instructions": [
            "Prepare the Poolish: Mix 200g water, 5g honey, 5g yeast, and 200g Tipo 00 flour. Rest for 1 hour at room temp, then chill in fridge for 16-24 hours.",
            "Dough Integration: Dissolve 20g salt into 300g water. Combine with poolish, 300g Manitoba flour, and 200g Tipo 00 flour..."
          ]
        }`;

        // 5. Send to Gemini 2.5 Flash
        const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        const geminiData = await geminiRes.json();
        if (geminiData.error) {
            throw new Error(geminiData.error.message);
        }

        const rawJsonText = geminiData.candidates[0].content.parts[0].text;
        const parsedRecipe = JSON.parse(rawJsonText);

        // Attach thumbnail & unique ID
        parsedRecipe.image = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        parsedRecipe.id = Date.now().toString();

        res.json(parsedRecipe);

    } catch (error) {
        console.error("Server error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ReciMe backend running on port ${PORT}`));
