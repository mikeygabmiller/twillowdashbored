// REFLECTION FORMS — the shape of the day's reflection, rotated like the
// prayers are.
//
// Why this exists: "write 4 to 6 sentences of reflection" is a length, not a
// shape, and a model given only a length writes the same paragraph every day —
// observation, gentle pivot, uplift. Naming the shape, and changing which
// shape is asked for, is the single biggest lever on variety. Rotation is
// deterministic by date (lib/rotation.js), so a preview shows what that date
// would really get.
//
// Only TWO openings are permitted, both chosen by the owner (blueprint.html):
// the reasonable objection a reader would raise, and straight into what
// happens in the Gospel. Three earlier forms opened otherwise — a scene from
// working life, a flat fact about the season, the long unglamorous middle —
// and have been retired rather than quietly bent to fit.
//
// Each form carries one EXEMPLAR in the house voice, about a day other than
// today. Few-shot is what holds the register steady; the model imitates the
// exemplar's texture without being able to copy its content.
//
// THE EXEMPLARS ARE THE PRODUCT. If the writing drifts, fix them here before
// touching anything in lib/. Every one of them: third person far more than
// second, ordinary imagery rather than trade imagery, a written rather than a
// spoken register, and a close that turns to the reader with something to do.

export const FORMS = [
  {
    id: 'objection',
    name: 'The objection',
    tags: ['ordinary time', 'daily'],
    brief:
      'Open with the reasonable objection this reader would raise — the honest "what has this got to do with me", stated fairly and without irony. Then answer it, without pretending the objection was stupid.',
    exemplar: `A fourth-century martyr is easy to admire and easy to file away. Dying for the faith is not on anybody's list this week, and a man who has to be at work by six can be forgiven for reading past him. But what got him killed was not a grand moment. It was a small refusal, made once and then made again, until somebody with power noticed. Most men will get that same chance before lunch, in a room where agreeing would cost nothing and would also be a lie.

Reflect today on the one place where agreement is expected of you and would not be true.`,
  },
  {
    id: 'gospel-first',
    name: 'Straight into the Gospel',
    tags: ['daily', 'ordinary time', 'feast'],
    brief:
      'Open inside what actually happens in the passage — a person, an action, a refusal — with no preamble at all. Stay with the account for three or four sentences before anything is drawn from it. You have the Douay-Rheims text; use what is in it and nothing else.',
    exemplar: `He puts them in the boat and sends them ahead, and then he goes up the mountain by himself. The wind is against them for most of the night, and he comes in the fourth watch — the coldest and latest part of it — walking on top of the thing that has been beating them for hours. They do not recognise him. They think he is a ghost, and they cry out in fear at the one thing in that whole night that is on their side.

Reflect today on what you have been bracing against, and on the possibility that it is not what you have taken it for.`,
  },
  {
    id: 'three-angles',
    name: 'Three angles',
    tags: ['feast', 'daily', 'ordinary time'],
    brief:
      'Go at one passage three times, from three genuinely different positions — who is present and why, what it cost somebody, what it quietly says about God. One or two sentences per angle. Do not announce that you are doing this, do not number them, and do not resolve them into a single tidy point.',
    exemplar: `Only three of them go up, and they are the same three he will want beside him later, on a much worse night. What they see is not a different man; it is the one they have followed for months, with the covering off for a few minutes.

The two standing with him had each met God on a mountain, and neither had seen this. Everything they spent their lives pointing toward is in front of them now with a face.

Then the three go down on the ground, and it is not the fear of men expecting punishment. It is what happens to anyone who ends up in front of what does not begin or end. He tells them to get up and stop being afraid. He does not tell them to stop being amazed.

Reflect today on the thing about God you understand least, and sit with it for five minutes without trying to solve it.`,
  },
  {
    id: 'hard-saying',
    name: 'The hard saying',
    tags: ['lent', 'advent', 'daily'],
    brief:
      'Name the uncomfortable thing in the passage plainly and refuse to soften it. Do not resolve it into reassurance. This reader is not fragile and will know at once when he is being handled.',
    exemplar: `The line about counting the cost before you start is one most men read quickly. It is meant to be read slowly. We would rather hear that God takes us as we are, which is true, and then stop there, which is not. The Church has never pretended the part that follows is cheap, and every name on the calendar paid for it somewhere public.

Reflect today on the one honest conversation you have been putting off because you have already worked out what it will cost.`,
  },
  {
    id: 'cost',
    name: 'The cost',
    tags: ['lent', 'advent', 'feast', 'daily'],
    brief:
      'Open by naming the version of today that costs the reader nothing — accurately, without sneering — then say what the day is actually asking. Close by making him choose the expensive one. This is the form permitted to be slightly confrontational.',
    exemplar: `There is a version of any feast that costs nothing. A man reads about it, feels briefly warmer, and goes to work. The Church is not offering that version. Keeping a day means letting it interrupt something — five minutes that were going to go on a phone, or an apology that has been rehearsed for a week and never delivered. One of those is genuinely more expensive than the other.

Reflect today on which of the two you have been avoiding, and then do that one.`,
  },
];

export const FORM_BY_ID = Object.fromEntries(FORMS.map((f) => [f.id, f]));

// The saint block is narrative, so it gets an exemplar of its own rather than
// a rotating set. Note what it does NOT do: no invented dates, no invented
// places, no quotations, no legend told as fact. It builds a scene out of the
// shape of a life, which is all the fact sheet can support.
export const SAINT_EXEMPLAR = {
  life: `He was a bishop during a stretch when the office meant being available to people who had lost everything, and there is no record of him trying to get out of it. It was not a promotion. It was a rota of funerals, arguments about money, and other men's disasters arriving at the door in no particular order.

What is worth knowing is that he kept at it into old age, after the interesting part was over and the admiration had worn off. That is the part nobody paints.`,
  oneActionToday: `Answer the message from the man you have been putting off — the one whose problem you cannot fix — before you eat tonight.`,
};

// Headlines drift into slogans faster than anything else in the issue, so they
// get exemplars too. All lower case, no colon, nothing that could be a poster.
export const HEADLINE_EXEMPLARS = [
  'the part nobody paints',
  'a small refusal, repeated',
  'what the day is actually asking',
  'they cried out at the only help there was',
  'he does not tell them to stop being amazed',
  'you have already worked out what it costs',
];
