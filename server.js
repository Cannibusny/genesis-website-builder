import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Cache-friendly static middleware: HTML responses are no-cache, everything else gets a long max-age.
app.use(
  express.static(__dirname, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html') || filePath.endsWith('/sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);

// ----- Theme palettes (passed into the model so generated sites pick a coherent palette) -----
const THEMES = {
  obsidian: {
    name: 'Obsidian Aurora',
    description:
      'Dark, premium aesthetic. Black/charcoal canvas with neon violet (#7c5cff) and electric cyan (#22d3ee) accents. Aurora-gradient hero backgrounds, soft glow on CTAs.',
  },
  porcelain: {
    name: 'Porcelain Lux',
    description:
      'Light, editorial luxury. Ivory canvas (#f8f5ef) with warm bronze (#a87b3f) and deep charcoal text. Generous whitespace, large serifs (Playfair-style) for headings, sans for body.',
  },
  cannabis: {
    name: 'Cannabis Heritage',
    description:
      'Earthy, premium dispensary. Deep forest green (#0f3d2e), muted gold (#c9a85b), warm cream (#f4ecd8). Botanical illustration vibe, leaf accents in CSS-only.',
  },
  default: {
    name: 'Studio Default',
    description:
      'Modern, professional palette appropriate for the business type. Use harmonious colors and clean type pairings.',
  },
};

function getTheme(themeKey) {
  return THEMES[themeKey] || THEMES.default;
}

// ----- Detect cannabis / dispensary / CBD context -----
function isCannabisBusiness(businessType = '', description = '') {
  const haystack = `${businessType} ${description}`.toLowerCase();
  return /\b(cannabis|dispensar|marijuana|hemp|cbd|thc|kratom)\b/.test(haystack);
}

// ----- System prompt builder -----
function buildSystemPrompt({ theme, variantHint, compliance, analytics, businessType, description }) {
  const cannabis = compliance?.ageGate || isCannabisBusiness(businessType, description);
  const themePalette = getTheme(theme);

  return `You are a senior product designer at a top-tier digital studio (Stripe / Apple / Linear caliber). You generate complete, single-file HTML websites that look and feel like billion-dollar brand sites.

# OUTPUT FORMAT
Return ONLY the raw HTML document, starting with <!DOCTYPE html>. NO markdown fences. NO commentary. NO explanations before or after.

# DESIGN SYSTEM
Palette: ${themePalette.name}
${themePalette.description}

Type: pair a strong display family with a clean text family (use system font stacks; do NOT load external fonts unless they are free Google Fonts via <link rel="preconnect" href="https://fonts.googleapis.com">).
Spacing: generous (8/12/16/24/32/48/64/96/128px scale).
Radii: 8–16px for cards/buttons, 999px for pills.
Shadow: soft elevation only (no harsh box shadows).

# REQUIRED STRUCTURE
1. <head> with: charset, viewport, **descriptive <title>** (≤60 chars), **<meta name="description">** (140–160 chars), Open Graph + Twitter card meta, <link rel="canonical">, **JSON-LD schema.org/${cannabis ? 'Store' : 'LocalBusiness'}** with name/address/description/url placeholder.
2. Sticky semi-transparent <header> with logo wordmark + nav.
3. Hero section with: gradient mesh / aurora background (CSS conic-gradient or radial-gradient mix), display headline, supporting subhead, primary + secondary CTA. The background must feel modern and dimensional (Stripe-style).
4. "About" / story section with two-column layout on desktop, stacked on mobile.
5. "Services" or "Products" section with 3–6 cards. Each card has a subtle hover lift + glow + reveal animation.
6. "Why us" / trust section with 3–4 trust badges or statistic counters.
7. "Testimonials" social-proof section with 2–3 quotes (made up but plausible; first names + city only).
8. "FAQ" section with 4–6 collapsible questions using <details>/<summary>.
9. Contact section: address, hours, contact form (non-functional UI — labelled inputs, accessible).
10. <footer> with: business name, copyright, location, three placeholder social icon links (use inline SVG or emoji), tiny legal links.

# INTERACTIONS (all vanilla JS, no libs)
- Smooth scroll-triggered reveal on every section using IntersectionObserver. Add a \`.reveal\` class, toggle \`.is-visible\` on intersect. Stagger child reveals by 60–120ms.
- Header transparency-to-solid on scroll past 24px.
- Cards: hover translates -2px and reveals a subtle radial glow.
- Buttons: pressed scale 0.98, focus ring, animated underline on text links.
- FAQ: native <details> with custom marker.
- All animations respect \`prefers-reduced-motion: reduce\` (disable transitions, transform: none).

# PERFORMANCE
- No external fonts unless absolutely necessary.
- All CSS in a single <style> in <head>. All JS in a single <script defer> at end of <body>.
- No external images (use CSS gradients, inline SVG, emoji).
- Add <link rel="preconnect"> for any third-party origin you reference.
- Add lazy="loading" to any <img> tags you include.

# ACCESSIBILITY
- Semantic landmarks (<header>, <nav>, <main>, <section>, <footer>).
- aria-labels on icon-only links, form labels associated to inputs.
- Color contrast WCAG AA minimum on text.
- Focus styles visible.

# SEO
- Title: "<Business Name> | <Short Promise> | <City>"
- Meta description: includes business name + city + main offering.
- One <h1>, then logical <h2>/<h3>.
- JSON-LD as described above.
- Sensible internal anchor links (#about, #services, #contact).

# RESPONSIVENESS
- Mobile-first. Breakpoints at 640px and 1024px.
- Hero is comfortable at 360px width. No horizontal scroll.

${
  cannabis
    ? `# CANNABIS / DISPENSARY COMPLIANCE (REQUIRED)
- Render a full-screen age-verification modal as the FIRST element inside <body>. It must block interaction until the user clicks "I am ${
        compliance?.minAge || 21
      } or older". Provide a "Leave site" link too. Persist consent in sessionStorage (key: \`age_verified\`).
- IMPORTANT: Include a visible <footer> element containing a <p class="footer-disclaimer"> with EXACTLY this text (copy it verbatim): "These products have not been evaluated by the FDA. Not intended to diagnose, treat, cure, or prevent any disease. Keep out of reach of children. For use only by adults ${
        compliance?.minAge || 21
      } and older.${compliance?.state ? ' Licensed in ' + compliance.state + '.' : ''}${
        compliance?.licenseNumber ? ' License #' + compliance.licenseNumber + '.' : ''
      }"
