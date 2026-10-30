const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

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
        let videoTitle = "YouTube Recipe";
        let videoAuthor = "YouTube Creator";
        let transcriptText = "";

        // 1. Fetch metadata via oEmbed
        try {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
            if (oembedRes.ok) {
                const oembedData = await oembedRes.json();
                videoTitle = oembedData.title || videoTitle;
                videoAuthor = oembedData.author_name || videoAuthor;
            }
        } catch (e) {}

        // 2. Extract transcript safely using YouTube's timedtext player track data
        try {
            const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            const html = await pageRes.text();

            // Extract description fallback
            const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
            let description = descMatch ? descMatch[1] : "";

            // Find caption tracks from player config
            const ytInitialPlayerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
            if (ytInitialPlayerResponseMatch) {
                const playerResponse = JSON.parse(ytInitialPlayerResponseMatch[1]);
                const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                
                if (captionTracks && captionTracks.length > 0) {
                    // Grab English or first available caption track URL
                    const track = captionTracks.find(t => t.languageCode === 'en') || captionTracks[0];
                    const subtitleRes = await fetch(track.baseUrl + '&fmt=json3');
                    if (subtitleRes.ok) {
                        const subJson = await subtitleRes.json();
                        if (subJson.events) {
                            transcriptText = subJson.events
                                .filter(event => event.segs)
                                .map(event => event.segs.map(seg => seg.utf8).join(''))
                                .join(' ');
                        }
                    }
                }
            }

            // If captions couldn't be parsed, use description + title as the rich text source
            if (!transcriptText || transcriptText.length < 50) {
                transcriptText = `Title: ${videoTitle}\nDescription: ${description}`;
            }
        } catch (err) {
            console.log("Transcript fetching error:", err.message);
            transcriptText = `Title: ${videoTitle}`;
        }

        // 3. Construct Precision Gemini Prompt
        const prompt = `You are an expert culinary data extractor and professional chef. A user has shared a YouTube cooking video.
        Video Title: ${videoTitle}
        Creator: ${videoAuthor}
        Video Transcript / Content Data: ${transcriptText.slice(0, 25000)}

        Strict Instructions:
        1. Extract the EXACT recipe details explained in the text/transcript above. Do not guess or use a generic recipe if specific measurements or steps (like poolish, specific flours, rest times) are mentioned.
        2. Ingredients MUST contain precise amounts, units, and categories.
        3. Clean up clickbait titles into a professional culinary name.
        4. Group multi-stage instructions cleanly.

        Return strictly valid JSON matching this exact structure with no markdown formatting around it: 
        {
          "title": "Clean Dish Name", 
          "author": "${videoAuthor}", 
          "category": "Main Course", 
          "prepTime": "30 mins", 
          "cookTime": "2 mins", 
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
        console.error("Server parse error:", error);
        res.status(500).json({ error: "Server failed to parse recipe: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ReciMe backend running on port ${PORT}`));
