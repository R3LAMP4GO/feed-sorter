// IIFE mirror of src/analysis/post-analysis.js for content scripts.
// Mirrors cheap rule-based helpers. The LLM-driven `analyzePost` path stays in
// the ESM module (it's only called via the llm-bridge from contexts that have
// ESM available).
//
// Keep in lock-step with src/analysis/post-analysis.js. Tests for the ESM
// version cover both: the runtime is a near-verbatim transliteration.
//
// Exposes globalThis.__fsPostAnalysis = { scoreFormats, FORMAT_LABELS,
//   FORMAT_SIGNALS, topFormat, CATEGORY_LABELS, classifyCategory,
//   classifyForCsv, buildClassificationText }.

((root) => {
  const FORMAT_LABELS = [
    "talking_head", "story", "skit", "educational", "listicle", "tutorial",
    "reaction", "pov", "hottake", "tip", "dayinlife", "beforeafter", "explainer",
  ];

  const transcriptText = (post) => {
    const segs = Array.isArray(post?.transcriptSegments) ? post.transcriptSegments : null;
    if (segs?.length) {
      return segs.map((s) => String((s?.text) || "")).join(" ");
    }
    return String((post?.transcript) || "");
  };

  const buildClassificationText = (post) => {
    const title = String((post && (post.title || post.name)) || "").trim();
    const desc = String((post?.desc) || "").trim();
    const transcript = transcriptText(post).trim();
    const authorCategory = String((post && (post.authorCategory || post.creatorCategory || post.categoryName)) || "").trim();
    const authorBio = String((post && (post.authorBio || post.bio)) || "").trim();
    return [title, desc, transcript, authorCategory, authorBio].filter(Boolean).join("\n\n");
  };

  const countMatches = (s, re) => {
    const m = s.match(re);
    return m ? m.length : 0;
  };

  const hashtagsOf = (s) => {
    const out = new Set();
    const re = /#([a-z0-9_]+)/gi;
    let m;
    while ((m = re.exec(String(s || ""))) !== null) {
      out.add(m[1].toLowerCase());
    }
    return out;
  };

  function FORMAT_SIGNALS(post) {
    const desc = String((post?.desc) || "");
    const lower = desc.toLowerCase();
    const trimmed = desc.trim();
    const transcript = transcriptText(post).toLowerCase();
    const tags = hashtagsOf(desc);
    const wordCount = trimmed ? trimmed.split(/\s+/).filter(Boolean).length : 0;
    const captionNoTags = lower.replace(/#[a-z0-9_]+/g, " ");
    const firstPerson = countMatches(captionNoTags, /\b(i|i['’]m|i['’]ve|i['’]ll|me|my|mine|we|our)\b/g);
    const pastTense = countMatches(captionNoTags, /\b(was|were|had|did|went|came|told|said|tried|started|stopped|got|made|thought|felt|realized|learned)\b/g);
    const lines = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bulletLines = lines.filter((l) => /^([-•]|\d+[.)]?)\s*\S/.test(l));
    const numerals = countMatches(lower, /\b(\d+)\s+(things|reasons|ways|tips|signs|steps|mistakes|lessons|rules|secrets|hacks|facts|myths)\b/g);
    const hasListStart = /^\d+[.)\s]/.test(trimmed);
    const hasPovPrefix = /^(pov|p\.o\.v\.?)\s*:/i.test(trimmed);
    const hasStoryHashtag = tags.has("storytime") || tags.has("story") || tags.has("mystory");
    const hasPovHashtag = tags.has("pov");
    const hasTutorialHashtag = tags.has("tutorial") || tags.has("howto");
    const hasDuration = Number.isFinite(post?.durationSec);
    const dur = hasDuration ? Number(post.durationSec) : null;
    const audioObj = post && typeof post.audio === "object" ? post.audio : null;
    const audioIsOriginal = audioObj
      ? audioObj.isOriginal === true
      : !!(post?.audioIsOriginal);
    const audioUseCount = audioObj && Number.isFinite(audioObj.useCount) ? audioObj.useCount : 0;
    const audioIsLicensedMusic = audioObj ? audioObj.isOriginal === false : false;
    const audioIsTrending = audioObj
      ? (audioObj.isOriginal === false && audioUseCount >= 1000)
      : !!(post?.audioIsTrending);
    const isDuet = !!(post && (post.isDuet || post.isStitch || post.parentPostId));
    const transcriptWords = transcript ? transcript.split(/\s+/).filter(Boolean).length : 0;
    const transcriptFirstPerson = transcript ? countMatches(transcript, /\b(i|i['’]m|i['’]ve|me|my|we)\b/g) : 0;
    const transcriptPastRatio = transcriptWords ? pastTense / Math.max(1, transcriptWords) : 0;

    return {
      caption_word_count: wordCount,
      caption_first_person: firstPerson,
      caption_past_tense: pastTense,
      bullet_lines: bulletLines.length,
      listicle_numerals: numerals,
      has_list_start: hasListStart,
      has_pov_prefix: hasPovPrefix,
      has_story_hashtag: hasStoryHashtag,
      has_pov_hashtag: hasPovHashtag,
      has_tutorial_hashtag: hasTutorialHashtag,
      has_duration: hasDuration,
      duration_sec: dur,
      audio_is_trending: audioIsTrending,
      audio_is_original: audioIsOriginal,
      audio_is_licensed_music: audioIsLicensedMusic,
      audio_use_count: audioUseCount,
      is_duet_or_stitch: isDuet,
      transcript_words: transcriptWords,
      transcript_first_person: transcriptFirstPerson,
      transcript_past_ratio: transcriptPastRatio,
      hashtags: Array.from(tags),
      lower,
      transcript,
    };
  }

  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const addScore = (acc, label, delta) => {
    if (!delta) return;
    acc[label] = clamp01((acc[label] || 0) + delta);
  };

  function scoreFormats(post) {
    const sig = FORMAT_SIGNALS(post);
    const lower = sig.lower;
    const trimmed = String((post?.desc) || "").trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const tx = sig.transcript;
    const out = {};

    if (sig.has_list_start) addScore(out, "listicle", 0.55);
    if (sig.bullet_lines >= 3) addScore(out, "listicle", 0.35);
    if (sig.bullet_lines >= 5) addScore(out, "listicle", 0.15);
    if (sig.listicle_numerals >= 1) addScore(out, "listicle", 0.45);
    if (/\btop\s*\d+\b/.test(lower)) addScore(out, "listicle", 0.30);

    if (/\bhow to\b/.test(lower)) addScore(out, "tutorial", 0.55);
    if (/\bstep\s*1\b/.test(lower) || /\bstep\s*one\b/.test(lower)) addScore(out, "tutorial", 0.45);
    if (/\btutorial\b/.test(lower) || /\bguide\b/.test(lower)) addScore(out, "tutorial", 0.35);
    if (sig.has_tutorial_hashtag) addScore(out, "tutorial", 0.30);
    if (tx && (/\bstep\s*1\b/.test(tx) || /\bstep\s*one\b/.test(tx))) addScore(out, "tutorial", 0.20);

    if (/\bbefore\b/.test(lower) && /\bafter\b/.test(lower)) addScore(out, "beforeafter", 0.65);
    if (/\btransformation\b/.test(lower)) addScore(out, "beforeafter", 0.40);
    if (/\b(\d+)\s*(day|week|month|year)s?\s+(later|transformation|results)\b/.test(lower)) addScore(out, "beforeafter", 0.45);

    if (/\bday in (my |the )?life\b/.test(lower)) addScore(out, "dayinlife", 0.75);
    if (/\bmorning routine\b/.test(lower) || /\bnight routine\b/.test(lower)) addScore(out, "dayinlife", 0.70);
    if (/\b(\d+)\s*am\s+routine\b/.test(lower)) addScore(out, "dayinlife", 0.50);
    if (/\bdaily routine\b/.test(lower)) addScore(out, "dayinlife", 0.45);

    if (/\breact(ing|ion)?\b/.test(lower)) addScore(out, "reaction", 0.55);
    if (/\bmy thoughts on\b/.test(lower)) addScore(out, "reaction", 0.45);
    if (/\bnot me\s+\w+ing\b/.test(lower)) addScore(out, "reaction", 0.35);
    if (sig.is_duet_or_stitch) addScore(out, "reaction", 0.45);

    if (/\bunpopular opinion\b/.test(lower)) addScore(out, "hottake", 0.80);
    if (/\bhot take\b/.test(lower)) addScore(out, "hottake", 0.75);
    if (/i['’]ll say it\b/.test(lower)) addScore(out, "hottake", 0.75);
    if (/\bcontroversial\b/.test(lower)) addScore(out, "hottake", 0.45);
    if (/\bnobody (is )?talk(s|ing) about\b/.test(lower)) addScore(out, "hottake", 0.30);

    if (/\btip:\s/.test(lower)) addScore(out, "tip", 0.55);
    if (/\bpro tip\b/.test(lower) || /\bquick tip\b/.test(lower)) addScore(out, "tip", 0.55);
    if (/^if you\s+\S+/.test(lowerTrimmed)) addScore(out, "tip", 0.30);

    if (sig.has_pov_prefix) addScore(out, "pov", 0.85);
    if (sig.has_pov_hashtag) addScore(out, "pov", 0.40);

    if (sig.caption_first_person >= 5 && sig.caption_word_count >= 40) addScore(out, "story", 0.55);
    else if (sig.caption_first_person >= 3 && sig.caption_word_count >= 25) addScore(out, "story", 0.35);
    else if (sig.caption_first_person >= 2 && sig.caption_word_count >= 12) addScore(out, "story", 0.20);
    if (sig.caption_past_tense >= 3) addScore(out, "story", 0.20);
    if (sig.caption_past_tense >= 5) addScore(out, "story", 0.15);
    if (sig.caption_word_count >= 80 && sig.caption_first_person >= 3) addScore(out, "story", 0.20);
    if (sig.has_story_hashtag) addScore(out, "story", 0.30);
    if (/\bstory\s*time\b/.test(lower)) addScore(out, "story", 0.30);
    if (/\b(when i was|so i|last (week|month|year|night)|a few (years|months|weeks) ago)\b/.test(lower)) addScore(out, "story", 0.30);
    if (sig.transcript_words >= 20 && sig.transcript_past_ratio >= 0.04) addScore(out, "story", 0.15);
    if (out.listicle && out.listicle >= 0.55 && out.story) {
      out.story = clamp01(out.story * 0.5);
    }
    if (out.hottake && out.hottake >= 0.55 && out.story) {
      out.story = clamp01(out.story * 0.5);
    }

    if (/\bhere['’]s why\b/.test(lower) || /\bthe (real )?reason\b/.test(lower)) addScore(out, "educational", 0.50);
    if (/\bthe truth about\b/.test(lower)) addScore(out, "educational", 0.45);
    if (/\bsave (this|for later)\b/.test(lower)) addScore(out, "educational", 0.30);
    if (/\bdid you know\b/.test(lower)) addScore(out, "educational", 0.40);
    if (/\bmost people (don'?t|dont) (know|realize)\b/.test(lower)) addScore(out, "educational", 0.45);
    if (/\b(why|how|what)\s+\w+\s+(works?|matters?|fails?)\b/.test(lower)) addScore(out, "educational", 0.35);
    if (out.tutorial && out.tutorial >= 0.5) addScore(out, "educational", 0.25);
    if (/\b(macros?|protein|hypertroph|deficit|hormones?|interest rate|inflation|algorithm|api|database)\b/.test(lower)) addScore(out, "educational", 0.20);

    if (out.educational) addScore(out, "talking_head", out.educational * 0.7);
    if (out.tip) addScore(out, "talking_head", out.tip * 0.5);
    if (out.hottake) addScore(out, "talking_head", out.hottake * 0.4);
    if (sig.has_duration && sig.duration_sec >= 25 && sig.duration_sec <= 90) addScore(out, "talking_head", 0.25);
    if (sig.audio_is_original) addScore(out, "talking_head", 0.10);
    if (/\b(let me explain|listen|hear me out|i['’]m gonna tell you|the real answer)\b/.test(lower)) addScore(out, "talking_head", 0.30);

    if (sig.audio_is_trending) addScore(out, "skit", 0.40);
    else if (sig.audio_is_licensed_music) addScore(out, "skit", 0.20);
    if (sig.has_duration && sig.duration_sec <= 20 && (sig.audio_is_trending || !sig.audio_is_original)) addScore(out, "skit", 0.25);
    if (/\bwait (for it|till the end)\b/.test(lower)) addScore(out, "skit", 0.30);
    if (/\bme:\s|\bhim:\s|\bher:\s|\bthem:\s/.test(lower)) addScore(out, "skit", 0.40);
    if (/\bwhen (you|your|he|she|they)\b/.test(lower) && sig.caption_word_count <= 20) addScore(out, "skit", 0.25);
    if (out.educational && /\bme:\s|\bcoach:\s|\bclient:\s|\bfriend:\s/.test(lower)) addScore(out, "skit", 0.30);
    if (out.educational && /\b(plot twist|but actually|here['’]s the catch)\b/.test(lower)) addScore(out, "skit", 0.25);

    if (out.educational && out.tutorial) addScore(out, "explainer", clamp01(out.educational * out.tutorial));
    if (/\bexplained\b/.test(lower)) addScore(out, "explainer", 0.45);
    if (/\bin (\d+) (seconds|minutes)\b/.test(lower)) addScore(out, "explainer", 0.30);

    if (sig.caption_word_count <= 2) {
      for (const k of Object.keys(out)) {
        out[k] = Math.min(out[k], 0.55);
      }
    }
    const noAudioInfo = !sig.audio_is_trending && !sig.audio_is_original && !sig.is_duet_or_stitch;
    if (sig.caption_word_count === 0 && noAudioInfo) {
      for (const k of Object.keys(out)) out[k] = Math.min(out[k], 0.4);
    }

    for (const k of Object.keys(out)) {
      if (out[k] < 0.15) delete out[k];
    }
    return out;
  }

  function topFormat(post) {
    const scores = scoreFormats(post);
    let best = "other";
    let bestVal = 0;
    for (const k of Object.keys(scores)) {
      if (scores[k] > bestVal) { best = k; bestVal = scores[k]; }
    }
    return bestVal > 0 ? best : "other";
  }

  const CATEGORY_LABELS = [
    "business", "finance", "fitness", "beauty", "real-estate", "ai-tools",
    "marketing", "food", "travel", "parenting", "education", "entertainment",
    "other",
  ];

  const CATEGORY_RULES = Object.freeze({
    business: [
      /\b(startup|founder|entrepreneur|business|company|companies|ceo|operator|operations|sales|revenue|profit|pricing|offer|client|customers?|leadership|management|hiring|agency|consulting|b2b|saas|ecommerce|shopify)\b/g,
      /#(startup|founder|entrepreneur|business|businesstips|smallbusiness|sales|saas|ecommerce)\b/g,
    ],
    finance: [
      /\b(money|invest(?:ing|ment|or)?|stocks?|crypto|bitcoin|portfolio|dividend|etf|fund|trading|wealth|retirement|401k|ira|tax(?:es)?|budget|saving|debt|credit score|mortgage|interest rate|inflation|apr|cash flow|net worth)\b/g,
      /#(finance|investing|money|stocks|crypto|wealth|personalfinance|financialfreedom)\b/g,
    ],
    fitness: [
      /\b(fitness|workout|training|train|gym|lift(?:ing)?|strength|hypertroph|muscle|glutes?|abs|cardio|running|marathon|protein|macros?|calories|calorie deficit|cutting|bulking|meal prep|nutrition|diet|mobility|pilates|yoga|coach)\b/g,
      /#(fitness|gym|workout|bodybuilding|nutrition|protein|macros|running|pilates|yoga|fitnesstips)\b/g,
    ],
    beauty: [
      /\b(beauty|makeup|skincare|skin care|haircare|hair|nails?|lash(?:es)?|brows?|cosmetic|cosmetics|foundation|concealer|mascara|lipstick|serum|retinol|spf|sunscreen|acne|glow up|grwm|outfit|fashion|style)\b/g,
      /#(beauty|makeup|skincare|haircare|nails|grwm|fashion|style|ootd)\b/g,
    ],
    "real-estate": [
      /\b(real estate|realtor|property|properties|listing|listings|home buyer|homebuyer|seller|open house|mortgage|escrow|closing costs?|house hack|airbnb|rental|rentals?|landlord|tenant|zillow|housing market|commercial real estate|cre)\b/g,
      /#(realestate|realtor|property|homebuyer|listingagent|investor|airbnb|rentalproperty)\b/g,
    ],
    "ai-tools": [
      /\b(ai|a\.i\.|artificial intelligence|chatgpt|gpt-?4|claude|gemini|midjourney|runway|elevenlabs|prompt|prompts|prompting|automation|agent|agents|llm|ollama|machine learning|no-code ai|ai tool|ai tools)\b/g,
      /#(ai|aitools|chatgpt|claude|gemini|midjourney|promptengineering|automation|llm)\b/g,
    ],
    marketing: [
      /\b(marketing|content strategy|content creation|creator|brand|branding|copywriting|hook|hooks|funnel|landing page|email list|newsletter|seo|ads?|paid media|meta ads|google ads|ugc|influencer|viral|algorithm|growth|social media|tiktok shop|lead magnet)\b/g,
      /#(marketing|contentmarketing|branding|copywriting|seo|socialmedia|growth|creator|viraltips)\b/g,
    ],
    food: [
      /\b(recipe|cook(?:ing)?|bake|baking|meal|dish|dinner|lunch|breakfast|restaurant|chef|kitchen|ingredients?|sauce|pasta|tacos?|coffee|cocktail|protein bowl|air fryer|foodie)\b/g,
      /#(food|recipe|cooking|baking|foodie|mealprep|dinner|restaurant|coffee)\b/g,
    ],
    travel: [
      /\b(travel|trip|flight|hotel|airbnb|resort|vacation|itinerary|passport|visa|airport|destination|beach|city guide|things to do|solo travel|backpacking|cruise|tourist)\b/g,
      /#(travel|traveltips|vacation|hotel|flight|itinerary|solotravel|bucketlist)\b/g,
    ],
    parenting: [
      /\b(parent(?:ing)?|mom|dad|motherhood|fatherhood|toddler|baby|newborn|pregnancy|postpartum|kids?|children|school run|homeschool|gentle parenting|tantrum|daycare|nap time|family)\b/g,
      /#(parenting|momlife|dadlife|motherhood|fatherhood|toddler|baby|family)\b/g,
    ],
    education: [
      /\b(learn|lesson|study|student|teacher|school|college|university|course|classroom|homework|exam|quiz|tutorial|explained|how it works|science|history|math|language learning|books?|reading|research)\b/g,
      /#(education|learn|study|student|teacher|school|science|history|books)\b/g,
    ],
    entertainment: [
      /\b(comedy|funny|meme|skit|prank|pov|storytime|dance|music|song|movie|film|tv show|netflix|celebrity|reaction|reacting|gaming|gameplay|streamer|anime|trailer)\b/g,
      /#(comedy|funny|meme|skit|pov|dance|music|movies|gaming|anime|entertainment)\b/g,
    ],
  });

  const CATEGORY_TIEBREAK = CATEGORY_LABELS.filter((label) => label !== "other");

  const normalizeCategoryText = (post) => {
    const text = buildClassificationText(post);
    const hashtags = Array.isArray(post?.hashtags) ? post.hashtags.map((h) => `#${String(h).replace(/^#/, "")}`).join(" ") : "";
    const platformCategory = String((post && (post.category || post.topicCategory || post.authorCategory || post.creatorCategory)) || "");
    return [text, hashtags, platformCategory].filter(Boolean).join("\n").toLowerCase();
  };

  const scoreCategoryText = (text) => {
    const scores = {};
    for (const label of CATEGORY_TIEBREAK) {
      let total = 0;
      for (const re of CATEGORY_RULES[label] || []) {
        re.lastIndex = 0;
        total += countMatches(text, re);
      }
      if (total > 0) {
        scores[label] = clamp01(0.25 + Math.min(total, 7) * 0.1);
      }
    }
    return scores;
  };

  function classifyCategory(post) {
    const text = normalizeCategoryText(post);
    const scores = scoreCategoryText(text);
    let best = "other";
    let confidence = 0;
    for (const label of CATEGORY_TIEBREAK) {
      const score = scores[label] || 0;
      if (score > confidence) {
        best = label;
        confidence = score;
      }
    }
    if (confidence <= 0) {
      return { category: "other", confidence: 0, scores };
    }
    return { category: best, confidence: clamp01(confidence), scores };
  }

  const VISUAL_FORMATS = new Set(["talking-head", "info-card", "split-screen", "product", "b-roll"]);

  const csvContentFormat = (post) => {
    const scores = scoreFormats(post);
    let best = "other";
    let confidence = 0;
    for (const label of Object.keys(scores)) {
      if (scores[label] > confidence) {
        best = label;
        confidence = scores[label];
      }
    }
    return { contentFormat: best, formatConfidence: clamp01(confidence), formatScores: scores };
  };

  const normalizeNicheLabel = (value) => String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s&/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");

  function classifyForCsv(post, opts = {}) {
    const categoryResult = classifyCategory(post);
    const formatResult = csvContentFormat(post);
    const visualFormat = typeof (post?.visualFormat) === "string" && VISUAL_FORMATS.has(post.visualFormat)
      ? post.visualFormat
      : "";
    const contentFormat = formatResult.contentFormat;
    const primaryFormat = visualFormat || contentFormat || "other";
    const hasRuleCategory = categoryResult.category !== "other" && categoryResult.confidence > 0;
    const hasRuleFormat = contentFormat !== "other" && formatResult.formatConfidence > 0;
    const source = opts.source
      || (visualFormat && (hasRuleCategory || hasRuleFormat) ? "mixed" : "rules");
    const ai = post?.ai && typeof post.ai === "object" ? post.ai : null;
    const niche = normalizeNicheLabel(
      (post?.niche)
        || (ai && (ai.niche || ai.nicheLabel))
        || (hasRuleCategory ? categoryResult.category : "")
    );
    return {
      category: categoryResult.category,
      niche,
      contentFormat,
      visualFormat: visualFormat || (typeof (post?.visualFormat) === "string" ? post.visualFormat : ""),
      format: primaryFormat,
      categoryConfidence: categoryResult.confidence,
      formatConfidence: visualFormat ? Math.max(0.75, formatResult.formatConfidence) : formatResult.formatConfidence,
      classificationSource: source,
      classificationAt: Number.isFinite(opts.now) ? Number(opts.now) : Date.now(),
      categoryScores: categoryResult.scores,
      formatScores: formatResult.formatScores,
    };
  }

  root.__fsPostAnalysis = {
    scoreFormats,
    FORMAT_SIGNALS,
    FORMAT_LABELS,
    topFormat,
    CATEGORY_LABELS,
    classifyCategory,
    classifyForCsv,
    buildClassificationText,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
