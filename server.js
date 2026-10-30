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

        const finalOutput = Array.isArray(parsedData) ? parsedData : [parsedData];
        return res.json(finalOutput);

    } catch (error) {
        console.error("Backend Parsing Error:", error);
        return res.status(500).json({ error: error.message || "Failed to parse recipe" });
    }
});

// ==========================================
// SMART TITLE CLEANER
// ==========================================
function cleanRecipeTitle(rawTitle) {
    if (!rawTitle) return "Imported Recipe";
    
    let clean = String(rawTitle)
        .replace(/^(how to (make|get|cook|bake|prepare))\s+(those|the|best|easy|perfect)?\s*/i, '')
        .replace(/^(the\s+)?(best|ultimate|easy|quick|classic)\s+/i, '')
        .split('|')[0]
        .split('-')[0]
        .trim();

    if (!clean || clean.length < 3) {
        clean = String(rawTitle).split('|')[0].trim();
    }

    return clean;
}

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
    const rawTitle = $('meta[property="og:title"]').attr('content') || "YouTube Recipe";
    const title = cleanRecipeTitle(rawTitle);
    
    const author = $('meta[property="og:video:actor"], meta[name="author"]').attr('content') || "YouTube Creator";
    const description = $('meta[property="og:description"]').attr('content') || "";
    const image = $('meta[property="og:image"]').attr('content') || "";

    const lines = description ? description.split('\n').map(line => line ? line.trim() : '').filter(line => line.length > 0) : [];
    
    let ingredients = [];
    let instructions = [];
    let currentSection = 'ingredients';

    for (const line of lines) {
        const lower = String(line || '').toLowerCase(); // SAFEGUARDED
        
        if (lower.includes('ingredient') || lower.includes('what you need') || lower.includes('shopping')) {
            currentSection = 'ingredients';
            continue;
        } else if (lower.includes('instruction') || lower.includes('direction') || lower.includes('method') || lower.includes('step') || lower.includes('how to')) {
            currentSection = 'instructions';
            continue;
        }

        if (lower.includes('http://') || lower.includes('https://') || lower.includes('instagram') || lower.includes('facebook') || lower.includes('subscribe')) {
            continue;
        }

        if (currentSection === 'ingredients') {
            ingredients.push({ amount: "", unit: "", name: line });
        } else {
            instructions.push(line);
        }
    }

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
// INTELLIGENT WEB RECIPE PARSER (MULTI-RECIPE SUPPORT)
// ==========================================
async function parseStandardWebRecipe(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    
    const $ = cheerio.load(response.data);
    
    const recipeContainers = $('.wprm-recipe, .tasty-recipes, [itemtype*="Recipe"]');

    if (recipeContainers.length > 1) {
        let multiRecipes = [];
        recipeContainers.each((index, container) => {
            const $el = $(container);
            const rawTitle = $el.find('.wprm-recipe-name, .tasty-recipes-title, [itemprop="name"]').first().text() || `Recipe ${index + 1}`;
            const title = cleanRecipeTitle(rawTitle);
            const image = $el.find('img').first().attr('src') || $('meta[property="og:image"]').attr('content') || "";

            let ingredients = [];
            $el.find('.wprm-recipe-ingredient, .tasty-recipes-ingredients li, [itemprop="recipeIngredient"]').each((i, ingEl) => {
                const amount = $(ingEl).find('.wprm-recipe-ingredient-amount, .tasty-recipes-ingredient-amount').text().trim() || "";
                const unit = $(ingEl).find('.wprm-recipe-ingredient-unit, .tasty-recipes-ingredient-unit').text().trim() || "";
                const name = $(ingEl).find('.wprm-recipe-ingredient-name, .tasty-recipes-ingredient-name').text().trim() || $(ingEl).text().trim();
                if (name) ingredients.push({ amount, unit, name });
            });

            let instructions = [];
            $el.find('.wprm-recipe-instruction, .tasty-recipes-instructions li, [itemprop="recipeInstructions"]').each((i, instEl) => {
                const text = $(instEl).text().trim();
                if (text) instructions.push(text);
            });

            multiRecipes.push({
                id: (Date.now() + index).toString(),
                title,
                author: "Blog Author",
                category: "Main Course",
                prepTime: "15 mins",
                cookTime: "20 mins",
                defaultServings: 4,
                ingredients: ingredients.length > 0 ? ingredients : [{ amount: "", unit: "", name: "See website" }],
                instructions: instructions.length > 0 ? instructions : ["See website"],
                image
            });
        });

        if (multiRecipes.length > 0) {
            return multiRecipes;
        }
    }

    const rawTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || "Web Recipe";
    const title = cleanRecipeTitle(rawTitle);
    const author = $('meta[name="author"]').attr('content') || $('[rel="author"]').text() || "Blog Author";
    const image = $('meta[property="og:image"]').attr('content') || "";

    let ingredients = [];
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

    if (ingredients.length === 0) {
        $('ul li, ol li').each((i, el) => {
            const rawText = $(el).text();
            const text = rawText ? rawText.trim() : "";
            const lowerText = String(text).toLowerCase(); // SAFEGUARDED
            if (text.length > 3 && text.length < 100 && (/\d/.test(text) || lowerText.includes('cup') || lowerText.includes('tbsp') || lowerText.includes('tsp'))) {
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
],
        instructions: instructions.length > 0 ? instructions : ["Visit original website for instructions"],
        image
    };
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
