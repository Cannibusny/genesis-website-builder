import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Railway / proxies — trust the first hop so req.ip resolves to the real client IP.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ----- Shared password gate -----
// Set BUILDER_PASSWORD env var to enable. If unset, the gate is OFF (open access).
const BUILDER_PASSWORD = process.env.BUILDER_PASSWORD || '';
const COOKIE_NAME = 'genesis_auth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function authToken(password) {
  return crypto.createHash('sha256').update(`genesis::${password}`).digest('hex');
}
const VALID_TOKEN = BUILDER_PASSWORD ? authToken(BUILDER_PASSWORD) : '';

function isAuthed(req) {
  if (!BUILDER_PASSWORD) return true;
  return req.cookies && req.cookies[COOKIE_NAME] === VALID_TOKEN;
}

// Public endpoints (no auth required): health + the login POST itself.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'genesis-website-builder',
    version: '2.2.0',
    passwordGate: !!BUILDER_PASSWORD,
  });
});

app.post('/api/login', (req, res) => {
  if (!BUILDER_PASSWORD) {
    return res.json({ success: true, gateEnabled: false });
  }
  const { password } = req.body || {};
  if (!password || password !== BUILDER_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Incorrect password' });
  }
  res.cookie(COOKIE_NAME, VALID_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: COOKIE_MAX_AGE_MS,
  });
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

// Gate everything else (UI + APIs).
app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  // For API calls, respond with 401 JSON.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, error: 'Authentication required', authRequired: true });
  }
  // For static / UI requests, serve the login page.
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(path.join(__dirname, 'login.html'));
  }
  return res.status(401).send('Authentication required');
});

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

// ----- Per-IP rate limit for the expensive generate endpoint -----
const GENERATE_LIMIT_PER_HOUR = parseInt(process.env.GENERATE_LIMIT_PER_HOUR || '5', 10);
const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: GENERATE_LIMIT_PER_HOUR,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    success: false,
    error: `Rate limit reached (${GENERATE_LIMIT_PER_HOUR} generations per hour per IP). Try again later.`,
    rateLimited: true,
  },
});

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

