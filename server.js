const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Health check route
app.get('/', (req, res) => {
    res.json({ status: "Recime Backend is running successfully!" });
});

// Recipe parsing endpoint
app.get('/parse-recipe', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) {
            return res.status(400).json({ error: "URL is required" });
        }

        console.log("Parsing recipe for URL:", targetUrl);

        let parsedData;

        // Route handling based on URL type
        if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
            parsedData = await parseYouTubeRecipe(targetUrl);
        } else {
            parsedData = await parseStandardWebRecipe(targetUrl);
        }

        // CRITICAL: Always normalize output into an array so multi-recipe 
        // roundups and single recipes both return a consistent format for the app
        const finalOutput = Array.isArray(parsedData) ? parsedData : [parsedData];

        return res.json(finalOutput);

    } catch (error) {
        console.error("Backend Parsing Error:", error);
        return res.status(500).json({ error: error.message || "Failed to parse recipe" });
    }
});

// ==========================================
// YOUTUBE RECIPE PARSER
// ==========================================
async function parseYouTubeRecipe(url) {
    try {
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

        const lines = description ? description.split('\n').map(line => line.trim()).filter(line => line.length > 0) : [];
        
        let ingredients = [];
        let instructions = [];
        let currentSection = 'general';

        for (const line of lines) {
            const lower = String(line).toLowerCase(); // Safeguarded to prevent undefined toLowerCase errors
            if (lower.includes('ingredient') || lower.includes('you will need')) {
                currentSection = 'ingredients';
                continue;
            } else if (lower.includes('instruction') || lower.includes('directions') || lower.includes('method') || lower.includes('steps')) {
                currentSection = 'instructions';
                continue;
            }

            if (currentSection === 'ingredients') {
                ingredients.push(line);
            } else if (currentSection === 'instructions') {
                instructions.push(line);
            }
        }

        if (ingredients.length === 0) {
            ingredients = lines.slice(0, Math.min(lines.length, 10));
        }
        if (instructions.length === 0) {
            instructions = lines.slice(Math.min(lines.length, 10));
        }

        return {
            id: Date.now().toString(),
            title: title,
            author: author,
            category: "YouTube",
            prepTime: "15 mins",
            cookTime: "20 mins",
            defaultServings: 4,
            ingredients: ingredients.length > 0 ? ingredients : ["Check video description for ingredients"],
            instructions: instructions.length > 0 ? instructions : ["Watch video for instructions"],
            image: image
        };

    } catch (error) {
        console.error("YouTube Parsing Error:", error);
        throw new Error("Could not extract recipe from YouTube URL.");
    }
}

// ==========================================
// STANDARD WEBSITE RECIPE PARSER
// ==========================================
async function parseStandardWebRecipe(url) {
    try {
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
        $('[class*="ingredient"], [itemprop="recipeIngredient"]').each((i, el) => {
            const text = $(el).text().trim();
            if (text) ingredients.push(text);
        });

        let instructions = [];
        $('[class*="instruction"], [class*="direction"], [itemprop="recipeInstructions"]').each((i, el) => {
            const text = $(el).text().trim();
            if (text) instructions.push(text);
        });

        return {
            id: Date.now().toString(),
            title: title,
            author: author,
            category: "Main Course",
            prepTime: "15 mins",
            cookTime: "20 mins",
            defaultServings: 4,
            ingredients: ingredients.length > 0 ? ingredients : ["Ingredient data not automatically formatted"],
            instructions: instructions.length > 0 ? instructions : ["Instruction data not automatically formatted"],
            image: image
        };

    } catch (error) {
        console.error("Web Scraping Error:", error);
        throw new Error("Could not scrape recipe from website.");
    }
}

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
