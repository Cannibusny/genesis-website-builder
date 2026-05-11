import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const SYSTEM_PROMPT = `You are a professional web designer specializing in creating modern, responsive business websites. 
Generate a complete, single-file HTML website based on the user's business information.

Requirements:
- Modern, clean design with CSS in a <style> tag
- Responsive layout that works on mobile and desktop
- Include sections: Hero, About, Services/Products, Contact
- Use the business name, type, location, and description provided
- Professional color scheme appropriate for the business type
- No external dependencies - pure HTML/CSS
- Include a contact form (non-functional, just UI)

Return ONLY the HTML code (no markdown, no explanations).`;

function stripCodeFences(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

app.post('/api/generate', async (req, res) => {
  try {
    const { businessType, businessName, location, description } = req.body;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
    }

    const client = new Anthropic({ apiKey });

    const userPrompt = `Create a professional website for:
Business Type: ${businessType}
Business Name: ${businessName}
Location: ${location}
Description: ${description}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const textBlock = response.content.find(block => block.type === 'text');
    const raw = textBlock ? textBlock.text : '';
    const html = stripCodeFences(raw);

    res.json({ success: true, html });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'genesis-website-builder' });
});

app.listen(PORT, () => {
  console.log(`GENESIS Website Builder running on port ${PORT}`);
});
