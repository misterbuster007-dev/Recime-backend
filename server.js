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

// Safe JSON parser to strip markdown backticks if Gemini includes them
function cleanAndParseJSON(text) {
    let cleanText = text.trim();
    if (cleanText.startsWith("```json")) {
        cleanText = cleanText.replace(/^```json/, "").replace(/```$/, "").trim();
    } else if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```/, "").replace(/```$/, "").trim();
    }
    return JSON.parse(cleanText);
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
            recipeData = await parseUniversalWebRecipe(inputUrl);
        }

        res.json(recipeData);

    } catch (error) {
        console.error("Universal Parsing Error:", error.message);
        res.status(500).json({ error: "Could not parse recipe from URL: " + error.message });
    }
});

// --- UNIVERSAL WEB & SOCIAL MEDIA PARSER ---
async function parseUniversalWebRecipe(url) {
    let pageTitle = "";
    let pageDescription = "";
    let pageImage = "";
    let rawBodyText = "";

    try {
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const html = await response.text();
        const $ = cheerio.load(html);

        pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || $('h1').first().text();
        pageDescription = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || "";
        pageImage = $('meta[property="og:image"]').attr('content') || "";
        rawBodyText = $('body').text().replace(/\s+/g, ' ').slice(0, 15000);
    } catch (e) {
        console.log("Web fetch warning:", e.message);
    }

    const prompt = `You are an expert culinary recipe parser and professional chef. 
    Source URL: ${url}
    Page Title: "${pageTitle}"
    Social Caption / Meta Description: "${pageDescription}"
    General Page Content: "${rawBodyText.slice(0, 4000)}"

    Task:
    Extract the complete, precise recipe from the provided text or caption. Provide exact ingredient measurements, units, categories, and clear step-by-step instructions.

    Return strictly valid JSON matching this exact structure with no markdown formatting around it: 
    {
      "title": "Clean Recipe Title", 
      "author": "Creator or Site Name", 
      "category": "Main Course", 
      "prepTime": "15 mins", 
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
    if (geminiData.error) {
        throw new Error(geminiData.error.message);
    }

    const rawText = geminiData.candidates[0].content.parts[0].text;
    const parsedRecipe = cleanAndParseJSON(rawText);

    if (pageImage && !parsedRecipe.image) {
        parsedRecipe.image = pageImage;
    }
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
    if (geminiData.error) {
        throw new Error(geminiData.error.message);
    }

    const rawText = geminiData.candidates[0].content.parts[0].text;
    const parsedRecipe = cleanAndParseJSON(rawText);

    parsedRecipe.image = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    parsedRecipe.id = Date.now().toString();
    return parsedRecipe;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