- IMPORTANT: The footer disclaimer above is MANDATORY. It must appear word-for-word in a visible paragraph inside the footer.
- Do NOT make medical claims anywhere. Use language like "may support" / "designed for" / "crafted for" instead of "cures" / "treats".
- Avoid imagery / language that targets minors.
- If state is provided (${compliance?.state || 'unspecified'}) and shipping is mentioned, note "where legal" near any commerce CTAs.\n`
    : ''
}
${
  analytics?.ga4 || analytics?.metaPixel
    ? `# ANALYTICS PLACEHOLDERS
Leave a comment <!-- ANALYTICS_INJECTION_POINT --> immediately before </head>. The server will inject GA4/Meta Pixel snippets there. Do NOT add your own tracking code.\n`
    : ''
}
${variantHint ? `# VARIANT GUIDANCE\n${variantHint}\n` : ''}

# QUALITY BAR
Treat this as a launch-day production site for a brand competing with the best. Every section should feel deliberate, every interaction smooth, every word on-brand for the business described.

Begin output now with <!DOCTYPE html>.`;
}

// ----- Variant hints (used when generating multiple variants for A/B comparison) -----
const VARIANT_HINTS = [
  'Variant A — "Bold & Editorial": oversized display type, asymmetric hero, statement headline that leads with a benefit. Primary CTA is the focal point.',
  'Variant B — "Minimal & Trust-First": calmer hero, social proof / trust badges immediately below the fold, conversion-optimized form copy. Lead with credibility.',
  'Variant C — "Story-Driven": narrative hero (problem → promise → resolution), longer copy, founder voice. Lead with empathy.',
];

// ----- Strip markdown fences if model wrapped output -----
function stripCodeFences(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return trimmed;
}

// ----- Inject GA4 + Meta Pixel snippets into generated HTML -----
function injectAnalytics(html, analytics) {
  if (!html || !analytics) return html;
  const snippets = [];
  if (analytics.ga4 && /^G-[A-Z0-9]{4,}$/i.test(analytics.ga4)) {
    snippets.push(
      `<!-- Google Analytics 4 -->\n<script async src="https://www.googletagmanager.com/gtag/js?id=${analytics.ga4}"></script>\n<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${analytics.ga4}');</script>`
    );
  }
  if (analytics.metaPixel && /^\d{6,}$/.test(analytics.metaPixel)) {
    snippets.push(
      `<!-- Meta Pixel -->\n<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${analytics.metaPixel}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${analytics.metaPixel}&ev=PageView&noscript=1"/></noscript>`
    );
  }
  if (!snippets.length) return html;

  // Prefer the explicit injection point if present, else fallback to </head>.
  const block = '\n' + snippets.join('\n') + '\n';
  if (html.includes('<!-- ANALYTICS_INJECTION_POINT -->')) {
    return html.replace('<!-- ANALYTICS_INJECTION_POINT -->', block);
  }
  return html.replace('</head>', block + '</head>');
}

