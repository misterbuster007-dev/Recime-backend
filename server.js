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

        let contentText = "";
        let videoTitle = "YouTube Recipe";
        let videoAuthor = "YouTube Creator";

        // 1. Try fetching YouTube Transcript first
        try {
            const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
            contentText = transcriptItems.map(item => item.text).join(' ');
            console.log("Successfully fetched transcript.");
        } catch (err) {
            console.log("Transcript not available, fetching page metadata & description fallback...");
        }

        // 2. Fetch YouTube oEmbed / page data for title and description fallback
        try {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
            if (oembedRes.ok) {
                const oembedData = await oembedRes.json();
                videoTitle = oembedData.title || videoTitle;
                videoAuthor = oembedData.author_name || videoAuthor;
            }
        } catch (e) {}

        // 3. If transcript is empty, fetch HTML description as the content source
        if (!contentText || contentText.length < 50) {
            try {
                const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                });
                const html = await pageRes.text();
                
                // Pull meta description
                const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
                if (descMatch) {
                    contentText = descMatch[1];
                }
            } catch (e) {
                console.log("HTML fallback failed:", e);
            }
        }

        // Safety check if we still have nothing
        if (!contentText) {
            contentText = `Video Title: ${videoTitle}. Please extract a standard recipe for this dish based on the title and common culinary practices.`;
        }

        const prompt = `You are an expert culinary data extractor and recipe parser. A user has shared a YouTube cooking video.
        Video Title: ${videoTitle}
        Channel Name: ${videoAuthor}
        Video Content / Description / Transcript: ${contentText.slice(0, 15000)}

        Task: 
        1. Clean up the recipe title: Ignore clickbait phrases like "I spent 5 years perfecting" or "Better than...". Provide a clean, direct, professional culinary name for the dish (e.g., "2-Ingredient Yogurt Donuts").
        2. Extract precise ingredients with exact measurements (cups, grams, tsp/tbsp) and step-by-step instructions based on the text above.

        Return strictly valid JSON matching this exact structure with no markdown formatting around it: 
        {
          "title": "Clean Dish Name", 
          "author": "${videoAuthor}", 
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