// ----- Per-industry design rules (injected into system prompt for sharper, on-brand output) -----
function getIndustryRules(businessType = '', description = '') {
  const haystack = `${businessType} ${description}`.toLowerCase();
  if (/\b(cannabis|dispensar|marijuana|hemp|cbd|thc)\b/.test(haystack)) {
    return `INDUSTRY: Cannabis / dispensary.
- Palette: earth tones — deep forest green (#0f3d2e), muted gold (#c9a85b), warm cream (#f4ecd8), charcoal text.
- Visuals: organic, botanical, premium craft vibe. Inline SVG leaf accents OK. NO consumption imagery, NO appeals to minors.
- Sections to include: Product categories (Flower / Pre-rolls / Edibles / Vapes / Concentrates / Topicals as relevant), "Visit Us" with hours + address prominently, an Education / responsible-use section, FAQ that covers ID requirements and what to expect on first visit.
- Tone: knowledgeable, welcoming, adult-focused. Avoid stoner clichés.
- Trust signals: license number, state agency mention, lab-tested badges, locally sourced where applicable.`;
  }
  if (/\b(cafe|coffee|espresso|roastery|roaster|bakery)\b/.test(haystack)) {
    return `INDUSTRY: Coffee shop / cafe.
- Palette: warm browns (#3a2a1a), cream (#f5ecd9), rust orange (#c2562a) or terracotta, soft greens for accents.
- Visuals: artisanal, cozy, community. Coffee bean / steam / cup motifs via inline SVG or emoji.
- Sections to include: Menu (espresso / pour-over / pastries with prices), origin / sourcing story, hours + location, community / events, loyalty or rewards CTA in the hero or footer.
- Tone: warm, neighborly, craft-forward.
- Trust signals: locally roasted, fair-trade where applicable, neighborhood ties.`;
  }
  if (/\b(trading\s*card|tcg|magic|pokemon|yu-?gi-?oh|hobby\s*shop|games?\s*store)\b/.test(haystack)) {
    return `INDUSTRY: Trading card game / hobby store.
- Palette: bold primaries (red #d92626, royal blue #1f3fb5, gold #f7c948) on a dark canvas (#0d0f17) — gaming aesthetic. OR daylight comic-shop palette if description leans family-friendly.
- Visuals: card-grid layouts, event/tournament photos vibe, energy and motion.
- Sections to include: Featured singles / sealed product grid, tournament & league calendar (use plausible weekly events), Buy / Sell / Trade explainer, community / Discord-style CTA, FAQ on grading and pricing.
- Tone: enthusiast-to-enthusiast, knowledgeable, welcoming to new players.
- Trust signals: years in business, judge-certified staff, secure trade policies.`;
  }
  if (/\b(agency|marketing|consultant|consulting|seo|ppc|growth|branding)\b/.test(haystack)) {
    return `INDUSTRY: Marketing / consulting agency.
- Palette: confident professional — deep navy (#0b1d3a) + teal accent (#14b8a6) OR creative palette (deep purple #4c1d95 + warm orange #f97316). Crisp white or near-black backgrounds.
- Visuals: data viz suggestions (CSS bars / sparklines), case-study cards, large client logos block (placeholder wordmarks OK).
- Sections to include: Services breakdown with outcomes ("+X% revenue", "Y month payback"), 2–3 case studies with metric callouts, methodology / process, leadership team mini-bios, CTA for a free strategy call.
- Tone: confident, outcome-driven, no fluff.
- Trust signals: named brands worked with (placeholders), measurable results, methodology framework name.`;
  }
  if (/\b(restaurant|bistro|kitchen|eatery|grill|pizz|sushi|ramen|taco|burger)\b/.test(haystack)) {
    return `INDUSTRY: Restaurant.
- Palette: warm, appetite-stimulating — deep red, charcoal, cream OR seasonal palette tuned to cuisine.
- Sections: Signature dishes, menu highlights with prices, chef / story, reservations CTA prominent in hero AND nav, hours + location, private events.
- Trust signals: years open, chef credentials, press mentions, reservation platform mentioned.`;
  }
  if (/\b(gym|fitness|crossfit|yoga|pilates|studio|trainer|boxing)\b/.test(haystack)) {
    return `INDUSTRY: Fitness studio / gym.
- Palette: high-energy — electric red/orange + black, OR calm wellness palette (sage + cream + charcoal) depending on description.
- Sections: Class schedule grid, trainers / coaches, intro offer CTA, transformation testimonials, FAQ on first class.
- Trust signals: certifications, member count, before/after framing (no body shaming).`;
  }
  if (/\b(law|attorney|firm|legal|counsel)\b/.test(haystack)) {
    return `INDUSTRY: Law firm.
- Palette: navy + cream + brass accents OR muted charcoal + deep green. Serif headlines, generous whitespace.
- Sections: Practice areas grid, attorney bios with credentials, case results disclaimer, free consultation CTA, FAQ.
- Trust signals: bar admissions, years practicing, peer recognition, confidentiality assurance.`;
  }
  if (/\b(real\s*estate|realtor|broker|realty)\b/.test(haystack)) {
    return `INDUSTRY: Real estate.
- Palette: sophisticated — deep navy or charcoal + warm white + gold accent.
- Sections: Featured listings grid (use plausible placeholder property cards), neighborhood guides, buyer vs seller paths, agent bio, home valuation CTA.
- Trust signals: years in market, transaction volume, MLS / brokerage affiliation.`;
  }
  if (/\b(saas|tech|startup|software|platform|api|developer)\b/.test(haystack)) {
    return `INDUSTRY: SaaS / tech startup.
- Palette: gradient mesh hero (purple / cyan or magenta / orange), dark or light mode equally valid.
- Sections: Hero with product value prop + screenshot/illustration placeholder (CSS-only), feature grid with icons (inline SVG), pricing 3-tier table, customer logo bar, integrations or API mention, signup CTA prominent.
- Trust signals: customer logos, security/compliance badges (SOC2, GDPR — only if mentioned), uptime stat.`;
  }
  if (/\b(salon|spa|barber|wellness|beauty|nails)\b/.test(haystack)) {
    return `INDUSTRY: Salon / spa.
- Palette: editorial luxury — porcelain ivory + bronze/rose + deep charcoal text.
- Sections: Service menu with pricing, stylists / therapists with photos placeholder, booking CTA, gift cards.
- Trust signals: years in business, signature treatments, certifications.`;
  }
  if (/\b(boutique|retail|shop|store)\b/.test(haystack)) {
    return `INDUSTRY: Boutique / retail.
- Palette: editorial — neutral canvas + one bold accent tuned to the description.
- Sections: Collection / category grid, featured products, brand story, in-store experience, hours + location.
- Trust signals: years open, locally owned, curated selection.`;
  }
  return `INDUSTRY: ${businessType}.
- Choose a palette appropriate for the audience described.
- Include sections that match the dominant business goal (sell product, book service, generate leads, or inform).
- Trust signals appropriate to the category (longevity, certifications, results, press, community ties).`;
}

