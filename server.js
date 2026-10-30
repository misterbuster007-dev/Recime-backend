const express = require('express');
const cors = require('cors');
const { YoutubeTranscript } = require('youtube-transcript');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get('/parse-recipe', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).json({ error: "Missing video URL" });
    }

    try {
        let videoId = "";
        if (videoUrl.includes('youtu.be/')) {
            videoId = videoUrl.split('youtu.be/')[1]?.split('?')[0];
        } else if (videoUrl.includes('watch?v=')) {
            videoId = videoUrl.split('watch?v=')[1]?.split('&')[0];
        }

        if (!videoId) {
            return res.status(400).json({ error: "Invalid YouTube URL" });
        }

        // 1. Try fetching YouTube Transcript
        let contentSource = "";
        try {
            const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
            contentSource = "Transcript: " + transcriptItems.map(item => item.text).join(' ');
        } catch (err) {
            console.log("Transcript not available, fetching video page description...");
        }

        // 2. Fallback: Fetch YouTube page HTML to grab the description if transcript failed
        let videoTitle = "";
        let videoAuthor = "";
        try {
            const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            const html = await pageRes.text();
            
            // Extract title from meta tags
            const titleMatch = html.match(/<meta name="title" content="([^"]+)">/);
            if (titleMatch) videoTitle = titleMatch[1];

            // Extract description from meta tags if transcript was empty
            if (!contentSource) {
                const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
                if (descMatch) {
                    contentSource = "Video Description: " + descMatch[1];
                }
            }
        } catch (e) {
            console.log("Web fallback failed:", e);
        }

        const prompt = `You are an expert culinary data extractor and recipe parser. A user has shared a YouTube cooking video.
        Video Title: ${videoTitle}
        Video Content / Transcript / Description: ${contentSource.slice(0, 15000)}

        Task: 
        1. Clean up the recipe title: Ignore clickbait phrases like "I spent 5 years perfecting", "2 Ingredient Recipes", or "Better than...". Provide a clean, direct, professional culinary name for the dish (e.g., "Yogurt Donuts" or "2-Ingredient Yogurt Doughnuts").
        2. Extract precise ingredients with exact measurements (cups, grams, tsp/tbsp) and step-by-step instructions based strictly on the text above. 

        Return strictly valid JSON matching this exact structure with no markdown formatting around it: 
        {
          "title": "Clean Dish Name", 
          "author": "${videoAuthor || 'YouTube Creator'}", 
          "category": "Baking", 
          "prepTime": "15 mins", 
          "cookTime": "20 mins", 
          "defaultServings": 4, 
          "ingredients": [{"name": "Ingredient name", "amount": 1, "unit": "cup", "category": "Pantry & Grains"}], 
          "instructions": ["Step 1", "Step 2"]
        }`;

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

        parsedRecipe.image = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        parsedRecipe.id = Date.now().toString();

        res.json(parsedRecipe);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ReciMe backend running on port ${PORT}`));
