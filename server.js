const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

function isYouTubeUrl(url) {
    return url.includes('youtube.com') || url.includes('youtu.be');
}

function extractYouTubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

app.get('/parse-recipe', async (req, res) => {
    const inputUrl = req.query.url;
    if (!inputUrl) {
        return res.status(400).json({ error: "Missing URL parameter" });
    }

    try {
        let recipeData = null;

        if (isYouTubeUrl(inputUrl)) {
            recipeData = await parseYouTubeRecipe(inputUrl);
        } else {
            recipeData = await parseWebsiteRecipe(inputUrl);
        }

        res.json(recipeData);

    } catch (error) {
        console.error("Parsing Error:", error.message);
        res.status(500).json({ error: "Could not parse recipe from URL: " + error.message });
    }
});

// --- WEBSITE RECIPE PARSER ---
async function parseWebsiteRecipe(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);

    let jsonLdData = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const parsed = JSON.parse($(el).html());
            if (parsed['@type'] === 'Recipe' || (Array.isArray(parsed) && parsed.some(item => item['@type'] === 'Recipe'))) {
                jsonLdData = Array.isArray(parsed) ? parsed.find(item => item['@type'] === 'Recipe') : parsed;
            } else if (parsed['@graph']) {
                const found = parsed['@graph'].find(item => item['@type'] === 'Recipe');
                if (found) jsonLdData = found;
            }
        } catch (e) {}
    });

    const pageTitle = $('title').text() || $('h1').first().text();
    const bodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 15000);

    const prompt = `You are a universal recipe parsing engine.
    Website URL: ${url}
    Page Title: ${pageTitle}
    Structured JSON-LD Data: ${jsonLdData ? JSON.stringify(jsonLdData) : "None"}
    Raw Page Content: ${jsonLdData ? "Not needed" : bodyText}

    Extract and structure the recipe into clean, valid JSON.
    Return strictly valid JSON matching this exact structure with no markdown wrapper:
    {
      "title": "Recipe Title",
      "author": "Author Name",
      "category": "Main Course",
      "prepTime": "15 mins",
      "cookTime": "30 mins",
      "defaultServings": 4,
      "ingredients": [{"name": "Ingredient name", "amount": 1, "unit": "cup", "category": "Pantry"}],
      "instructions": ["Step 1", "Step 2"],
      "image": "Image URL if available"
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
    const parsedRecipe = JSON.parse(geminiData.candidates[0].content.parts[0].text);
    parsedRecipe.id = Date.now().toString();
    return parsedRecipe;
}

// --- YOUTUBE RECIPE PARSER ---
async function parseYouTubeRecipe(url) {
    const videoId = extractYouTubeId(url);
    let videoTitle = "YouTube Recipe";
    let videoAuthor = "YouTube Creator";
    let webContext = "";

    try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
        if (oembedRes.ok) {
            const oembedData = await oembedRes.json();
            videoTitle = oembedData.title || videoTitle;
            videoAuthor = oembedData.author_name || videoAuthor;
        }
    } catch (e) {}

    try {
        const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const html = await pageRes.text();
        const descMatch = html.match(/<meta name="description" content="([^"]+)">/);
        if (descMatch) {
            webContext = descMatch[1];
        }
    } catch (e) {}

    const prompt = `You are an expert culinary recipe parser and professional chef. 
    The user has shared a YouTube cooking video link.
    Video Title: "${videoTitle}"
    Channel / Creator: "${videoAuthor}"
    Video Description / Context: "${webContext}"

    Task:
    Provide the complete, precise, professional recipe featured or discussed in this video. 

    Return strictly valid JSON matching this exact structure with no markdown formatting around it: 
    {
      "title": "Recipe Title", 
      "author": "${videoAuthor}", 
      "category": "Main Course", 
      "prepTime": "30 mins", 
      "cookTime": "20 mins", 
      "defaultServings": 4, 
      "ingredients": [
        {"name": "Ingredient name", "amount": 1, "unit": "cup", "category": "Pantry & Grains"}
      ], 
      "instructions": [
        "Step 1 text",
        "Step 2 text"
      ]
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
    const parsedRecipe = JSON.parse(geminiData.candidates[0].content.parts[0].text);
    parsedRecipe.image = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    parsedRecipe.id = Date.now().toString();
    return parsedRecipe;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
