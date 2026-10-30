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
// INTELLIGENT YOUTUBE RECIPE PARSER
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
    let currentSection = 'ingredients'; // Default assumption for video descriptions

    for (const line of lines) {
        const lower = String(line || '').toLowerCase();
        
        // Detect section headers
        if (lower.includes('ingredient') || lower.includes('what you need') || lower.includes('shopping')) {
            currentSection = 'ingredients';
            continue;
        } else if (lower.includes('instruction') || lower.includes('direction') || lower.includes('method') || lower.includes('step') || lower.includes('how to')) {
            currentSection = 'instructions';
            continue;
        }

        // Skip social media links or irrelevant promo text
        if (lower.includes('http://') || lower.includes('https://') || lower.includes('instagram') || lower.includes('facebook') || lower.includes('subscribe')) {
            continue;
        }

        if (currentSection === 'ingredients') {
            ingredients.push({ amount: "", unit: "", name: line });
        } else {
            instructions.push(line);
        }
    }

    // Fallback if no sections were cleanly separated
    if (ingredients.length === 0) {
        ingredients = lines.slice(0, Math.min(lines.length, 8)).map(l => ({ amount: "", unit: "", name: l }));
    }
    if (instructions.length === 0) {
        instructions = lines.slice(Math.min(lines.length, 8));
    }

    return {
        id: Date.now().toString(),
        title,
        author,
        category: "YouTube",
        prepTime: "15 mins",
        cookTime: "20 mins",
        defaultServings: 4,
        ingredients,
        instructions,
        image
    };
}

// ==========================================
// INTELLIGENT WEB RECIPE PARSER
// ==========================================
async function parseStandardWebRecipe(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    
    const $ = cheerio.load(response.data);
    
    const title = $('meta[property="og:title"]').attr('content') || $('title').text() || "Web Recipe";
    const author = $('meta[name="author"]').attr('content') || $('[rel="author"]').text() || "Blog Author";
    const image = $('meta[property="og:image"]').attr('content') || "";

    let ingredients = [];
    
    // Comprehensive selectors targeting common recipe card plugins (WP Recipe Maker, Tasty Recipes, Recipe Card Blocks, etc.)
    const ingredientSelectors = [
        '.wprm-recipe-ingredient',
        '.tasty-recipes-ingredients li',
        '.saberecipe-ingredient',
        '[itemprop="recipeIngredient"]',
        'li.ingredient',
        '.recipe-ingredients li'
    ];

    for (const selector of ingredientSelectors) {
        $(selector).each((i, el) => {
            const amount = $(el).find('.wprm-recipe-ingredient-amount, .tasty-recipes-ingredient-amount').text().trim() || "";
            const unit = $(el).find('.wprm-recipe-ingredient-unit, .tasty-recipes-ingredient-unit').text().trim() || "";
            const name = $(el).find('.wprm-recipe-ingredient-name, .tasty-recipes-ingredient-name').text().trim() || $(el).text().trim();

            if (name && !ingredients.some(ing => ing.name === name)) {
                ingredients.push({ amount, unit, name });
            }
        });
        if (ingredients.length > 0) break;
    }

    // Generic fallback if specific plugin selectors missed items
    if (ingredients.length === 0) {
        $('ul li, ol li').each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 3 && text.length < 100 && (/\d/.test(text) || text.toLowerCase().includes('cup') || text.toLowerCase().includes('tbsp') || text.toLowerCase().includes('tsp'))) {
                ingredients.push({ amount: "", unit: "", name: text });
            }
        });
    }

    let instructions = [];
    const instructionSelectors = [
        '.wprm-recipe-instruction',
        '.tasty-recipes-instructions li',
        '[itemprop="recipeInstructions"] li',
        '[itemprop="recipeInstructions"]',
        '.recipe-instructions li'
    ];

    for (const selector of instructionSelectors) {
        $(selector).each((i, el) => {
            const text = $(el).text().trim();
            if (text && !instructions.includes(text)) {
                instructions.push(text);
            }
        });
        if (instructions.length > 0) break;
    }

    return {
        id: Date.now().toString(),
        title,
        author: typeof author === 'string' ? author.trim() : "Blog Author",
        category: "Main Course",
        prepTime: $('[itemprop="prepTime"]').attr('content') || "15 mins",
        cookTime: $('[itemprop="cookTime"]').attr('content') || "20 mins",
        defaultServings: parseInt($('[itemprop="recipeYield"]').text()) || 4,
        ingredients: ingredients.length > 0 ? ingredients : [{ amount: "", unit: "", name: "Visit original website for ingredients" }],
        instructions: instructions.length > 0 ? instructions : ["Visit original website for instructions"],
        image
    };
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