// ----- System prompt builder -----
function buildSystemPrompt({
  theme,
  variantHint,
  compliance,
  analytics,
  businessType,
  description,
  conversion,
  refinementInstructions,
}) {
  const cannabis = compliance?.ageGate || isCannabisBusiness(businessType, description);
  const themePalette = getTheme(theme);
  const industryRules = getIndustryRules(businessType, description);

  return `You are a senior product designer at a top-tier digital studio (Stripe / Apple / Linear caliber). You generate complete, single-file HTML websites that look and feel like billion-dollar brand sites.

# OUTPUT FORMAT
Return ONLY the raw HTML document, starting with <!DOCTYPE html>. NO markdown fences. NO commentary. NO explanations before or after.

# INDUSTRY RULES (REQUIRED — follow these strictly)
${industryRules}

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
  analytics?.ga4 || analytics?.metaPixel || analytics?.hotjar
    ? `# ANALYTICS PLACEHOLDERS
Leave a comment <!-- ANALYTICS_INJECTION_POINT --> immediately before </head>. The server will inject GA4 / Meta Pixel / Hotjar snippets there. Do NOT add your own tracking code.\n`
    : ''
}
${
  conversion?.exitIntent
    ? `# EXIT-INTENT EMAIL CAPTURE (REQUIRED)
Include a hidden popup with id="exit-popup" at the end of <body>. Trigger it on the first \`mouseleave\` where \`event.clientY < 0\` after the user has been on the page > 8 seconds, only once per session (sessionStorage key \`exit_seen\`). Copy: headline "Before you go —", body offers a discount or value-add appropriate to the business, single email input, "Get it" submit button (form has \`onsubmit="return false"\` so it does not actually submit), and a small "No thanks" close link. Style consistent with the rest of the site. Suppress on touch devices.\n`
    : ''
}
${
  conversion?.abHeadline
    ? `# A/B HEADLINE TEST (REQUIRED)
Inside the hero, render BOTH headline variants like this:
  <div id="headline-test" data-ab="headline">
    <h1 class="variant-a" hidden><!-- benefit-led version --></h1>
    <h1 class="variant-b" hidden><!-- trust-led version --></h1>
  </div>
Add a small inline script that picks a stable variant from \`localStorage.getItem('ab_headline')\` (assign 'a' or 'b' on first visit), reveals the chosen one, and pushes a \`gtag('event','ab_headline',{variant})\` if \`window.gtag\` exists.\n`
    : ''
}
${
  conversion?.chatbot
    ? `# CHATBOT FRAMEWORK PLACEHOLDER (REQUIRED)
Add a floating chat button bottom-right with id="chat-toggle" that opens a panel #chat-panel containing a transcript area and an input. Wire the send button to call \`window.GENESIS_CHATBOT?.send(message)\` if defined, otherwise show "Chatbot not configured yet — add your Anthropic key in chatbot-config.js to enable." Include the framework script inline:
  <script>
  window.GENESIS_CHATBOT = window.GENESIS_CHATBOT || {
    apiKey: '', // owner: paste your Anthropic API key here to enable
    model: 'claude-sonnet-4-5-20250929',
    systemPrompt: "You are a helpful assistant for THIS_BUSINESS_NAME. Answer concisely.",
    async send(msg) { /* implementation provided by owner */ }
  };
  </script>
Do NOT include any real API key.\n`
    : ''
}
${variantHint ? `# VARIANT GUIDANCE\n${variantHint}\n` : ''}
${
  refinementInstructions
    ? `# REFINEMENT INSTRUCTIONS (apply on top of the design system, not replacing it)
${refinementInstructions}\n`
    : ''
}

# QUALITY BAR
Treat this as a launch-day production site for a brand competing with the best. Every section should feel deliberate, every interaction smooth, every word on-brand for the business described.

