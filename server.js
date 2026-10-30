const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: "Recime Backend is running successfully!" });
});

app.get('/parse-recipe', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).json({ error: "URL is required" });
        }

        console.log("Parsing recipe for URL:", targetUrl);

        let parsedData;

        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
            parsedData = await parseYouTubeRecipe(targetUrl);
        } else {
            parsedData = await parseStandardWebRecipe(targetUrl);
        }

        return res.json(parsedData);

    } catch (error) {
        console.error("Backend Parsing Error:", error);
        return res.status(500).json({ error: error.message || "Failed to parse recipe" });
    }
});

// ==========================================
// YOUTUBE RECIPE PARSER
// ==========================================
async function parseYouTubeRecipe(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    
    const $ = cheerio.load(response.data);
    const title = $('meta[property="og:title"]').attr('content') || "YouTube Recipe";
    const author = $('meta[property="og:video:actor"], meta[name="author"]').attr('content') || "YouTube Creator";
    const description = $('meta[property="og:description"]').attr('content') || "";
    const image = $('meta[property="og:image"]').attr('content') || "";

    const lines = description ? description.split('\n').map(line => line ? line.trim() : '').filter(line => line.length > 0) : [];
    
    let ingredients = [];
    let instructions = [];
    let currentSection = 'general';

    for (const line of lines) {
        const lower = String(line || '').toLowerCase();
        if (lower.includes('ingredient') || lower.includes('you will need')) {
            currentSection = 'ingredients';
            continue;
        } else if (lower.includes('instruction') || lower.includes('directions') || lower.includes('method') || lower.includes('steps')) {
            currentSection = 'instructions';
            continue;
        }

        if (currentSection === 'ingredients') {
            ingredients.push({ amount: "", unit: "", name: line });
        } else if (currentSection === 'instructions') {
            instructions.push(line);
        }
    }

    if (ingredients.length === 0) {
        ingredients = lines.slice(0, Math.min(lines.length, 10)).map(l => ({ amount: "", unit: "", name: l }));
    }
    if (instructions.length === 0) {
        instructions = lines.slice(Math.min(lines.length, 10));
    }

    return {
        id: Date.now().toString(),
        title,
        author,
        category: "YouTube",
        prepTime: "15 mins",
        cookTime: "20 mins",
        defaultServings: 4,
        ingredients: ingredients.length > 0 ? ingredients : [{ amount: "", unit: "", name: "Check video description" }],
        instructions: instructions.length > 0 ? instructions : ["Watch video for instructions"],
        image
    };
}

// ==========================================
// STANDARD WEBSITE RECIPE PARSER
// ==========================================
async function parseStandardWebRecipe(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    
    const $ = cheerio.load(response.data);
    
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || "Web Recipe";
    const author = $('meta[name="author"]').attr('content') || "Blog Author";
    const image = $('meta[property="og:image"]').attr('content') || "";

    let ingredients = [];
    
    // Extract structured WPRM or microdata ingredients matching frontend expectations
    $('[class*="ingredient"], [itemprop="recipeIngredient"], .wprm-recipe-ingredient').each((i, el) => {
        const amount = $(el).find('.wprm-recipe-ingredient-amount').text().trim() || "";
        const unit = $(el).find('.wprm-recipe-ingredient-unit').text().trim() || "";
        const nameNode = $(el).find('.wprm-recipe-ingredient-name').text().trim();
        const fullName = nameNode || $(el).text().trim();

        if (fullName) {
            ingredients.push({
                amount: amount,
                unit: unit,
                name: fullName
            });
        }
    });

    let instructions = [];
    $('[class*="instruction"], [class*="direction"], [itemprop="recipeInstructions"], .wprm-recipe-instruction').each((i, el) => {
        const text = $(el).text();
        if (text) {
            const cleaned = text.trim();
            if (cleaned) instructions.push(cleaned);
        }
    });

    return {
        id: Date.now().toString(),
        title,
        author,
        category: "Main Course",
        prepTime: "15 mins",
        cookTime: "20 mins",
        defaultServings: 4,
        ingredients: ingredients.length > 0 ? ingredients : [{ amount: "", unit: "", name: "Visit original website for full ingredient list" }],
        instructions: instructions.length > 0 ? instructions : ["Visit original website for step-by-step instructions"],
        image
    };
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
