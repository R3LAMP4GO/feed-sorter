// IIFE mirror of src/analysis/post-analysis.js for content scripts.
// Mirrors `scoreFormats`, `FORMAT_LABELS`, and `FORMAT_SIGNALS` only — the
// LLM-driven `analyzePost` path stays in the ESM module (it's only called via
// the llm-bridge from contexts that have ESM available).
//
// Keep in lock-step with src/analysis/post-analysis.js. Tests for the ESM
// version cover both: the runtime is a near-verbatim transliteration.
//
// Exposes globalThis.__fsPostAnalysis = { scoreFormats, FORMAT_LABELS,
//                                          FORMAT_SIGNALS, topFormat }.

(function (root) {
  const FORMAT_LABELS = [
    "talking_head", "story", "skit", "educational", "listicle", "tutorial",
    "reaction", "pov", "hottake", "tip", "dayinlife", "beforeafter", "explainer",
  ];

  const transcriptText = (post) => {
    const segs = Array.isArray(post && post.transcriptSegments) ? post.transcriptSegments : null;
    if (segs && segs.length) {
      return segs.map((s) => String((s && s.text) || "")).join(" ");
    }
    return String((post && post.transcript) || "");
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
    const desc = String((post && post.desc) || "");
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
    const hasDuration = Number.isFinite(post && post.durationSec);
    const dur = hasDuration ? Number(post.durationSec) : null;
    const audioObj = post && typeof post.audio === "object" ? post.audio : null;
    const audioIsOriginal = audioObj
      ? audioObj.isOriginal === true
      : !!(post && post.audioIsOriginal);
    const audioUseCount = audioObj && Number.isFinite(audioObj.useCount) ? audioObj.useCount : 0;
    const audioIsLicensedMusic = audioObj ? audioObj.isOriginal === false : false;
    const audioIsTrending = audioObj
      ? (audioObj.isOriginal === false && audioUseCount >= 1000)
      : !!(post && post.audioIsTrending);
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
    const trimmed = String((post && post.desc) || "").trim();
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
    let best = "other", bestVal = 0;
    for (const k of Object.keys(scores)) {
      if (scores[k] > bestVal) { best = k; bestVal = scores[k]; }
    }
    return bestVal > 0 ? best : "other";
  }

  root.__fsPostAnalysis = { scoreFormats, FORMAT_SIGNALS, FORMAT_LABELS, topFormat };
})(typeof globalThis !== "undefined" ? globalThis : self);