Begin output now with <!DOCTYPE html>.`;
}

// ----- Variant hints (used when generating multiple variants for A/B comparison) -----
const VARIANT_PROFILES = [
  {
    key: 'professional',
    label: 'Professional',
    description: 'Conservative, trust-focused, established. Best for partners who want to convey reliability.',
    hint: 'VARIANT — PROFESSIONAL:\n- Tone: authoritative, established, dependable. Lead with credibility and proof.\n- Palette: deep navy or charcoal + soft cream/ivory + a single muted accent. Avoid neon or playful colors.\n- Typography: refined serif headlines (system serif stack) paired with crisp sans-serif body. Generous line height.\n- Layout: traditional grid, clear hierarchy, symmetric hero. Trust badges and credentials immediately below the hero.\n- CTA: "Get a Consultation" / "Schedule a Call" / "Learn More" — measured language.',
  },
  {
    key: 'modern',
    label: 'Modern',
    description: 'Bold, contemporary, dynamic. Best for partners chasing energy and momentum.',
    hint: 'VARIANT — MODERN:\n- Tone: innovative, energetic, forward-thinking. Lead with a sharp benefit.\n- Palette: high-contrast — a bold primary (electric blue, hot magenta, or vivid orange) on near-black or pure white. Use the gradient mesh aggressively.\n- Typography: modern sans-serif throughout, oversized display headline (clamp from 2.5rem to 5rem). Tight letter-spacing on display.\n- Layout: asymmetric hero, scroll-driven reveals more pronounced, larger cards with strong hover lifts.\n- CTA: "Start Now" / "Try It Free" / "Get Started" — action-led.',
  },
  {
    key: 'premium',
    label: 'Premium',
    description: 'Luxury positioning, elegant, aspirational. Best for partners with a high-end audience.',
    hint: 'VARIANT — PREMIUM:\n- Tone: exclusive, refined, aspirational. Lead with craft and curation.\n- Palette: black or deep charcoal canvas + cream (#f4ecd8) + muted gold (#c9a85b) accents. NO neon. Subtle shimmer on gold.\n- Typography: elegant serif throughout (system serif stack), generous whitespace, restrained color use.\n- Layout: minimalist, spacious. Single editorial hero photograph (via CSS gradient placeholder), large body type, generous section padding.\n- CTA: "Reserve" / "Inquire" / "Request Access" — invitation, not transaction.',
  },
];
const VARIANT_HINTS = VARIANT_PROFILES.map(p => p.hint);

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
  if (analytics.hotjar && /^\d{6,}$/.test(analytics.hotjar)) {
    snippets.push(
      `<!-- Hotjar -->\n<script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:${analytics.hotjar},hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');</script>`
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
  const {
    businessType,
    businessName,
    location,
    description,
    theme,
    compliance,
    analytics,
    variantHint,
    conversion,
    refinementInstructions,
    sourceHtml,
  } = opts;

  const systemPrompt = buildSystemPrompt({
    theme,
    variantHint,
    compliance,
    analytics,
    businessType,
    description,
    conversion,
    refinementInstructions,
  });

  const userPrompt = sourceHtml
    ? `Refine this existing website with the requested instructions in the system prompt. Preserve structure and brand voice, but apply the refinements faithfully. Return the COMPLETE refined HTML.

Business Type: ${businessType}
Business Name: ${businessName}
Location: ${location}
Description: ${description}
${compliance?.licenseNumber ? `License Number: ${compliance.licenseNumber}\n` : ''}${compliance?.state ? `Operating State: ${compliance.state}\n` : ''}${compliance?.minAge ? `Minimum Age: ${compliance.minAge}\n` : ''}
--- CURRENT HTML ---
${sourceHtml}
--- END CURRENT HTML ---
Return the COMPLETE refined HTML now.`
    : `Create a production-grade marketing website for:

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
app.post('/api/generate', generateLimiter, async (req, res) => {
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
    const conversion = body.conversion || {};

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
          conversion,
          variantHint: count > 1 ? VARIANT_HINTS[i] : null,
        }).then(result => ({
          ...result,
          profile: count > 1 ? VARIANT_PROFILES[i] : null,
        }))
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
        analyticsInjected: !!(analytics?.ga4 || analytics?.metaPixel || analytics?.hotjar),
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

// ----- Available variant profiles (so the UI can label tabs Professional / Modern / Premium) -----
app.get('/api/variants', (req, res) => {
  res.json({
    success: true,
    variants: VARIANT_PROFILES.map(({ key, label, description }) => ({ key, label, description })),
  });
});

// ----- AI Suggestions: analyze the description and surface 3 actionable improvements -----
app.post('/api/suggest', generateLimiter, async (req, res) => {
  try {
    const { description = '', businessType = '', location = '' } = req.body || {};
    if (description.trim().length < 30) {
      return res.json({ success: true, suggestions: [] });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
    }
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 600,
      system:
        'You are a senior conversion-copy strategist. Read a business description and return EXACTLY 3 short, actionable suggestions (1–2 sentences each) to make the resulting marketing website more effective — each suggestion must reference something concrete in the description (audience, offer, location, differentiator) and explain the website implication. Return ONLY a JSON array of 3 strings. No prose, no markdown, no keys.',
      messages: [
        {
          role: 'user',
          content: `Business type: ${businessType}\nLocation: ${location}\nDescription: """${description}"""\n\nReturn JSON array now.`,
        },
      ],
    });
    const text = (response.content.find(b => b.type === 'text')?.text || '').trim();
    let suggestions = [];
    try {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start >= 0 && end > start) {
        suggestions = JSON.parse(text.slice(start, end + 1));
      }
    } catch {
      suggestions = [];
    }
    if (!Array.isArray(suggestions)) suggestions = [];
    suggestions = suggestions.filter(s => typeof s === 'string' && s.trim().length > 0).slice(0, 3);
    res.json({ success: true, suggestions });
  } catch (error) {
    console.error('Suggest error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----- AI Refinement: take an existing HTML + a set of refinement options, regenerate -----
const REFINEMENT_INSTRUCTIONS = {
  toneProfessional: 'Make the overall tone more professional and authoritative. Tighten copy. Replace casual phrases with industry-confident language.',
  toneCasual: 'Make the tone friendlier and more conversational. Use contractions, second person, warmer micro-copy.',
  toneUrgent: 'Make CTAs and headlines more action-oriented and urgency-driven (without manipulative pressure). Use stronger verbs.',
  toneLuxury: 'Elevate the tone to premium / luxurious. Slow the pacing of copy, use more elegant phrasing, restrain exclamation.',
  copyShorten: 'Shorten every section’s prose by ~30%. Convert long paragraphs to crisp bullet points where appropriate. Keep meaning.',
  copyExpand: 'Expand the copy with more concrete detail — specific benefits, audience nouns, sensory or technical language.',
  copyLocalSEO: 'Add local SEO depth: weave the city + state into headlines, subheads, the JSON-LD schema, and section copy. Reference nearby neighborhoods or landmarks plausibly.',
  copyEmphasizeOffer: 'Emphasize the headline product or service throughout: it should appear in the hero headline, the meta description, and the primary CTA.',
  designBolder: 'Make the colors bolder and the contrast higher. Increase headline weight and size. More saturated accent color.',
  designSofter: 'Soften the palette and tone down contrast. Use more whitespace, calmer accent color, lighter type weights.',
  designMoreWhitespace: 'Increase whitespace and section padding by ~30%. Reduce density of cards / grids.',
  designRicher: 'Add more visual richness — additional gradient layers, more card variations, subtle decorative SVG elements.',
};
const REFINEMENT_KEYS = Object.keys(REFINEMENT_INSTRUCTIONS);

app.post('/api/refine', generateLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const {
      businessType,
      businessName,
      location,
      description,
      theme,
      compliance,
      analytics,
      conversion,
      sourceHtml,
      refinements,
      customInstruction,
      variantHint,
    } = body;
    if (!businessName || !businessType || !location || !description) {
      return res.status(400).json({ success: false, error: 'businessName, businessType, location, description are required' });
    }
    if (!sourceHtml || typeof sourceHtml !== 'string' || sourceHtml.length < 200) {
      return res.status(400).json({ success: false, error: 'sourceHtml is required (generate first, then refine)' });
    }
    const selectedKeys = Array.isArray(refinements) ? refinements.filter(k => REFINEMENT_KEYS.includes(k)) : [];
    const lines = selectedKeys.map(k => `- ${REFINEMENT_INSTRUCTIONS[k]}`);
    if (customInstruction && typeof customInstruction === 'string' && customInstruction.trim().length > 0) {
      lines.push(`- ${customInstruction.trim().slice(0, 600)}`);
    }
    if (!lines.length) {
      return res.status(400).json({ success: false, error: 'Pick at least one refinement or provide a customInstruction.' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
    const client = new Anthropic({ apiKey });

    const result = await generateOne(client, {
      businessType,
      businessName,
      location,
      description,
      theme,
      compliance,
      analytics,
      conversion: conversion || {},
      variantHint: variantHint || null,
      refinementInstructions: lines.join('\n'),
      sourceHtml,
    });

    res.json({
      success: true,
      html: result.html,
      seo: result.seo,
      applied: selectedKeys,
      customInstruction: customInstruction || null,
    });
  } catch (error) {
    console.error('Refine error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(
    `GENESIS Website Builder v2.2 running on port ${PORT} (password gate ${
      BUILDER_PASSWORD ? 'ON' : 'OFF'
    }, generate limit ${GENERATE_LIMIT_PER_HOUR}/hr per IP)`
  );
});
