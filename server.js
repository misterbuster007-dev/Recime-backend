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
        let recipes = [];

        if (isYouTubeUrl(inputUrl)) {
            recipes = await parseYouTubeRecipes(inputUrl);
        } else {
            recipes = await parseUniversalWebRecipes(inputUrl);
        }

        // BACKWARD COMPATIBILITY: 
        // If it's just one recipe, send a single object so your installed APK handles it perfectly.
        // If it's multiple recipes (like a roundup), send the array.
        if (Array.isArray(recipes) && recipes.length === 1) {
            res.json(recipes[0]);
        } else {
            res.json(recipes);
        }

    } catch (error) {
        console.error("Universal Parsing Error:", error.message);
        res.status(500).json({ error: "Could not parse recipe from URL: " + error.message });
    }
});

async function parseUniversalWebRecipes(url) {
    let pageTitle = "Recipe Collection";
    let pageImage = "";
    let rawBodyText = "";

    try {
        const response = await fetch(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const html = await response.text();
        const $ = cheerio.load(html);

        pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || $('h1').first().text();
        pageImage = $('meta[property="og:image"]').attr('content') || "";
        
        let textChunks = [];
        $('p, li, h2, h3').each((_, el) => {
            const t = $(el).text().trim();
            if (t.length > 0) textChunks.push(t);
        });
        rawBodyText = textChunks.join('\n');
    } catch (e) {
        console.log("Web fetch warning:", e.message);
    }

    if (!rawBodyText || rawBodyText.length < 100) {
        rawBodyText = `Please extract all recipes from this URL: ${url}`;
    }

    const prompt = `You are an expert culinary recipe parser and professional chef. 
    Source URL: ${url}
    Page Title: "${pageTitle}"
    Extracted Page Content: 
    ${rawBodyText.slice(0, 18000)}

    Task:
    Extract ALL recipes found in the provided text above. If this is a single recipe page, return an array with 1 recipe object inside it. If this is a meal plan or roundup, extract every individual recipe into the array. Each recipe must include its exact title, author, category, prep/cook time, servings, ingredients (with amounts, units, categories), and step-by-step instructions. Never return empty fields.

    Return strictly valid JSON as a JSON array of objects with no markdown formatting around it: 
    [
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
      }
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
    const parsedRecipes = cleanAndParseJSON(rawText);

    const recipeArray = Array.isArray(parsedRecipes) ? parsedRecipes : [parsedRecipes];
    recipeArray.forEach((recipe, index) => {
        if (pageImage && !recipe.image) {
            recipe.image = pageImage;
        }
        recipe.id = (Date.now() + index).toString();
    });

    return recipeArray;
}

async function parseYouTubeRecipes(url) {
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
    Extract the recipe featured in this video. Return it as a JSON array containing 1 recipe object.

    Return strictly valid JSON as an array of objects with no markdown formatting around it: 
    [
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
      }
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
    const parsedRecipes = cleanAndParseJSON(rawText);

    const recipeArray = Array.isArray(parsedRecipes) ? parsedRecipes : [parsedRecipes];
    recipeArray.forEach((recipe, index) => {
        recipe.image = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
        recipe.id = (Date.now() + index).toString();
    });

    return recipeArray;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