// ----- Simple regex-based SEO scorer (no DOM parser, fast) -----
function scoreSeo(html) {
  if (!html) return { score: 0, checks: [], recommendations: ['No HTML provided'] };
  const checks = [];

  const addCheck = (label, passed, weight, recommendation) => {
    checks.push({ label, passed, weight, recommendation: passed ? null : recommendation });
  };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].trim() : '';
  addCheck(
    'Title tag (10–60 chars)',
    titleText.length >= 10 && titleText.length <= 60,
    10,
    `Title is ${titleText.length} chars; aim for 50–60 characters with the brand + city + value prop.`
  );

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const descText = descMatch ? descMatch[1].trim() : '';
  addCheck(
    'Meta description (140–160 chars)',
    descText.length >= 100 && descText.length <= 200,
    10,
    `Meta description is ${descText.length} chars; aim for 140–160 with a clear call to action.`
  );

  addCheck(
    'Canonical link',
    /<link[^>]+rel=["']canonical["']/i.test(html),
    5,
    'Add <link rel="canonical" href="https://your-domain.com/"> to prevent duplicate-content indexing.'
  );

  addCheck(
    'Open Graph tags',
    /<meta[^>]+property=["']og:title["']/i.test(html) && /<meta[^>]+property=["']og:description["']/i.test(html),
    7,
    'Add og:title, og:description, og:image, og:url for better social previews.'
  );

  addCheck(
    'Twitter card meta',
    /<meta[^>]+name=["']twitter:card["']/i.test(html),
    3,
    'Add <meta name="twitter:card" content="summary_large_image"> for richer X/Twitter shares.'
  );

  const h1Count = (html.match(/<h1\b/gi) || []).length;
  addCheck(
    'Exactly one <h1>',
    h1Count === 1,
    10,
    h1Count === 0
      ? 'No <h1> found — every page needs exactly one primary heading.'
      : `Found ${h1Count} <h1> tags — keep only the most important one.`
  );

  addCheck(
    'Has <h2> structure',
    /<h2\b/i.test(html),
    5,
    'Use <h2> headings to break the page into logical scannable sections.'
  );

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const imgsWithAlt = imgTags.filter(t => /\salt=/i.test(t)).length;
  const altCoverage = imgTags.length === 0 ? 1 : imgsWithAlt / imgTags.length;
  addCheck(
    'Image alt coverage',
    altCoverage === 1,
    7,
    imgTags.length === 0
      ? 'No <img> tags found (using CSS/emoji). Skip if intentional.'
      : `${imgsWithAlt}/${imgTags.length} <img> tags have alt text. Add descriptive alt to all.`
  );

  addCheck(
    'JSON-LD structured data',
    /application\/ld\+json/i.test(html),
    10,
    'Embed a JSON-LD schema.org/LocalBusiness or Store block in <head> for rich search results.'
  );

  addCheck(
    'Viewport meta',
    /<meta[^>]+name=["']viewport["'][^>]*content=["'][^"']*width=device-width/i.test(html),
    8,
    'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for mobile rendering.'
  );

  addCheck(
    'lang on <html>',
    /<html\b[^>]*\blang=/i.test(html),
    3,
    'Add lang="en" (or appropriate locale) to <html> for accessibility and SEO.'
  );

  addCheck(
    'Sitemap-friendly anchors',
    /href=["']#(about|services|products|contact|menu|faq)/i.test(html),
    3,
    'Add semantic in-page anchors (#about, #services, #contact) for better navigation.'
  );

  addCheck(
    'No render-blocking external CSS',
    !/<link[^>]+rel=["']stylesheet["'][^>]+href=["']http/i.test(html),
    5,
    'Inline critical CSS and avoid external stylesheet <link> tags to keep first paint fast.'
  );

  addCheck(
    'Defers main script',
    !/<script\b[^>]*src=/i.test(html) || /<script\b[^>]*\bdefer\b/i.test(html),
    4,
    'Use <script defer> for non-critical JS so it does not block parsing.'
  );

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const score = Math.round((earned / totalWeight) * 100);

  const recommendations = checks.filter(c => !c.passed && c.recommendation).map(c => c.recommendation);

  return {
    score,
    grade: score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F',
    checks: checks.map(({ recommendation, ...rest }) => rest),
    recommendations,
  };
}

// ----- Generate a single variant -----
async function generateOne(client, opts) {
  const { businessType, businessName, location, description, theme, compliance, analytics, variantHint } = opts;

  const systemPrompt = buildSystemPrompt({
    theme,
    variantHint,
    compliance,
    analytics,
    businessType,
    description,
  });

  const userPrompt = `Create a production-grade marketing website for:

Business Type: ${businessType}
Business Name: ${businessName}
Location: ${location}
Description: ${description}
${compliance?.licenseNumber ? `License Number: ${compliance.licenseNumber}\n` : ''}${compliance?.state ? `Operating State: ${compliance.state}\n` : ''}${compliance?.minAge ? `Minimum Age: ${compliance.minAge}\n` : ''}
Build the entire single-file HTML now.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 12000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  let html = stripCodeFences(textBlock ? textBlock.text : '');
  html = injectAnalytics(html, analytics);
  const seo = scoreSeo(html);

  return { html, seo, variantHint: variantHint || null };
}

// ----- /api/generate: supports variantCount, theme, compliance, analytics -----
app.post('/api/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      businessType,
      businessName,
      location,
      description,
      theme,
      variantCount,
      compliance,
      analytics,
    } = body;

    if (!businessName || !businessType || !location || !description) {
      return res
        .status(400)
        .json({ success: false, error: 'businessName, businessType, location, description are required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
    }

    const client = new Anthropic({ apiKey });
    const count = Math.max(1, Math.min(3, parseInt(variantCount, 10) || 1));

    // If only one variant, no variant hint. If multiple, pass the variant prompts.
    const variants = await Promise.all(
      Array.from({ length: count }).map((_, i) =>
        generateOne(client, {
          businessType,
          businessName,
          location,
          description,
          theme,
          compliance,
          analytics,
          variantHint: count > 1 ? VARIANT_HINTS[i] : null,
        })
      )
    );

    // Back-compat: top-level html / seo from variant 0
    res.json({
      success: true,
      html: variants[0].html,
      seo: variants[0].seo,
      variants,
      theme: theme || 'default',
      meta: {
        count,
        cannabis: isCannabisBusiness(businessType, description) || !!compliance?.ageGate,
        analyticsInjected: !!(analytics?.ga4 || analytics?.metaPixel),
      },
    });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----- Standalone SEO scoring endpoint -----
app.post('/api/seo-score', (req, res) => {
  try {
    const { html } = req.body || {};
    if (!html) return res.status(400).json({ success: false, error: 'html is required' });
    res.json({ success: true, ...scoreSeo(html) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'genesis-website-builder', version: '2.0.0' });
});

app.listen(PORT, () => {
  console.log(`GENESIS Website Builder v2 running on port ${PORT}`);
});
