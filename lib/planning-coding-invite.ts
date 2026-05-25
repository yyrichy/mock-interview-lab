/**
 * Fallback when the planning model verbally releases the candidate to implement
 * but omits the `[->coding]` phase token (otherwise the UI stays locked in planning).
 */

function stripPhaseTokens(raw: string): string {
  return raw
    .replace(/\[->planning\]\n?/gi, "")
    .replace(/\[->coding\]\n?/gi, "")
    .trim();
}

const PLANNING_CONTINUE_HINT = new RegExp(
  [
    String.raw`\bdon'?t\s+(?:start\s+)?(?:code|implement)`,
    String.raw`\bdo\s+not\s+(?:start\s+)?(?:code|implement)`,
    String.raw`\bbefore\s+you\s+(?:start\s+)?(?:coding|implement)`,
    String.raw`\bhold\s+off\b[^.?!\n]{0,70}\b(?:code|implement)`,
    String.raw`\bnot\s+(?:quite\s+)?(?:ready\b[^.?!\n]{0,120}\b(?:code|implement)|yet\b)`,
    String.raw`\blet'?s\s+stay\b`,
    String.raw`\bstay\s+on\s+(?:the\s+)?interview\b`,
    String.raw`\bkeep\s+discussing\b`,
    String.raw`\bstill\s+(?:want|need)\s+[^.?!\n]{0,40}\bdetails\b`,
  ].join("|"),
  "i"
);

/** Text immediately after “go ahead” (single assistant segment, lowercased + compact spacing). */
function tailAfterGoAhead(compactLower: string): string | null {
  const m = /\bgo\s+ahead\b/i.exec(compactLower);
  if (!m || m.index === undefined) {
    return null;
  }
  return compactLower.slice(m.index + m[0].length);
}

/**
 * “Go ahead…” only counts if the same breath clearly releases them to code,
 * not when it leads into another planning probe (“explain how you’d implement…”).
 */
function goAheadMeansCode(compactLower: string): boolean {
  const tail = tailAfterGoAhead(compactLower);
  if (!tail) {
    return false;
  }
  const t = tail.replace(/^\s*([.!?,;:–—\-]+\s*)+/, "");
  const stillPlanningLead =
    /^(?:can\s+you|could\s+you|would\s+you|can\s+we|could\s+we)\b/i.test(t) ||
    /^(?:how\b|tell\s+me|walk\s+me|explain|describe|sketch)\b/i.test(t) ||
    /^(?:but|however|first|before|let'?s)\b/i.test(t) ||
    /\bexplain\b[^\n.?]{0,120}\bimplement\b/i.test(t.slice(0, 220));

  if (stillPlanningLead) {
    return false;
  }

  const invitesCode =
    /\bcod(?:e|ing)\b/.test(t) ||
    /\b(?:start|begin)\s+(?:coding|implementing)\b/i.test(t) ||
    /\bcod(?:e|ing)\s+(?:that|it)\s+up\b/i.test(t) ||
    /^,?(\s+|\band\s+)implement\b/i.test(t);

  return invitesCode;
}

export function assistantInvitesCodingWithoutToken(raw: string): boolean {
  const stripped = stripPhaseTokens(raw);
  if (!stripped.length) {
    return false;
  }

  const compact = stripped.toLowerCase().replace(/\s+/g, " ");

  if (PLANNING_CONTINUE_HINT.test(compact)) {
    return false;
  }

  if (goAheadMeansCode(compact)) {
    return true;
  }

  const positive = [
    /\bcod(?:e|ing)\s+that\s+up\b/i,
    /\bcod(?:e|ing)\s+it\s+up\b/i,
    /\b(?:start|begin)\s+(?:coding|implementing)\b/i,
    /\btime\s+to\s+(?:code|implement)\b/i,
    /\bimplement\s+(?:that|your|this)\s+approach\b/i,
    /\bwould\s+(?:love|like)\s+to\s+see\s+(?:your\s+)?(?:code|implementation)\b/i,
    /\bopen\s+(?:the\s+)?editor\b/i,
    /\b(?:start|switch)\s+to\s+(?:your\s+)?(?:code|the\s+editor)\b/i,
  ];

  return positive.some((re) => re.test(compact));
}
