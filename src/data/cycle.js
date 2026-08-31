// Cycle phases and supportive guidance for men.
// Advice is framed as "how to understand and support her" — never diagnostic,
// never a way to dismiss her feelings.
export const CYCLE_PHASES = {
  Menstrual: {
    range: "Days 1-5",
    summary: "Her period. Energy and hormones are at their lowest.",
    advice: [
      "She may feel tired or need more rest — offer comfort, not pressure.",
      "Small practical help (warmth, food, a quiet evening) goes a long way.",
      "Be patient and low-key. This isn't the week for heavy confrontations.",
    ],
  },
  Follicular: {
    range: "Days 6-13",
    summary: "Estrogen rises. Energy, mood, and openness often increase.",
    advice: [
      "Often a great time for plans, dates, and new ideas.",
      "She may feel more social and optimistic — meet that energy.",
      "A good window for lighthearted connection and trying things together.",
    ],
  },
  Ovulation: {
    range: "Around day 14",
    summary: "Peak estrogen. Often the most energetic and confident phase.",
    advice: [
      "Connection and attraction may feel strongest — be present and engaged.",
      "Good time for meaningful conversations and quality time.",
      "Show appreciation; warmth is easily received now.",
    ],
  },
  Luteal: {
    range: "Days 15-28",
    summary: "Progesterone rises then drops. Sensitivity may increase (PMS).",
    advice: [
      "Patience and reassurance matter most now.",
      "Avoid heavy arguments; if tension rises, stay calm and give space.",
      "Extra kindness and understanding help her feel supported.",
    ],
  },
};

// Estimate cycle day and phase from last period date and cycle length.
export function computePhase(lastPeriodISO, cycleLength = 28, todayISO) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const last = new Date(lastPeriodISO);
  const today = todayISO ? new Date(todayISO) : new Date();
  // Normalize to midnight to avoid off-by-one from time-of-day.
  last.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const len = Math.max(20, Math.min(45, Number(cycleLength) || 28));
  const diffDays = Math.floor((today - last) / MS_PER_DAY);
  if (isNaN(diffDays) || diffDays < 0) return null;
  const dayOfCycle = (diffDays % len) + 1; // 1-based
  const ovulation = len - 14; // estimated ovulation day

  let phase;
  if (dayOfCycle <= 5) phase = "Menstrual";
  else if (dayOfCycle >= ovulation && dayOfCycle <= ovulation + 1) phase = "Ovulation";
  else if (dayOfCycle < ovulation) phase = "Follicular";
  else phase = "Luteal";

  return { dayOfCycle, phase, cycleLength: len };
}
